/**
 * lib/emailProvider.js
 *
 * EmailProvider abstraction (spec: "create a clean EmailProvider
 * abstraction"). One `send()`/`sendTemplate()`/`sendBulk()` surface, with
 * the actual transport picked at runtime by `EMAIL_PROVIDER` in `.env` —
 * `smtp` (reuses the app's existing nodemailer transporter), `resend`,
 * `sendgrid`, `ses`, or `console` (dev fallback, no external call). No
 * credentials are ever hard-coded here — every adapter reads its own env
 * vars (`EMAIL_API_KEY` or a provider-specific override) at send time.
 *
 * `send()` THROWS on failure on purpose — lib/emailQueue.js is the layer
 * that catches that, records it, and retries. This module never retries
 * and never swallows an error itself, so its behavior stays simple and
 * predictable no matter which provider is behind it.
 */

let smtpTransporter = null;
let fromEmail = '';
let providerName = 'console';

/**
 * Called once from server_load.js at startup, right after the existing
 * nodemailer transporter is built — same wiring point emailService.init()
 * already used, just handed one level lower now.
 */
function init({ transporter, from, providerNameOverride } = {}) {
  smtpTransporter = transporter || null;
  fromEmail = from || process.env.EMAIL_FROM || process.env.MAIL_FROM || process.env.SMTP_USER || '';
  const requested = (providerNameOverride || process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  // No explicit EMAIL_PROVIDER set: fall back to whatever the app already
  // has configured (SMTP, if a transporter was handed in) rather than
  // silently going to console-only mode on an otherwise-working setup.
  providerName = requested || (smtpTransporter ? 'smtp' : 'console');
}

function getProviderName() {
  return providerName;
}

async function sendViaSmtp({ to, subject, html, text }) {
  if (!smtpTransporter) throw new Error('EMAIL_PROVIDER=smtp but SMTP is not configured (missing SMTP_HOST/SMTP_USER/SMTP_PASS).');
  const info = await smtpTransporter.sendMail({ from: fromEmail, to, subject, html, text });
  return { messageId: (info && info.messageId) || '' };
}

async function sendViaResend({ to, subject, html, text }) {
  const apiKey = process.env.EMAIL_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('EMAIL_PROVIDER=resend but EMAIL_API_KEY is not set.');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromEmail, to: [to], subject, html, text }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((data && (data.message || data.error)) || `Resend API error (HTTP ${resp.status})`);
  return { messageId: data.id || '' };
}

async function sendViaSendgrid({ to, subject, html, text }) {
  const apiKey = process.env.EMAIL_API_KEY || process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('EMAIL_PROVIDER=sendgrid but EMAIL_API_KEY is not set.');
  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail },
      subject,
      content: [text ? { type: 'text/plain', value: text } : null, html ? { type: 'text/html', value: html } : null].filter(Boolean),
    }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error((data && data.errors && data.errors[0] && data.errors[0].message) || `SendGrid API error (HTTP ${resp.status})`);
  }
  return { messageId: resp.headers.get('x-message-id') || '' };
}

// Amazon SES's API needs AWS SigV4 request signing to call safely and
// correctly — that's not something to hand-roll inline here (easy to get
// subtly wrong on a security-sensitive path). This adapter is a clearly
// marked extension point: `npm install @aws-sdk/client-sesv2`, then
// implement the send call below using SES_REGION/AWS credentials from env.
// Selecting EMAIL_PROVIDER=ses without that fails loudly, on purpose,
// rather than silently dropping mail.
async function sendViaSes() {
  throw new Error('EMAIL_PROVIDER=ses is selected but not wired up yet — install @aws-sdk/client-sesv2 and implement sendViaSes() in lib/emailProvider.js.');
}

async function sendViaConsole({ to, subject, text }) {
  console.log(`\n[DEV EMAIL — no EMAIL_PROVIDER configured] To: ${to}\nSubject: ${subject}\n${text || '(HTML-only body)'}\n`);
  return { messageId: 'dev-console' };
}

/** Low-level single send. Throws on any failure — callers must catch/retry. */
async function send({ to, subject, html, text }) {
  if (!to) throw new Error('No recipient email address supplied.');
  if (!subject) throw new Error('No subject supplied.');
  switch (providerName) {
    case 'smtp': return sendViaSmtp({ to, subject, html, text });
    case 'resend': return sendViaResend({ to, subject, html, text });
    case 'sendgrid': return sendViaSendgrid({ to, subject, html, text });
    case 'ses': return sendViaSes({ to, subject, html, text });
    case 'console': default: return sendViaConsole({ to, subject, html, text });
  }
}

/** sendTemplate — same as send(), kept as its own named method so the
 * provider surface matches the spec exactly (`send`, `sendTemplate`,
 * `sendBulk`) and so a provider with native template support (e.g. a
 * Resend/SendGrid dynamic template ID) has an obvious place to plug in
 * later without changing every call site. */
async function sendTemplate({ to, subject, templateHtml, templateText }) {
  return send({ to, subject, html: templateHtml, text: templateText });
}

/** sendBulk — same message to many recipients, sequential and isolated so
 * one bad address never aborts the rest of the batch. */
async function sendBulk(recipients, { subject, html, text }) {
  const results = [];
  for (const to of recipients || []) {
    try {
      const r = await send({ to, subject, html, text });
      results.push({ to, ok: true, messageId: r.messageId });
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { init, send, sendTemplate, sendBulk, getProviderName };
