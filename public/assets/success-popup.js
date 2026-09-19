/**
 * success-popup.js
 * Load Smart — one reusable success notification, used everywhere instead
 * of a different popup/toast per page.
 *
 * Include this on any page that needs it:
 *   <script src="/assets/success-popup.js"></script>
 *
 * Usage:
 *   LS.showSuccess('Rate request submitted successfully!');
 *
 * Design: green check-mark on a soft blue circular badge, rounded card,
 * smooth entrance/exit animation, auto-closes on its own — never a full-
 * screen blocking overlay, so the rest of the page stays usable underneath.
 *
 * IMPORTANT: only ever call this after a real success response from the
 * server (e.g. inside a .then() once res.ok is confirmed) — never on a
 * failed request. Use the page's existing error banner/alert for failures.
 */
(function () {
  const LS = window.LS || {};

  function injectStyles() {
    if (document.getElementById('lsSuccessPopupStyles')) return;
    const style = document.createElement('style');
    style.id = 'lsSuccessPopupStyles';
    style.textContent =
      '#lsSuccessPopupHost{position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:100000;display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none;width:100%;padding:0 16px;box-sizing:border-box;}' +
      '.ls-success-toast{' +
        'pointer-events:auto;display:flex;align-items:center;gap:14px;' +
        'background:linear-gradient(135deg,#eaf2ff 0%,#dceaff 100%);' +
        'border:1px solid rgba(52,120,246,0.35);' +
        'box-shadow:0 20px 45px -18px rgba(28,79,156,0.45),0 0 0 4px rgba(52,120,246,0.08);' +
        'border-radius:18px;padding:16px 22px 16px 16px;max-width:420px;width:100%;' +
        'font-family:"Inter",sans-serif;' +
        'opacity:0;transform:translateY(-16px) scale(0.96);' +
        'transition:opacity .28s ease, transform .28s cubic-bezier(.34,1.56,.64,1);' +
      '}' +
      '.ls-success-toast.show{opacity:1;transform:translateY(0) scale(1);}' +
      '.ls-success-toast.hide{opacity:0;transform:translateY(-10px) scale(0.97);}' +
      '.ls-success-badge{' +
        'flex-shrink:0;width:40px;height:40px;border-radius:50%;' +
        'background:radial-gradient(circle at 35% 30%, #4f8cff, #1c4f9c);' +
        'display:flex;align-items:center;justify-content:center;' +
        'box-shadow:0 6px 16px -4px rgba(28,79,156,0.55);' +
      '}' +
      '.ls-success-badge svg{width:20px;height:20px;}' +
      '.ls-success-text{flex:1;min-width:0;display:flex;flex-direction:column;}' +
      '.ls-success-title{font-weight:700;font-size:14.5px;color:#0e3a24;line-height:1.3;display:block;}' +
      '.ls-success-sub{font-size:12px;color:#3a5a8a;margin-top:2px;line-height:1.4;display:block;}' +
      '.ls-success-close{background:none;border:none;color:#5c7cA8;font-size:16px;cursor:pointer;line-height:1;padding:2px;flex-shrink:0;}' +
      '.ls-success-close:hover{color:#1c4f9c;}' +
      '.ls-error-toast{' +
        'pointer-events:auto;display:flex;align-items:flex-start;gap:14px;' +
        'background:linear-gradient(135deg,#fdeceb 0%,#fbdbd8 100%);' +
        'border:1px solid rgba(192,57,43,0.35);' +
        'box-shadow:0 20px 45px -18px rgba(120,30,20,0.35),0 0 0 4px rgba(192,57,43,0.08);' +
        'border-radius:18px;padding:16px 22px 16px 16px;max-width:420px;width:100%;' +
        'font-family:"Inter",sans-serif;' +
        'opacity:0;transform:translateY(-16px) scale(0.96);' +
        'transition:opacity .28s ease, transform .28s cubic-bezier(.34,1.56,.64,1);' +
      '}' +
      '.ls-error-toast.show{opacity:1;transform:translateY(0) scale(1);}' +
      '.ls-error-toast.hide{opacity:0;transform:translateY(-10px) scale(0.97);}' +
      '.ls-error-badge{' +
        'flex-shrink:0;width:40px;height:40px;border-radius:50%;margin-top:1px;' +
        'background:radial-gradient(circle at 35% 30%, #e2645a, #a5291b);' +
        'display:flex;align-items:center;justify-content:center;' +
        'box-shadow:0 6px 16px -4px rgba(120,30,20,0.5);' +
      '}' +
      '.ls-error-badge svg{width:20px;height:20px;}' +
      '.ls-error-text{flex:1;min-width:0;display:flex;flex-direction:column;}' +
      '.ls-error-title{font-weight:700;font-size:14.5px;color:#5c1a12;line-height:1.35;display:block;}' +
      '.ls-error-sub{font-size:12px;color:#8a3226;margin-top:3px;line-height:1.4;display:block;}' +
      '.ls-error-close{background:none;border:none;color:#a5291b;font-size:16px;cursor:pointer;line-height:1;padding:2px;flex-shrink:0;}' +
      '.ls-error-close:hover{color:#5c1a12;}' +
      '@media (max-width:480px){ .ls-error-toast{ max-width:none; } }';
    document.head.appendChild(style);
  }

  function getHost() {
    let host = document.getElementById('lsSuccessPopupHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'lsSuccessPopupHost';
      document.body.appendChild(host);
    }
    return host;
  }

  /**
   * Shows the green-tick / blue-background success popup.
   * @param {string} message - main confirmation text, e.g. "Rate request submitted successfully!"
   * @param {object} [opts]
   * @param {string} [opts.sub] - optional secondary line (e.g. a reference/token number)
   * @param {number} [opts.duration] - ms before auto-dismiss (default 1000 — exactly 1 second, per spec)
   */
  function showSuccess(message, opts) {
    injectStyles();
    const options = opts || {};
    // Exactly 1 second by default, per spec ("do not make it 2, 3, 5, or
    // 10 seconds"). Callers may still pass a custom duration for special
    // cases, but nothing in this codebase currently does.
    const duration = options.duration != null ? options.duration : 1000;
    const host = getHost();

    const toast = document.createElement('div');
    toast.className = 'ls-success-toast';
    toast.innerHTML =
      '<span class="ls-success-badge">' +
        '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l5 5L19 7" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</span>' +
      '<span class="ls-success-text">' +
        '<span class="ls-success-title"></span>' +
        (options.sub ? '<span class="ls-success-sub"></span>' : '') +
      '</span>' +
      '<button type="button" class="ls-success-close" aria-label="Close">&times;</button>';

    toast.querySelector('.ls-success-title').textContent = message;
    if (options.sub) toast.querySelector('.ls-success-sub').textContent = options.sub;

    host.appendChild(toast);
    // Force a reflow so the entrance transition actually plays (adding the
    // class in the very next tick, not the same one the element was created in).
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 300);
    }

    // The X button can still close it early if someone wants — but the
    // auto-close timer below always fires on schedule regardless (no
    // hover-to-pause: a paused-forever timer was exactly why this wasn't
    // auto-closing reliably before).
    toast.querySelector('.ls-success-close').addEventListener('click', dismiss);
    setTimeout(dismiss, duration);
  }

  /**
   * Shows a red error popup — used so a single wrong field can be reported
   * without reloading/clearing the whole form (unlike a server redirect,
   * which wipes every field the person already filled in).
   * @param {string} message - what went wrong, in plain language
   * @param {object} [opts]
   * @param {string} [opts.sub] - optional secondary line (extra detail/hint)
   * @param {number} [opts.duration] - ms before auto-dismiss (default 5000 — longer than success, so there's time to actually read it)
   */
  function showError(message, opts) {
    injectStyles();
    const options = opts || {};
    const duration = options.duration != null ? options.duration : 5000;
    const host = getHost();

    const toast = document.createElement('div');
    toast.className = 'ls-error-toast';
    toast.innerHTML =
      '<span class="ls-error-badge">' +
        '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 16h.01" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke="#fff" stroke-width="2"/></svg>' +
      '</span>' +
      '<span class="ls-error-text">' +
        '<span class="ls-error-title"></span>' +
        (options.sub ? '<span class="ls-error-sub"></span>' : '') +
      '</span>' +
      '<button type="button" class="ls-error-close" aria-label="Close">&times;</button>';

    toast.querySelector('.ls-error-title').textContent = message;
    if (options.sub) toast.querySelector('.ls-error-sub').textContent = options.sub;

    host.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 300);
    }
    toast.querySelector('.ls-error-close').addEventListener('click', dismiss);
    setTimeout(dismiss, duration);
  }

  LS.showSuccess = showSuccess;
  LS.showError = showError;
  window.LS = LS;
})();
