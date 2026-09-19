  // ---- Dark / Light mode toggle (shared key with rest of the portal) ----
  (function initTheme() {
    const KEY = 'ls_theme';
    function apply(theme) {
      document.body.classList.toggle('dark-mode', theme === 'dark');
      document.getElementById('themeIcon').textContent = theme === 'dark' ? '☀️' : '🌙';
      document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Light' : 'Dark';
    }
    apply(localStorage.getItem(KEY) || 'light');
    document.getElementById('themeToggle').addEventListener('click', () => {
      const next = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
      apply(next);
    });
  })();

  const errorBanner = document.getElementById('errorBanner');
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
    setTimeout(() => { errorBanner.style.display = 'none'; }, 5000);
  }

  const listWrap = document.getElementById('loadListWrap');
  let allLoads = [];

  // ---- Trip timeline (per card, lazy-loaded) ----
  // The card list fully re-renders every 12s (see the poll at the bottom of
  // this file), which would normally wipe out any expanded/loaded state —
  // these two module-level stores survive across re-renders so an already-
  // open timeline doesn't flash closed or re-fetch every poll cycle.
  const expandedTimelines = new Set(); // tokenNo set
  const timelineEventsCache = {};      // tokenNo -> TrackingEvent[]

  // A plain <a href> can't carry a fetch() Authorization header, so private
  // document links (invoices/POD) need the token appended as a query
  // param — the server's getBearerToken() already supports that fallback.
  function userDocUrl(url) {
    let token = '';
    try { token = sessionStorage.getItem('ls_user_token') || ''; } catch (e) { /* ignore */ }
    if (!token) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
  }

  function statusClass(status) { return String(status || '').replace(/[^a-zA-Z]/g, ''); }

  function renderFlowStepper(flow) {
    if (!flow || !flow.steps) return '';
    return '<div class="flow-stepper">' + flow.steps.map((s, i) => {
      const cls = i === flow.currentIndex ? 'flow-step current' : (s.done ? 'flow-step done' : 'flow-step');
      return `<span class="${cls}"><span class="dot"></span>${s.label}</span>`;
    }).join('') + '</div>';
  }

  function renderDocsBlock(o) {
    const t = o.tracking || {};
    const isDelivered = t.status === 'Delivered';

    let loadInvoiceRow = `<div class="doc-row"><span class="k">Load Invoice</span>`;
    loadInvoiceRow += o.loadInvoicePath
      ? `<a href="${userDocUrl('/api/orders/' + encodeURIComponent(o.tokenNo) + '/document/load-invoice')}" target="_blank" rel="noopener" class="doc-link">📄 View</a>`
      : `<span class="doc-chip pending">Not generated yet</span>`;
    loadInvoiceRow += `</div>`;

    let transportInvoiceRow = `<div class="doc-row"><span class="k">Transport Invoice</span>`;
    transportInvoiceRow += o.transportInvoicePath
      ? `<a href="${userDocUrl('/api/orders/' + encodeURIComponent(o.tokenNo) + '/document/transport-invoice')}" target="_blank" rel="noopener" class="doc-link">📄 View</a>`
      : `<span class="doc-chip pending">Generated automatically after POD is uploaded</span>`;
    transportInvoiceRow += `</div>`;

    let podHtml;
    if (o.podPath) {
      const verifiedChip = o.podVerified
        ? '<span class="doc-chip verified">✓ Verified by Admin</span>'
        : '<span class="doc-chip pending">Awaiting Admin review</span>';
      podHtml = `
        <div class="doc-row">
          <span class="k">Proof of Delivery</span>
          <a href="${userDocUrl('/api/orders/' + encodeURIComponent(o.tokenNo) + '/document/pod')}" target="_blank" rel="noopener" class="doc-link">📄 View POD</a>
          ${verifiedChip}
          <label class="pod-reupload-label">Re-upload POD
            <input type="file" class="pod-file-input" data-token="${o.tokenNo}" accept="image/png,image/jpeg,application/pdf" style="display:none;">
          </label>
        </div>`;
    } else if (isDelivered) {
      podHtml = `
        <div class="doc-row">
          <span class="k">Proof of Delivery</span>
          <span class="doc-chip missing">Not uploaded yet</span>
        </div>
        <p class="pod-note">This load has been delivered — upload the POD to generate the Transport Invoice.</p>
        <label class="upload-pod-btn">📎 Upload POD
          <input type="file" class="pod-file-input" data-token="${o.tokenNo}" accept="image/png,image/jpeg,application/pdf" style="display:none;">
        </label>
        <span class="pod-upload-hint" data-hint-for="${o.tokenNo}"></span>`;
    } else {
      podHtml = `
        <div class="doc-row">
          <span class="k">Proof of Delivery</span>
          <span class="doc-chip missing">Available once Delivered</span>
        </div>
        <span class="upload-pod-btn disabled">📎 Upload POD</span>`;
    }

    return `<div class="docs-block">${loadInvoiceRow}${transportInvoiceRow}${podHtml}</div>`;
  }

  function renderCard(o) {
    const t = o.tracking || {};
    return `
      <div class="load-card" data-token="${o.tokenNo}">
        <div class="load-head">
          <div>
            <div class="load-route">${o.pickup || '—'} → ${o.destination || '—'}</div>
            <div class="load-token">Token No. ${o.tokenNo || '—'} ${o.tokenNo ? LS.copyBtnHtml(o.tokenNo) : ''}</div>
          </div>
          <span class="status-pill ${statusClass(t.status)}">${t.status || 'Booked'}</span>
        </div>

        ${renderFlowStepper(o.flow)}

        <div class="info-grid">
          <div class="info-cell"><div class="k">Shipper</div><div class="v">${o.companyName || '—'}</div></div>
          <div class="info-cell"><div class="k">Material</div><div class="v">${o.material || '—'}</div></div>
          <div class="info-cell"><div class="k">Load</div><div class="v">${o.weight != null ? o.weight + ' tons' : '—'}</div></div>
          <div class="info-cell"><div class="k">Distance</div><div class="v">${o.distanceKm != null ? o.distanceKm + ' km' : '—'}</div></div>
          <div class="info-cell"><div class="k">Current location</div><div class="v">${t.currentLocation || '—'}</div></div>
        </div>

        ${renderDocsBlock(o)}

        <div class="timeline-toggle-row">
          <button type="button" class="ls-btn-link" data-timeline-toggle="${o.tokenNo}">
            ${expandedTimelines.has(o.tokenNo) ? 'Hide trip timeline' : 'Show trip timeline'}
          </button>
        </div>
        <div class="trip-timeline-wrap" data-timeline-for="${o.tokenNo}" ${expandedTimelines.has(o.tokenNo) ? '' : 'hidden'}>
          <p class="tl-loading-note">Loading trip history…</p>
        </div>
      </div>
    `;
  }

  function renderList(loads, query) {
    if (!allLoads.length) {
      listWrap.innerHTML = '<div class="empty-state">No loads assigned to you yet. Once Admin assigns you to a load, it will appear here.</div>';
      return;
    }
    if (!loads.length) {
      listWrap.innerHTML = LS.noResultsHtml('No loads match "' + String(query || '').replace(/</g, '&lt;') + '".');
      return;
    }
    listWrap.innerHTML = loads.map(renderCard).join('');
    wireCardActions();
    restoreExpandedTimelines(loads);
  }

  function wireCardActions() {
    listWrap.querySelectorAll('.pod-file-input').forEach((input) => {
      input.addEventListener('change', () => uploadPod(input.getAttribute('data-token'), input));
    });
    listWrap.querySelectorAll('[data-timeline-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => toggleTimeline(btn.getAttribute('data-timeline-toggle')));
    });
  }

  // Re-renders any timeline the carrier already had open, from cache — no
  // network call — so the 12s background poll doesn't flicker/refetch an
  // already-visible timeline every cycle.
  function restoreExpandedTimelines(loads) {
    (loads || []).forEach((o) => {
      if (!expandedTimelines.has(o.tokenNo) || !timelineEventsCache[o.tokenNo]) return;
      const el = listWrap.querySelector(`[data-timeline-for="${o.tokenNo}"]`);
      if (el && window.LSTripTimeline) {
        LSTripTimeline.render(el, { currentStage: o.loadStage, events: timelineEventsCache[o.tokenNo] });
      }
    });
  }

  function toggleTimeline(tokenNo) {
    const el = listWrap.querySelector(`[data-timeline-for="${tokenNo}"]`);
    const btn = listWrap.querySelector(`[data-timeline-toggle="${tokenNo}"]`);
    if (!el) return;
    const isOpen = expandedTimelines.has(tokenNo);
    if (isOpen) {
      expandedTimelines.delete(tokenNo);
      el.hidden = true;
      if (btn) btn.textContent = 'Show trip timeline';
      return;
    }
    expandedTimelines.add(tokenNo);
    el.hidden = false;
    if (btn) btn.textContent = 'Hide trip timeline';
    if (timelineEventsCache[tokenNo]) {
      const o = allLoads.find((x) => x.tokenNo === tokenNo);
      if (window.LSTripTimeline) LSTripTimeline.render(el, { currentStage: o && o.loadStage, events: timelineEventsCache[tokenNo] });
      return;
    }
    fetch('/api/loads/' + encodeURIComponent(tokenNo) + '/tracking')
      .then((r) => (r.ok ? r.json() : []))
      .then((events) => {
        timelineEventsCache[tokenNo] = events || [];
        const o = allLoads.find((x) => x.tokenNo === tokenNo);
        if (window.LSTripTimeline) LSTripTimeline.render(el, { currentStage: o && o.loadStage, events: events || [] });
        else el.innerHTML = '<p class="tl-loading-note">No trip updates recorded yet.</p>';
      })
      .catch(() => { el.innerHTML = '<p class="tl-loading-note">Could not load trip history.</p>'; });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  function uploadPod(tokenNo, input) {
    const file = input.files[0];
    if (!file) return;
    const hint = listWrap.querySelector(`.pod-upload-hint[data-hint-for="${tokenNo}"]`);
    if (hint) { hint.textContent = 'Uploading…'; hint.style.color = ''; }
    readFileAsDataUrl(file)
      .then((dataUrl) => fetch('/api/kyc/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'pod', imageBase64: dataUrl }),
      }))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not upload that file.');
        return data;
      })
      .then((data) => fetch('/api/carrier/orders/' + encodeURIComponent(tokenNo) + '/upload-pod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ podPath: data.path }),
      }))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save the POD.');
        return data;
      })
      .then((data) => {
        const idx = allLoads.findIndex((o) => o.tokenNo === tokenNo);
        if (idx !== -1) allLoads[idx] = { ...allLoads[idx], ...data };
        refreshList();
        if (window.LS && LS.showSuccess) LS.showSuccess('POD uploaded successfully! Transport invoice generated.');
      })
      .catch((err) => {
        if (hint) { hint.textContent = err.message; hint.style.color = 'var(--danger, #c0392b)'; }
        else alert(err.message);
      });
  }

  function currentQuery() {
    return document.getElementById('loadSearchInput').value.trim();
  }

  function refreshList() {
    const query = currentQuery();
    const filtered = query
      ? allLoads.filter((o) => LS.matchAny(o, query, ['tokenNo', 'pickup', 'destination', 'material']))
      : allLoads;
    renderList(filtered, query);
  }

  function loadMyLoads() {
    fetch('/api/carrier/orders?_=' + Date.now())
      .then((res) => {
        if (res.status === 401) { window.location.href = '/login/carrier'; return null; }
        return res.json();
      })
      .then((records) => {
        if (!records) return;
        allLoads = records;
        refreshList();
      })
      .catch(() => {
        listWrap.innerHTML = '<div class="empty-state">Could not load your assigned loads.</div>';
      });
  }

  LS.wireLocalSearch({
    inputEl: document.getElementById('loadSearchInput'),
    getRecords: () => allLoads,
    fields: ['tokenNo', 'pickup', 'destination', 'material'],
    onResults: (filtered, query) => renderList(filtered, query),
  });

  loadMyLoads();

  // Poll every 12s so admin tracking updates (status changes, assignment,
  // etc.) show up here without the carrier needing to refresh.
  setInterval(loadMyLoads, 12000);
