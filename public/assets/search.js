/**
 * search.js
 * Load Smart — shared search + copy-to-clipboard helpers.
 *
 * Used by every module that needs the same "magnifying glass" search box:
 *   - Shipper Booking Status (local filter over the shipper's own bookings)
 *   - Shipper Live Tracking (remote search by Token/Order No. or city)
 *   - Admin Shipper/Carrier/Broker lists (local filter)
 *   - Admin Tracking module (remote search)
 *   - Admin Rate Requests (local filter)
 *
 * Exposes a single global: window.LS
 */
(function () {
  const LS = window.LS || {};
  LS.SEARCH_ICON = '🔍';

  /**
   * Case-insensitive "does this record field contain this query" check.
   * Safe against null/undefined/number fields.
   */
  LS.matchText = function matchText(fieldValue, query) {
    if (!query) return true;
    return String(fieldValue == null ? '' : fieldValue)
      .toLowerCase()
      .includes(String(query).toLowerCase());
  };

  /**
   * True if `record` matches `query` against ANY of the given field names.
   * Example: LS.matchAny(booking, 'LS482', ['tokenNo','pickup','destination'])
   */
  LS.matchAny = function matchAny(record, query, fields) {
    if (!query) return true;
    return fields.some((f) => LS.matchText(record[f], query));
  };

  /**
   * Returns the standard "no results" markup used everywhere search can
   * come up empty, so every module shows the same message/style.
   */
  LS.noResultsHtml = function noResultsHtml(message) {
    return '<div class="ls-no-results">' + (message || 'No results found.') + '</div>';
  };

  /**
   * Wires an <input> up for INSTANT local filtering — no network request,
   * so no artificial delay and no "Searching…" indicator (per spec: local/
   * filter searches should not add unnecessary delay).
   *
   * options:
   *   inputEl   - the search <input>
   *   getRecords() - returns the full, unfiltered array to search
   *   fields    - array of record field names to match against (case-insensitive)
   *   onResults(filteredArray, query) - called after every keystroke with the
   *               filtered list; caller is responsible for rendering it
   *               (including the empty state, via LS.noResultsHtml if desired)
   */
  LS.wireLocalSearch = function wireLocalSearch({ inputEl, getRecords, fields, onResults }) {
    if (!inputEl) return;
    function run() {
      const query = inputEl.value.trim();
      const all = getRecords() || [];
      const filtered = query ? all.filter((r) => LS.matchAny(r, query, fields)) : all;
      onResults(filtered, query);
    }
    inputEl.addEventListener('input', run);
    return run;
  };

  /**
   * Wires an <input> up for a REMOTE (API) search — debounced so we don't
   * spam the server on every keystroke, and shows a "🔍 Searching…"
   * indicator only for the duration the request is actually in flight.
   *
   * options:
   *   inputEl, statusEl (the ".ls-search-status" element)
   *   fetchFn(query) -> Promise<data>
   *   onResults(data, query), onError(err, query)
   *   debounceMs (default 300), minChars (default 0 — empty query allowed,
   *     useful for "show everything" searches)
   */
  LS.wireRemoteSearch = function wireRemoteSearch({ inputEl, statusEl, fetchFn, onResults, onError, debounceMs, minChars }) {
    if (!inputEl) return;
    const wait = debounceMs == null ? 300 : debounceMs;
    const min = minChars || 0;
    let timer = null;
    let requestSeq = 0;

    function showStatus(show) {
      if (!statusEl) return;
      statusEl.classList.toggle('show', !!show);
    }

    function run() {
      const query = inputEl.value.trim();
      if (query.length < min) return;
      const seq = ++requestSeq;
      showStatus(true);
      Promise.resolve(fetchFn(query))
        .then((data) => {
          if (seq !== requestSeq) return; // a newer search superseded this one
          showStatus(false);
          onResults(data, query);
        })
        .catch((err) => {
          if (seq !== requestSeq) return;
          showStatus(false);
          if (onError) onError(err, query);
        });
    }

    inputEl.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, wait);
    });

    return run; // callers can trigger an immediate search (e.g. on button click / Enter)
  };

  /**
   * Copies `text` to the clipboard and gives the button that triggered it
   * brief "Copied!" feedback. Falls back to a hidden textarea + execCommand
   * for browsers/contexts without the async Clipboard API.
   */
  LS.copyToClipboard = function copyToClipboard(text, btnEl) {
    function flash() {
      if (!btnEl) return;
      const original = btnEl.textContent;
      btnEl.textContent = 'Copied!';
      btnEl.classList.add('copied');
      setTimeout(() => {
        btnEl.textContent = original;
        btnEl.classList.remove('copied');
      }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(text)).then(flash).catch(() => fallbackCopy(text, flash));
    } else {
      fallbackCopy(text, flash);
    }
  };

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = String(text);
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    if (done) done();
  }

  /**
   * Builds the standard markup for a copy button next to a generated value
   * (Token No., Reference ID, Username). Caller wires up the click handler
   * by calling LS.copyToClipboard(value, event.target) in an onclick, e.g.:
   *   `<span>${token}</span> ${LS.copyBtnHtml(token)}`
   */
  LS.copyBtnHtml = function copyBtnHtml(value) {
    const safe = String(value == null ? '' : value).replace(/'/g, '&#39;');
    return `<button type="button" class="ls-copy-btn" onclick="LS.copyToClipboard('${safe}', this)">📋 Copy</button>`;
  };

  window.LS = LS;
})();
