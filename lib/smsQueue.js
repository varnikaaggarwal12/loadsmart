/**
 * lib/smsQueue.js
 *
 * SMS QUEUE + WORKER — the exact same architecture as lib/emailQueue.js
 * (API -> Database Transaction -> Domain Event -> enqueue() -> in-process
 * worker -> smsProvider -> recipient), so the two notification channels
 * behave identically and an engineer who understands one understands both.
 * No external queue infra (Redis/BullMQ) is present in this project (see
 * package.json — checked before writing this), so this is an in-process
 * async queue + a single always-running worker loop, same as email.
 *
 * Guarantees:
 *   - Idempotency: eventType + entityId + recipient is a unique DB index
 *     (SmsLog.idempotencyKey) — a duplicate enqueue() is detected and
 *     skipped, never sent twice.
 *   - Retry with backoff, same schedule as email: up to MAX_ATTEMPTS.
 *   - Never throws into the caller — `smsQueue.enqueue(...).catch(()=>{})`
 *     is always safe. A Twilio failure NEVER rolls back or blocks whatever
 *     database transaction triggered it — the SmsLog row simply ends up
 *     FAILED and is visible in the admin log.
 */
const { SmsLog } = require('./opsModels');
const provider = require('./smsProvider');

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [2000, 8000];

const queue = [];
let draining = false;

function buildIdempotencyKey(eventType, entityId, recipientPhone) {
  return `${eventType || 'UNKNOWN'}::${entityId || 'n/a'}::${String(recipientPhone || '').trim()}`;
}

/**
 * Enqueue one SMS. Writes (or reuses) its SmsLog row synchronously — same
 * idempotency-first pattern as emailQueue.enqueue — then hands the job to
 * the in-memory worker.
 */
async function enqueue({ to, body, eventType, entityType = '', entityId = '', userId = '', userRole = '' }) {
  if (!to) {
    console.log(`[SMS SKIPPED — no phone number on file] ${eventType} (${entityId || 'n/a'})`);
    return { queued: false, reason: 'no_recipient' };
  }
  const idempotencyKey = buildIdempotencyKey(eventType, entityId, to);

  const existing = await SmsLog.findOne({ idempotencyKey }).lean().catch(() => null);
  if (existing && ['SENT', 'PENDING', 'PROCESSING', 'RETRYING'].includes(existing.status)) {
    console.log(`[SMS DEDUPED] ${idempotencyKey} is already ${existing.status} — not sending again.`);
    return { queued: false, reason: 'duplicate', status: existing.status };
  }

  let logDoc;
  try {
    if (existing) {
      logDoc = await SmsLog.findOneAndUpdate(
        { idempotencyKey },
        { status: 'PENDING', attempts: 0, errorMessage: '', body, recipient: to },
        { new: true }
      );
    } else {
      logDoc = await SmsLog.create({
        idempotencyKey, recipient: to, eventType, entityType, entityId, userId, userRole,
        body, status: 'PENDING', attempts: 0, createdAt: new Date(),
      });
    }
  } catch (err) {
    if (err.code === 11000) {
      console.log(`[SMS DEDUPED — race] ${idempotencyKey}`);
      return { queued: false, reason: 'duplicate' };
    }
    console.error('smsQueue.enqueue: failed to write SmsLog row:', err.message);
    return { queued: false, reason: 'log_write_failed', error: err.message };
  }

  queue.push({ logId: logDoc._id, to, body, eventType });
  drain(); // fire-and-forget — never make the caller wait on actual delivery
  return { queued: true, id: String(logDoc._id) };
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      await processJob(job);
    }
  } finally {
    draining = false;
  }
}

async function processJob(job, attempt = 1) {
  try {
    await SmsLog.findByIdAndUpdate(job.logId, { status: 'PROCESSING', attempts: attempt });
    const result = await provider.send({ to: job.to, body: job.body });
    await SmsLog.findByIdAndUpdate(job.logId, {
      status: 'SENT', providerMessageId: result.messageId || '', sentAt: new Date(), errorMessage: '',
    });
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      await SmsLog.findByIdAndUpdate(job.logId, { status: 'RETRYING', attempts: attempt, errorMessage: err.message });
      const delay = RETRY_DELAY_MS[attempt - 1] || 8000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return processJob(job, attempt + 1);
    }
    await SmsLog.findByIdAndUpdate(job.logId, { status: 'FAILED', attempts: attempt, errorMessage: err.message });
    console.error(`smsQueue: SMS FAILED after ${attempt} attempt(s) [${job.eventType}] to ${job.to}:`, err.message);
  }
}

/** Test/diagnostic helper — lets a unit test wait for the queue to fully drain instead of guessing at a timeout. */
async function waitForDrain() {
  while (draining || queue.length) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

module.exports = { enqueue, buildIdempotencyKey, waitForDrain, MAX_ATTEMPTS };
