/**
 * lib/emailQueue.js
 *
 * Email QUEUE + WORKER (spec architecture: "API -> Database Transaction ->
 * Domain Event -> Notification Service -> Email Queue -> Email Worker ->
 * Email Provider -> Recipient"). No external queue infrastructure (Redis/
 * SQS/Bull) is available in this environment, so this is an in-process
 * async queue + a single always-running worker loop — same idea, same
 * failure-isolation guarantees, just without a second process. Every call
 * site (lib/emailService.js) already treats sending as fire-and-forget/
 * awaited-but-never-throwing, so an API request is never blocked waiting
 * for an email to actually leave the building — `enqueue()` returns as
 * soon as the EmailLog row is written, and the worker delivers it after.
 *
 * Guarantees this module provides:
 *   - Idempotency: `eventType + entityId + recipient` is a unique DB index
 *     (EmailLog.idempotencyKey). A second enqueue() for the exact same
 *     event/entity/recipient — from a page refresh, a retried API call, a
 *     re-run of the matching loop, or a worker restart mid-flight — is
 *     detected and skipped rather than sent twice.
 *   - Retry with backoff: a provider failure is retried up to
 *     MAX_ATTEMPTS times (status cycles PENDING -> PROCESSING -> RETRYING
 *     -> ... -> SENT or FAILED) before being left as FAILED for a human to
 *     retry from the Admin Email Log.
 *   - Never throws into the caller — a caller can always
 *     `emailQueue.enqueue(...).catch(()=>{})`, or just not await it,
 *     without risking whatever database transaction triggered it.
 */
const { EmailLog } = require('./opsModels');
const provider = require('./emailProvider');

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [2000, 8000]; // delay before attempt 2, before attempt 3

const queue = [];
let draining = false;

/** The exact key the spec asks for: eventType + entityId + recipientId. */
function buildIdempotencyKey(eventType, entityId, recipientEmail) {
  return `${eventType || 'UNKNOWN'}::${entityId || 'n/a'}::${String(recipientEmail || '').trim().toLowerCase()}`;
}

/**
 * Enqueue one email. Writes (or reuses) its EmailLog row synchronously —
 * so the idempotency check and the "PENDING" audit trail are guaranteed to
 * exist even if the process restarts before the worker gets to it — then
 * hands the job to the in-memory worker queue.
 */
async function enqueue({ to, subject, html, text, eventType, entityType = '', entityId = '', userId = '', userRole = '' }) {
  if (!to) {
    console.log(`[EMAIL SKIPPED — no recipient address on file] ${eventType} (${entityId || 'n/a'})`);
    return { queued: false, reason: 'no_recipient' };
  }
  const idempotencyKey = buildIdempotencyKey(eventType, entityId, to);

  const existing = await EmailLog.findOne({ idempotencyKey }).lean().catch(() => null);
  if (existing && ['SENT', 'PENDING', 'PROCESSING', 'RETRYING'].includes(existing.status)) {
    console.log(`[EMAIL DEDUPED] ${idempotencyKey} is already ${existing.status} — not sending again.`);
    return { queued: false, reason: 'duplicate', status: existing.status };
  }

  let logDoc;
  try {
    if (existing) {
      // Previous attempt(s) ended FAILED — reuse the same row (same
      // idempotency key, same audit history) rather than creating a
      // parallel one, and reset it for a fresh attempt.
      logDoc = await EmailLog.findOneAndUpdate(
        { idempotencyKey },
        { status: 'PENDING', attempts: 0, errorMessage: '', error: '', subject, html, text, recipient: to, email: to },
        { new: true }
      );
    } else {
      logDoc = await EmailLog.create({
        idempotencyKey, recipient: to, email: to,
        event: eventType, eventType,
        entityType, entityId,
        loadId: entityType === 'Load' || !entityType ? entityId : '',
        userId, userRole,
        subject, html, text,
        status: 'PENDING', attempts: 0, createdAt: new Date(),
      });
    }
  } catch (err) {
    // Most likely a unique-index race on idempotencyKey — another request
    // enqueued the exact same event/entity/recipient a moment ago. Treat
    // it the same as a detected duplicate rather than as a hard failure.
    if (err.code === 11000) {
      console.log(`[EMAIL DEDUPED — race] ${idempotencyKey}`);
      return { queued: false, reason: 'duplicate' };
    }
    console.error('emailQueue.enqueue: failed to write EmailLog row:', err.message);
    return { queued: false, reason: 'log_write_failed', error: err.message };
  }

  queue.push({ logId: logDoc._id, to, subject, html, text, eventType });
  drain(); // fire-and-forget — do not make the caller wait on delivery
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
    await EmailLog.findByIdAndUpdate(job.logId, { status: 'PROCESSING', attempts: attempt });
    const result = await provider.send({ to: job.to, subject: job.subject, html: job.html, text: job.text });
    await EmailLog.findByIdAndUpdate(job.logId, {
      status: 'SENT', providerMessageId: result.messageId || '', sentAt: new Date(), errorMessage: '', error: '',
    });
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      await EmailLog.findByIdAndUpdate(job.logId, { status: 'RETRYING', attempts: attempt, errorMessage: err.message, error: err.message });
      const delay = RETRY_DELAY_MS[attempt - 1] || 8000;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return processJob(job, attempt + 1);
    }
    await EmailLog.findByIdAndUpdate(job.logId, { status: 'FAILED', attempts: attempt, errorMessage: err.message, error: err.message });
    console.error(`emailQueue: email FAILED after ${attempt} attempt(s) [${job.eventType}] to ${job.to}:`, err.message);
  }
}

/** Admin "Retry" button (spec section 16) — re-enqueue one FAILED row by
 * its EmailLog _id, reusing the exact body that was originally rendered. */
async function retry(logId) {
  const logDoc = await EmailLog.findById(logId);
  if (!logDoc) return { ok: false, error: 'Email log entry not found.' };
  if (logDoc.status !== 'FAILED') {
    return { ok: false, error: `Only FAILED emails can be retried (this one is currently ${logDoc.status}).` };
  }
  logDoc.status = 'PENDING';
  logDoc.attempts = 0;
  logDoc.errorMessage = '';
  logDoc.error = '';
  await logDoc.save();
  queue.push({ logId: logDoc._id, to: logDoc.email || logDoc.recipient, subject: logDoc.subject, html: logDoc.html || '', text: logDoc.text || '', eventType: logDoc.eventType || logDoc.event });
  drain();
  return { ok: true };
}

/** Test/diagnostic helper — lets a unit test wait for the queue to fully
 * drain instead of guessing at a timeout. Not used by production code
 * paths (which are intentionally fire-and-forget). */
async function waitForDrain() {
  while (draining || queue.length) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

module.exports = { enqueue, retry, buildIdempotencyKey, waitForDrain, MAX_ATTEMPTS };
