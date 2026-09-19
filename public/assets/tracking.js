/**
 * tracking.js
 * Load Smart — Cookie Consent popup + User Flow activity tracking client.
 *
 * Include this on every public/portal page (before the page's own script):
 *   <script src="/assets/tracking.js"></script>
 *
 * What it does automatically, with no per-page wiring required:
 *   1. Shows a cookie-consent popup (Allow / Deny / Close-X) once per
 *      browser, the first time no consent decision has been recorded yet.
 *   2. Records a WEBSITE_VISIT event once per session, and every consent
 *      decision (ALLOW/DENY/CLOSE) — these are recorded unconditionally,
 *      since a person's own consent choice must never be lost, and a bare
 *      "someone visited" event is not the kind of non-essential analytics
 *      Deny/Close is meant to block.
 *   3. Records a PAGE_VIEW event on every page load — but ONLY once the
 *      person has clicked Allow. Deny/Close/no-decision-yet means no
 *      page-view or in-app action tracking happens at all.
 *
 * Exposes window.LS.Track for page-specific scripts to log named,
 * meaningful actions (login success, registration completed, etc.):
 *   LS.Track.log('LOGIN_SUCCESS', 'LOGIN', { role: 'shipper' })
 * — always safe to call; it silently no-ops unless consent is ALLOW.
 */
