/**
 * lib/smsProvider.js
 *
 * SmsProvider abstraction — the SMS equivalent of lib/emailProvider.js,
 * same shape on purpose (`init`, `send`, `getProviderName`) so the rest of
 * the app treats "send an SMS" exactly like "send an email": one gateway,
 * runtime-selected transport, credentials read only from env, THROWS on
 * failure so the queue layer (lib/smsQueue.js) is the only place that
 * catches/retries/logs.
 *
 * IMPORTANT — inspected first: this project has NO existing Twilio/SMS
 * integration anywhere (grepped the whole codebase; the only prior "SMS" is
 * a `console.log` placeholder for the driver OTP flow, with a comment
 * saying no gateway is configured). So this file — plus smsQueue.js and the
 * SmsLog model in lib/opsModels.js — is new infrastructure, built to match
 * the EXACT pattern the existing (already-working) email system uses,
 * rather than inventing a different shape. No new npm dependency is added:
 * Twilio's REST API is called directly with the built-in fetch(), the same
 * way lib/emailProvider.js already calls Resend/SendGrid without their SDKs.
 *
 * Providers:
 *   - 'twilio'  — real delivery. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *                 and TWILIO_FROM_NUMBER (or TWILIO_MESSAGING_SERVICE_SID).
 *   - 'console' — dev fallback (default when Twilio isn't configured): logs
 *                 the message server-side, never claims it was delivered.
 *
 * Credentials are read from process.env only — never accepted from a
 * request body, never sent to the frontend, never logged.
 */

let providerName = 'console';
let fromNumber = '';
let messagingServiceSid = '';
let accountSid = '';
let authToken = '';

/** Called once from server_load.js at startup, mirroring emailProvider.init(). */
function init({ providerNameOverride } = {}) {
  accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  authToken = process.env.TWILIO_AUTH_TOKEN || '';
  fromNumber = process.env.TWILIO_FROM_NUMBER || '';
  messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || '';
  const requested = (providerNameOverride || process.env.SMS_PROVIDER || '').trim().toLowerCase();
  const twilioReady = !!(accountSid && authToken && (fromNumber || messagingServiceSid));
  providerName = requested || (twilioReady ? 'twilio' : 'console');
}

function isConfigured() {
  return providerName === 'twilio' && !!accountSid && !!authToken && !!(fromNumber || messagingServiceSid);
}

function getProviderName() {
  return providerName;
}

async function sendViaTwilio({ to, body }) {
  if (!accountSid || !authToken) throw new Error('SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN are not set.');
  if (!fromNumber && !messagingServiceSid) throw new Error('SMS_PROVIDER=twilio but neither TWILIO_FROM_NUMBER nor TWILIO_MESSAGING_SERVICE_SID is set.');
  const params = new URLSearchParams();
  params.set('To', to);
  params.set('Body', body);
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
  else params.set('From', fromNumber);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (data && data.message) || `Twilio API error (HTTP ${resp.status})`;
    throw new Error(msg);
  }
  return { messageId: data.sid || '', status: data.status || '' };
}

async function sendViaConsole({ to, body }) {
  console.log(`\n[DEV SMS — no SMS_PROVIDER configured] To: ${to}\n${body}\n`);
  return { messageId: 'dev-console', status: 'logged_only' };
}

/** Low-level single send. Throws on any failure — callers must catch/retry (see lib/smsQueue.js). */
async function send({ to, body }) {
  const cleanTo = String(to || '').trim();
  if (!cleanTo) throw new Error('No recipient phone number supplied.');
  if (!body) throw new Error('No message body supplied.');
  switch (providerName) {
    case 'twilio': return sendViaTwilio({ to: cleanTo, body });
    case 'console': default: return sendViaConsole({ to: cleanTo, body });
  }
}

module.exports = { init, send, isConfigured, getProviderName };
