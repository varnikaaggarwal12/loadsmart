/**
 * lib/emailTemplates.js
 *
 * EmailTemplateService — one branded, responsive HTML shell every
 * LoadSmart notification email is rendered through, plus a matching
 * plain-text fallback (still shown by many clients, and good for
 * deliverability). Table-based layout with inline styles only — nothing
 * structural depends on a <style> block — so it survives the aggressive
 * CSS-stripping Gmail/Outlook/Apple Mail all do in different ways.
 *
 * SECURITY: this is the one place every outgoing email body is built, so
 * it's also the one place that guarantees the platform-wide rule "never
 * put a password, OTP, full Aadhaar/PAN number, bank credential, or auth
 * token in an email body" — callers pass field label/value pairs, and
 * nothing here ever reads those kinds of fields off a user record. CTA
 * links are built exclusively by `appLink()` below, which only accepts an
 * in-app path (never a caller-supplied full URL and never a query string
 * containing a session token), so a link can't be hijacked off-site or
 * leak a credential in the URL.
 */

const BRAND = {
  name: 'LoadSmart',
  color: '#1f7a3f',
  accent: '#e8722c',
  supportEmail: process.env.SUPPORT_EMAIL || process.env.NOTIFY_TO_EMAIL || 'support@loadsmart.in',
  // Set APP_BASE_URL in .env (e.g. https://app.loadsmart.in) so CTA links
  // in emails are absolute. Without it, links fall back to relative paths
  // (correct when opened from a browser already on the site, but a real
  // deployment should set this).
  baseUrl: (process.env.APP_BASE_URL || '').trim(),
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Builds a safe link to a page INSIDE this app. Never accepts an
 * arbitrary/external URL and never appends auth tokens — the page itself
 * is responsible for prompting login (spec: CTA must "go to load detail
 * page after auth" and "should not contain sensitive information"). */
function appLink(pathAndQuery) {
  const path = String(pathAndQuery || '/').replace(/^(?!\/)/, '/');
  return BRAND.baseUrl ? `${BRAND.baseUrl.replace(/\/+$/, '')}${path}` : path;
}

/** Masks a vehicle number for display to someone OTHER than its owning
 * carrier (spec section 3: "mask sensitive info if needed"). Carrier's own
 * emails about their own truck should pass the full value instead. */
function maskVehicleNumber(v) {
  const s = String(v || '').trim();
  if (s.length <= 4) return s;
  return `${s.slice(0, 2)}••••${s.slice(-4)}`;
}

/**
 * @param {{
 *   title: string, preheader?: string, intro?: string,
 *   fields?: Array<[string, string|number]>, statusLabel?: string,
 *   ctaLabel?: string, ctaUrl?: string, footerNote?: string,
 * }} opts
 * @returns {{html: string, text: string}}
 */
function render({ title, preheader = '', intro = '', fields = [], statusLabel = '', ctaLabel = '', ctaUrl = '', footerNote = '' }) {
  const cleanFields = (fields || []).filter((f) => f && f[1] !== undefined && f[1] !== null && String(f[1]).trim() !== '');

  const rows = cleanFields.map(([label, value]) => `
      <tr>
        <td style="padding:8px 0;color:#5a6b63;font-size:13px;width:42%;vertical-align:top;border-bottom:1px solid #f2f5f3;">${escapeHtml(label)}</td>
        <td style="padding:8px 0;color:#16241c;font-size:14px;font-weight:600;vertical-align:top;border-bottom:1px solid #f2f5f3;">${escapeHtml(value)}</td>
      </tr>`).join('');

  const statusHtml = statusLabel
    ? `<span style="display:inline-block;background:#eaf7ee;color:${BRAND.color};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:6px 14px;border-radius:999px;margin-bottom:14px;">${escapeHtml(statusLabel)}</span><br/>`
    : '';

  const ctaHtml = ctaLabel && ctaUrl
    ? `<tr><td style="padding:26px 0 4px;">
         <a href="${escapeHtml(ctaUrl)}" style="background:${BRAND.color};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 30px;border-radius:8px;display:inline-block;">${escapeHtml(ctaLabel)}</a>
       </td></tr>`
    : '';

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f2f5f3;font-family:Arial,Helvetica,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f3;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6ece8;">
  <tr><td style="background:${BRAND.color};padding:20px 28px;">
    <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:.02em;font-family:Arial,sans-serif;">${BRAND.name}</span>
  </td></tr>
  <tr><td style="padding:28px 28px 8px;">
    ${statusHtml}
    <h1 style="margin:0 0 10px;font-size:19px;line-height:1.3;color:#16241c;font-family:Arial,sans-serif;">${escapeHtml(title)}</h1>
    ${intro ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#3c4a43;">${escapeHtml(intro)}</p>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${rows}
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${ctaHtml}</table>
  </td></tr>
  <tr><td style="padding:18px 28px 26px;border-top:1px solid #f2f5f3;">
    ${footerNote ? `<p style="margin:14px 0 12px;font-size:12px;color:#8a978f;">${escapeHtml(footerNote)}</p>` : '<div style="margin-top:14px;"></div>'}
    <p style="margin:0;font-size:12px;color:#8a978f;">Need help? Contact us at <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.color};">${BRAND.supportEmail}</a>.</p>
    <p style="margin:8px 0 0;font-size:11px;color:#b3bdb7;">You're receiving this because of activity on your LoadSmart account. Manage what you get notified about from your account's notification preferences.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    title,
    intro,
    '',
    ...cleanFields.map(([label, value]) => `${label}: ${value}`),
    ctaLabel && ctaUrl ? `\n${ctaLabel}: ${ctaUrl}` : '',
    footerNote ? `\n${footerNote}` : '',
    `\nNeed help? Contact us at ${BRAND.supportEmail}.`,
  ].filter((l) => l !== '' && l !== undefined).join('\n');

  return { html, text };
}

module.exports = { render, appLink, escapeHtml, maskVehicleNumber, BRAND };