(function () {
  const LS = window.LS || {};

  const CONSENT_KEY = 'ls_cookie_consent';   // 'ALLOW' | 'DENY' | 'CLOSE'
  const SESSION_KEY = 'ls_session_id';
  const SESSION_STARTED_KEY = 'ls_session_started';
  const PREV_PAGE_KEY = 'ls_prev_page';

  function getConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }
  function setConsent(v) {
    try { localStorage.setItem(CONSENT_KEY, v); } catch (e) { /* ignore */ }
  }

  // sessionStorage (not localStorage) so a session naturally ends when the
  // tab closes and a brand-new tab starts a fresh session — matches the
  // "one sessionId per visit/session, not per click" requirement, and the
  // same tab-scoped pattern already used for login sessions on this site.
  function getSessionId() {
    try {
      let id = sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (e) {
      return 'sess_fallback_' + Date.now();
    }
  }

  // Reuses whichever login token (shipper/broker/carrier or admin) already
  // lives in this tab's sessionStorage — set by /assets/auth.js on portal
  // pages. Never reads/sends passwords or the token's contents, just
  // attaches it as the Authorization header so the backend can resolve
  // who's logged in (or leave it blank for an anonymous visitor).
  function getAuthToken() {
    try {
      return sessionStorage.getItem('ls_user_token') || sessionStorage.getItem('ls_admin_token') || null;
    } catch (e) { return null; }
  }

  const PAGE_NAME_MAP = {
    '/': 'HOME',
    '/login/shipper': 'LOGIN_SHIPPER',
    '/login/broker': 'LOGIN_BROKER',
    '/login/carrier': 'LOGIN_CARRIER',
    '/register/shipper': 'SHIPPER_REGISTRATION',
    '/register/broker': 'BROKER_REGISTRATION',
    '/register/carrier': 'CARRIER_REGISTRATION',
    '/portal/shipper': 'SHIPPER_PORTAL',
    '/portal/broker': 'BROKER_PORTAL',
    '/portal/carrier': 'CARRIER_PORTAL',
    '/portal/shipper/estimate': 'ESTIMATE_BOOKING',
    '/portal/shipper/live-tracking': 'LIVE_TRACKING',
    '/portal/shipper/requests': 'REQUEST_PORTAL',
    '/success': 'REGISTRATION_SUCCESS',
  };
  function pageName() {
    const path = window.location.pathname;
    return PAGE_NAME_MAP[path] || path.replace(/^\//, '').replace(/[/-]/g, '_').toUpperCase() || 'UNKNOWN';
  }

  function previousPage() {
    try { return sessionStorage.getItem(PREV_PAGE_KEY) || ''; } catch (e) { return ''; }
  }
  function rememberCurrentPageAsPrevious() {
    try { sessionStorage.setItem(PREV_PAGE_KEY, pageName()); } catch (e) { /* ignore */ }
  }

  // Low-level send — used both by the always-on events (visit/consent) and
  // by the consent-gated log() below. Never blocks/throws into the caller;
  // a tracking failure must never break the actual page.
  function send(eventType, action, extra) {
    const token = getAuthToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const payload = Object.assign({
      sessionId: getSessionId(),
      eventType: eventType,
      action: action || '',
      page: pageName(),
      route: window.location.pathname,
      previousPage: previousPage(),
    }, extra || {});
    try {
      fetch('/api/track', { method: 'POST', headers: headers, body: JSON.stringify(payload), keepalive: true }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  // Consent decisions themselves are ALWAYS recorded — this is the one
  // thing that must never be gated by consent (it would be circular).
  function logConsentEvent(action) {
    send('COOKIE_CONSENT', action);
  }

  // Named application-level event, gated by consent. Safe to call from
  // anywhere at any time — no-ops quietly unless the person has clicked
  // Allow. `metadata` should only ever contain small, non-sensitive labels
  // (e.g. { role: 'shipper' }) — never field values, tokens, or secrets;
  // the server also strips anything that looks sensitive as a backstop.
  function log(eventType, action, metadata) {
    if (getConsent() !== 'ALLOW') return;
    send(eventType, action, { metadata: metadata || {} });
  }

  // ---- Cookie consent popup ----
  // Positioned on the LEFT side of the screen (not centered) per spec, with
  // a light-blue interactive panel design and a slide-in-from-left entrance.
  function injectStyles() {
    if (document.getElementById('lsCookieConsentStyles')) return;
    const style = document.createElement('style');
    style.id = 'lsCookieConsentStyles';
    style.textContent =
      '#lsCookieConsent{position:fixed;left:20px;bottom:20px;z-index:99999;max-width:340px;width:calc(100% - 40px);font-family:"Inter",sans-serif;}' +
      '.ls-cc-box{' +
        'position:relative;background:linear-gradient(160deg,#eaf4ff 0%,#dbecff 100%);color:#0e2a4d;' +
        'border-radius:20px;padding:22px 22px 20px;box-shadow:0 24px 50px -20px rgba(28,79,156,0.45),0 0 0 1px rgba(52,120,246,0.12);' +
        'box-sizing:border-box;' +
        'transform:translateX(-140%);opacity:0;' +
        'transition:transform .45s cubic-bezier(.22,1,.36,1), opacity .35s ease;' +
      '}' +
      '.ls-cc-box.in{transform:translateX(0);opacity:1;}' +
      '.ls-cc-box.out{transform:translateX(-140%);opacity:0;}' +
      '.ls-cc-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;}' +
      '.ls-cc-icon{font-size:22px;line-height:1;}' +
      '.ls-cc-title{font-size:15px;font-weight:700;color:#0e2a4d;}' +
      '.ls-cc-text p{font-size:12.5px;color:#3a5a8a;line-height:1.55;margin:0 0 16px;}' +
      '.ls-cc-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}' +
      '.ls-cc-btn{padding:10px 18px;border-radius:999px;border:none;cursor:pointer;font-weight:700;font-size:13px;font-family:"Inter",sans-serif;transition:transform .15s ease, box-shadow .15s ease, background .15s ease;}' +
      '.ls-cc-btn:hover{transform:translateY(-1px);}' +
      '.ls-cc-btn.allow{background:#1c4f9c;color:#fff;box-shadow:0 8px 18px -8px rgba(28,79,156,0.6);}' +
      '.ls-cc-btn.allow:hover{background:#153e7c;}' +
      '.ls-cc-btn.deny{background:rgba(28,79,156,0.1);color:#1c4f9c;}' +
      '.ls-cc-btn.deny:hover{background:rgba(28,79,156,0.18);}' +
      '.ls-cc-x{position:absolute;top:14px;right:16px;background:none;border:none;color:#5c7ca8;font-size:18px;cursor:pointer;line-height:1;transition:color .15s ease, transform .15s ease;}' +
      '.ls-cc-x:hover{color:#0e2a4d;transform:scale(1.1);}' +
      '@media (max-width:480px){#lsCookieConsent{left:12px;right:12px;bottom:12px;max-width:none;width:auto;}}';
    document.head.appendChild(style);
  }

  function hidePopup() {
    const host = document.getElementById('lsCookieConsent');
    if (!host) return;
    const box = host.querySelector('.ls-cc-box');
    if (box) {
      box.classList.remove('in');
      box.classList.add('out');
    }
    setTimeout(() => host.remove(), 380);
  }

  function injectPopup() {
    if (document.getElementById('lsCookieConsent')) return;
    injectStyles();
    const el = document.createElement('div');
    el.id = 'lsCookieConsent';
    el.innerHTML =
      '<div class="ls-cc-box">' +
        '<button type="button" class="ls-cc-x" id="lsCookieCloseX" aria-label="Close">&times;</button>' +
        '<div class="ls-cc-head">' +
          '<span class="ls-cc-icon">\uD83C\uDF6A</span>' +
          '<span class="ls-cc-title">Cookie Preferences</span>' +
        '</div>' +
        '<div class="ls-cc-text">' +
          '<p>We use cookies to improve your experience and provide essential functionality. You can Allow this, Deny it, or close this without deciding.</p>' +
        '</div>' +
        '<div class="ls-cc-actions">' +
          '<button type="button" class="ls-cc-btn allow" id="lsCookieAllowBtn">Allow</button>' +
          '<button type="button" class="ls-cc-btn deny" id="lsCookieDenyBtn">Deny</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    // Slide in on the next frame (adding the transition-triggering class in
    // the same tick the element is created wouldn't animate).
    const box = el.querySelector('.ls-cc-box');
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('in')));

    document.getElementById('lsCookieAllowBtn').addEventListener('click', function () {
      setConsent('ALLOW');
      logConsentEvent('ALLOW');
      hidePopup();
      // Start tracking immediately, on the page the person is already on —
      // matches the spec's example flow (Allow, then a page-view for the
      // current page, then onward).
      send('PAGE_VIEW', 'PAGE_VIEW');
      rememberCurrentPageAsPrevious();
    });
    document.getElementById('lsCookieDenyBtn').addEventListener('click', function () {
      setConsent('DENY');
      logConsentEvent('DENY');
      hidePopup();
    });
    document.getElementById('lsCookieCloseX').addEventListener('click', function () {
      setConsent('CLOSE');
      logConsentEvent('CLOSE');
      hidePopup();
    });
  }

  function maybeShowPopup() {
    // ?resetcookies=1 forces the popup to show regardless of any saved
    // consent — a quick way to re-test the popup, or for a person to
    // change their mind, without needing to manually clear browser storage.
    let forceReset = false;
    try { forceReset = new URLSearchParams(window.location.search).get('resetcookies') === '1'; } catch (e) { /* ignore */ }
    if (forceReset) {
      try { localStorage.removeItem(CONSENT_KEY); } catch (e) { /* ignore */ }
    }
    if (forceReset || !getConsent()) injectPopup();
  }


  // ---- Auto-tracking on every page load ----
  function autoTrackOnLoad() {
    // WEBSITE_VISIT: once per session, unconditional (see file header for
    // why this one isn't gated behind consent).
    let sessionStarted;
    try { sessionStarted = sessionStorage.getItem(SESSION_STARTED_KEY); } catch (e) { sessionStarted = null; }
    if (!sessionStarted) {
      send('WEBSITE_VISIT', 'VISIT');
      try { sessionStorage.setItem(SESSION_STARTED_KEY, '1'); } catch (e) { /* ignore */ }
    }
    // PAGE_VIEW: every load, but only once consent is ALLOW.
    if (getConsent() === 'ALLOW') {
      send('PAGE_VIEW', 'PAGE_VIEW');
    }
    rememberCurrentPageAsPrevious();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { maybeShowPopup(); autoTrackOnLoad(); });
  } else {
    maybeShowPopup(); autoTrackOnLoad();
  }

  LS.Track = {
    log: log,
    sessionId: getSessionId,
    pageName: pageName,
    getConsent: getConsent,
    // Lets a settings/preferences UI let someone change their mind later
    // without breaking anything — just clears the stored choice and shows
    // the popup again.
    resetConsent: function () {
      try { localStorage.removeItem(CONSENT_KEY); } catch (e) { /* ignore */ }
      maybeShowPopup();
    },
  };
  window.LS = LS;
})();
