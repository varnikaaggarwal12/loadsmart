/**
 * pincode-autofill.js
 * Load Smart — shared PIN code -> District / State / Area auto-fill.
 *
 * Any address form with a 6-digit Indian PIN code field can call
 * LS.initPincodeAutofill({...}) to get:
 *   - digit-only, max-6 input sanitizing
 *   - automatic lookup as soon as a valid 6-digit code is entered
 *     (plus an on-blur lookup as a fallback)
 *   - a "Looking up PIN code…" loading indicator (with spinner) while the
 *     request is in flight
 *   - district/state/area auto-filled but always left editable, so the
 *     person can correct them manually if needed
 *   - a clear red error message if the PIN code is invalid or not found
 *
 * Uses the existing GET /api/pincode/:code endpoint — no new backend
 * route needed.
 */
(function () {
  const LS = window.LS || {};

  LS.initPincodeAutofill = function initPincodeAutofill({ pincodeInput, districtInput, stateInput, areaInput, hintEl }) {
    if (!pincodeInput) return;
    let lastLookedUp = '';
    let lookupTimer = null;

    function setHint(text, color) {
      if (!hintEl) return;
      hintEl.innerHTML = text;
      hintEl.style.color = color || '';
    }

    function loadingHint() {
      setHint('<span class="ls-spinner" style="vertical-align:middle; margin-right:6px;"></span>Looking up PIN code…', '');
    }

    async function lookup(code) {
      if (code === lastLookedUp) return; // avoid refetching the same code twice
      lastLookedUp = code;
      loadingHint();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch('/api/pincode/' + code, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'PIN code not found.');
        if (districtInput) districtInput.value = data.district || '';
        if (stateInput) stateInput.value = data.state || '';
        if (areaInput) areaInput.value = data.area || '';
        setHint('District &amp; state filled in automatically — you can still edit them.', 'var(--green-deep)');
      } catch (err) {
        clearTimeout(timeoutId);
        // A raw "Failed to fetch" / AbortError means the browser couldn't
        // even reach our own server (it's down, restarting, or a local
        // network/firewall issue) — different from a normal "not found"
        // response, so say so explicitly rather than showing the cryptic
        // browser-internal error text.
        const isNetworkFailure = err.name === 'AbortError' || err instanceof TypeError;
        const message = isNetworkFailure
          ? 'Could not reach the server to look up that PIN code — check that the app server is running.'
          : (err.message || 'Could not look up that PIN code.');
        setHint(message + ' You can enter your district/state manually below.', 'var(--danger)');
      }
    }

    pincodeInput.addEventListener('input', () => {
      pincodeInput.value = pincodeInput.value.replace(/\D/g, '').slice(0, 6);
      const code = pincodeInput.value;
      if (districtInput) districtInput.value = '';
      if (stateInput) stateInput.value = '';
      if (areaInput) areaInput.value = '';
      lastLookedUp = '';
      clearTimeout(lookupTimer);
      if (code.length === 6) {
        // Small debounce so a fast typist/paste doesn't fire a lookup on
        // every intermediate digit.
        lookupTimer = setTimeout(() => lookup(code), 200);
      } else if (code) {
        setHint('PIN code must be 6 digits.', 'var(--danger)');
      } else {
        setHint('Enter your 6-digit PIN code — district &amp; state fill in automatically.', '');
      }
    });

    // Fallback: also look up on blur in case the debounce above hasn't
    // fired yet (e.g. the person tabbed away immediately after pasting).
    pincodeInput.addEventListener('blur', () => {
      const code = pincodeInput.value;
      if (/^[0-9]{6}$/.test(code)) {
        clearTimeout(lookupTimer);
        lookup(code);
      }
    });
  };

  window.LS = LS;
})();
