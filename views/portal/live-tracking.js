  // ---- Dark / Light mode toggle (shared key with rest of shipper portal) ----
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

  if (window.LSNotifBell) LSNotifBell.init({ tokenKey: 'ls_user_token', mountSelector: '#notifBellMount' });

  const listWrap = document.getElementById('orderListWrap');
  const detailPanel = document.getElementById('detailPanel');
  const params = new URLSearchParams(window.location.search);
  let selectedToken = params.get('token') || null;
  let currentOrders = [];
  let pollTimer = null;

  // ---- Live GPS push (Socket.IO) ----
  // One room per Token No. Two different events, two different reactions:
  //   - 'tracking:location' (a real GPS point) -> move the existing map
  //     marker in place via LSLiveMap.updateCurrent(), no re-fetch, no
  //     panel rebuild — this is the fast path that makes the truck move
  //     smoothly instead of the whole page flickering on every ping.
  //   - 'load:update' carrying anything OTHER than just a `gps` key (a
  //     stage change, POD update, delay, etc.) -> still does a full
  //     detail refetch, since those changes touch far more of the panel
  //     than just the map. A bare `{tokenNo, gps}` payload (kept for
  //     backward compatibility with anything else still listening for it)
  //     is ignored here specifically to avoid doing that full refresh
  //     twice for the same ping.
  // The 12s poll stays in place as a reliable fallback if the socket ever
  // drops or reconnects mid-session.
  let liveSocket = null;
  let joinedRoom = null;
  let currentLiveMap = null; // the LSLiveMap instance for the currently-rendered order's #trackingMap
  let currentLiveMeta = {};  // vehicleNumber/driverName etc. carried into incremental marker updates
  if (typeof io === 'function') {
    liveSocket = io();
    liveSocket.on('load:update', (payload) => {
      if (!payload || payload.tokenNo !== selectedToken) return;
      const otherKeys = Object.keys(payload).filter((k) => k !== 'tokenNo' && k !== 'gps');
      if (otherKeys.length === 0) return; // GPS-only push — 'tracking:location' already handles it
      loadDetail(selectedToken);
    });
    liveSocket.on('tracking:location', (point) => {
      if (!point || point.tokenNo !== selectedToken || !currentLiveMap) return;
      currentLiveMap.updateCurrent({ lat: point.lat, lon: point.lng }, {
        ...currentLiveMeta,
        speedKph: point.speedKph, headingDeg: point.headingDeg, accuracy: point.accuracy,
        updatedAt: point.updatedAt, status: 'live',
      });
      const updatedNote = document.querySelector('.updated-note');
      if (updatedNote) updatedNote.textContent = 'Last updated: ' + new Date(point.updatedAt || Date.now()).toLocaleString() + ' — live.';
    });
  }
  function joinLiveRoom(token) {
    if (!liveSocket || !token || token === joinedRoom) return;
    joinedRoom = token;
    liveSocket.emit('join', { tokenNo: token });
  }

  function statusClass(status) { return String(status || '').replace(/[^a-zA-Z]/g, ''); }
  function escapeHtml(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ---------- AI Delay Risk ----------
  const DELAY_RISK_STAGES = ['ASSIGNED', 'DRIVER_ACCEPTED', 'ARRIVED_PICKUP', 'LOADING', 'LOADED', 'DEPARTED_PICKUP', 'IN_TRANSIT', 'REACHED_DESTINATION', 'UNLOADING', 'UNLOADING_COMPLETE'];
  let delayRiskCache = {}; // keyed by tokenNo — survives the 12s poll rebuilding the whole detail panel
  const RISK_META = {
    LOW:    { label: 'LOW',    bg: '#9adf8f', fg: '#0e3a24' },
    MEDIUM: { label: 'MEDIUM', bg: '#e8722c', fg: '#3d2a12' },
    HIGH:   { label: 'HIGH',   bg: '#c0392b', fg: '#fff' },
  };
  function riskBadgeHtml(level) {
    const m = RISK_META[level] || { label: level || '—', bg: '#c8cfc8', fg: '#17251d' };
    return '<span class="ai-rec-badge" style="background:' + m.bg + '; color:' + m.fg + ';">' + escapeHtml(m.label) + '</span>';
  }
  function delayRiskPanelHtml(tokenNo) {
    const state = delayRiskCache[tokenNo];
    if (!state) return '';
    if (state.status === 'loading') return '<div class="ai-assess-result"><span class="ls-spinner"></span> Checking delay risk…</div>';
    if (state.status === 'not_configured') return '<div class="ai-muted-note">AI isn\'t configured on this server yet — set ANTHROPIC_API_KEY to enable this.</div>';
    if (state.status === 'error') return '<div class="ai-error-note">' + escapeHtml(state.error) + '</div>';
    if (state.status === 'done') {
      return '<div class="ai-assess-result">' +
        riskBadgeHtml(state.riskLevel) +
        '<p class="ai-assess-text">' + escapeHtml(state.narrative) + '</p>' +
        (state.suggestedAction ? '<p class="ai-assess-text"><b>' + escapeHtml(state.suggestedAction) + '</b></p>' : '') +
        '</div>';
    }
    return '';
  }
  function delayRiskButtonHtml(o) {
    const enabled = DELAY_RISK_STAGES.includes(o.loadStage);
    return `
      <div class="ai-delay-risk-block">
        <button type="button" class="ai-assess-btn" id="delayRiskBtn" ${enabled ? '' : 'disabled'}>🤖 Check Delay Risk</button>
        ${!enabled ? '<span class="ai-muted-note" style="margin-left:8px;">Available once the load is assigned and moving.</span>' : ''}
        <div class="ai-assess-panel" id="delay-risk-panel-${escapeHtml(o.tokenNo)}">${delayRiskPanelHtml(o.tokenNo)}</div>
      </div>`;
  }
  function runDelayRiskCheck(tokenNo, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    delayRiskCache[tokenNo] = { status: 'loading' };
    const panel = document.getElementById('delay-risk-panel-' + tokenNo);
    if (panel) panel.innerHTML = delayRiskPanelHtml(tokenNo);
    fetch('/api/tracking/order/' + encodeURIComponent(tokenNo) + '/ai-delay-risk', { method: 'POST' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (r.status === 503 && d.aiNotConfigured) { delayRiskCache[tokenNo] = { status: 'not_configured' }; return; }
        if (!r.ok) { delayRiskCache[tokenNo] = { status: 'error', error: d.error || 'The delay-risk check failed. Please try again.' }; return; }
        delayRiskCache[tokenNo] = { status: 'done', riskLevel: d.riskLevel, narrative: d.narrative, suggestedAction: d.suggestedAction || '' };
      })
      .catch(() => { delayRiskCache[tokenNo] = { status: 'error', error: 'Could not reach the AI service. Please try again.' }; })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = '🤖 Check Delay Risk';
        const panel2 = document.getElementById('delay-risk-panel-' + tokenNo);
        if (panel2) panel2.innerHTML = delayRiskPanelHtml(tokenNo);
      });
  }

  // Small badge summarizing the live-GPS state returned by the server's
  // attachLiveGpsSummary() (see server_load.js): 'live' (a fresh ping
  // within the staleness window), 'stale' (tracking was active but no
  // recent ping — e.g. driver lost signal/closed the tab), 'not_active'
  // (trip hasn't started GPS tracking, or has already ended it), or
  // 'no_data' (tracking is active but no GPS point has arrived yet).
  const LIVE_STATUS_META = {
    live: { cls: 'live', label: '🟢 Live GPS' },
    stale: { cls: 'stale', label: '🟡 Last known location' },
    not_active: { cls: 'inactive', label: '⚪ Tracking not active' },
    no_data: { cls: 'inactive', label: '⚪ Waiting for first GPS fix' },
  };
  function liveStatusBadge(liveGps) {
    const meta = LIVE_STATUS_META[(liveGps && liveGps.status) || 'not_active'] || LIVE_STATUS_META.not_active;
    return `<span class="live-status-badge ${meta.cls}">${meta.label}</span>`;
  }

  // A plain <a href> can't carry a fetch() Authorization header, so private
  // document links (invoices/POD) need the token appended as a query
  // param — the server's getBearerToken() already supports that fallback.
  function userDocUrl(url) {
    let token = '';
    try { token = sessionStorage.getItem('ls_user_token') || ''; } catch (e) { /* ignore */ }
    if (!token) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
  }

  function renderFlowStepper(flow) {
    if (!flow || !flow.steps) return '';
    return '<div class="flow-stepper">' + flow.steps.map((s, i) => {
      const cls = i === flow.currentIndex ? 'flow-step current' : (s.done ? 'flow-step done' : 'flow-step');
      return `<span class="${cls}"><span class="dot"></span>${s.label}</span>`;
    }).join('') + '</div>';
  }

  function renderDocsBlock(o) {
    const loadInvoiceRow = `<div class="doc-row"><span class="k">Load Invoice</span>${
      o.loadInvoicePath
        ? `<a href="${userDocUrl('/api/orders/' + encodeURIComponent(o.tokenNo) + '/document/load-invoice')}" target="_blank" rel="noopener" class="doc-link">📄 View</a>`
        : `<span class="doc-chip pending">Not generated yet</span>`
    }</div>`;
    const transportInvoiceRow = `<div class="doc-row"><span class="k">Transport Invoice</span>${
      o.transportInvoicePath
        ? `<a href="${userDocUrl('/api/orders/' + encodeURIComponent(o.tokenNo) + '/document/transport-invoice')}" target="_blank" rel="noopener" class="doc-link">📄 View</a>`
        : `<span class="doc-chip pending">Generated after POD is uploaded</span>`
    }</div>`;
    const podRow = `<div class="doc-row"><span class="k">Proof of Delivery</span>${
      o.podPath
        ? `<a href="${userDocUrl('/api/orders/' + encodeURIComponent(o.tokenNo) + '/document/pod')}" target="_blank" rel="noopener" class="doc-link">📄 View POD</a>` +
          (o.podVerified ? '<span class="doc-chip verified">✓ Verified by Admin</span>' : '<span class="doc-chip pending">Awaiting Admin review</span>')
        : `<span class="doc-chip missing">Not uploaded by carrier yet</span>`
    }</div>`;
    return `<div class="docs-block">${loadInvoiceRow}${transportInvoiceRow}${podRow}</div>`;
  }

  // ---- Post-trip feedback ("Rate your delivery") ----
  // Shown automatically the moment a shipment reaches loadStage
  // 'DELIVERED' and no feedback has been submitted yet (feedbackSubmitted
  // comes straight from the server — see toTrackingSummary in
  // server_load.js — never inferred client-side). Always persisted
  // server-side via POST /api/tracking/order/:token/feedback.
  const FEEDBACK_QUESTIONS = [
    ['onTime', 'Delivered on time?'],
    ['cargoHandling', 'Cargo handled with care?'],
    ['communication', 'Good communication from the driver?'],
    ['deliverySuccess', 'Delivery completed successfully?'],
    ['recommend', 'Would you use this driver again?'],
  ];

  function renderFeedbackBlock(o) {
    if (o.loadStage !== 'DELIVERED') return '';
    if (o.feedbackSubmitted) {
      return '<div class="feedback-submitted-note">✓ Thanks — you\'ve already rated this delivery.</div>';
    }
    return `
      <div class="feedback-card" id="feedbackCard">
        <h3>⭐ Rate your delivery</h3>
        <p>Your feedback updates this driver's Trust Score and helps us match better drivers to future loads.</p>
        <div class="feedback-stars" id="feedbackStars">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="feedback-star" data-star="${n}" aria-label="${n} star${n === 1 ? '' : 's'}">★</button>`).join('')}
        </div>
        <div class="feedback-toggles">
          ${FEEDBACK_QUESTIONS.map(([key, label]) => `
            <div class="feedback-toggle">
              <span>${label}</span>
              <div class="feedback-toggle-btns" data-field="${key}">
                <button type="button" data-value="true">Yes</button>
                <button type="button" data-value="false">No</button>
              </div>
            </div>`).join('')}
        </div>
        <textarea class="feedback-comments" id="feedbackComments" placeholder="Anything else you'd like to share? (optional)"></textarea>
        <p class="feedback-error" id="feedbackError" style="display:none;"></p>
        <button type="button" class="btn-primary" id="feedbackSubmitBtn" style="padding:10px 20px; border-radius:9px; border:none; cursor:pointer; font-weight:700;">Submit feedback</button>
      </div>`;
  }

  // The detail panel is fully re-rendered every 12s by the background
  // poll (see pollTimer below) — without this, a shipper mid-way through
  // filling out the feedback form would see it silently wiped every 12
  // seconds. Keyed by tokenNo so it never leaks between different orders.
  const feedbackDrafts = {};

  function wireFeedbackForm(o) {
    const card = document.getElementById('feedbackCard');
    if (!card) return;
    const draft = feedbackDrafts[o.tokenNo] || (feedbackDrafts[o.tokenNo] = {
      rating: 0, onTime: null, cargoHandling: null, communication: null, deliverySuccess: null, recommend: null, comments: '',
    });

    const stars = Array.from(card.querySelectorAll('.feedback-star'));
    function paintStars() { stars.forEach((s) => s.classList.toggle('active', Number(s.getAttribute('data-star')) <= draft.rating)); }
    paintStars();
    stars.forEach((btn) => {
      btn.addEventListener('click', () => {
        draft.rating = Number(btn.getAttribute('data-star'));
        paintStars();
      });
    });

    card.querySelectorAll('.feedback-toggle-btns').forEach((group) => {
      const field = group.getAttribute('data-field');
      const buttons = Array.from(group.querySelectorAll('button'));
      function paintToggle() {
        buttons.forEach((b) => {
          const isMatch = draft[field] === (b.getAttribute('data-value') === 'true');
          b.classList.toggle('active', draft[field] != null && isMatch);
          b.classList.toggle('yes', draft[field] != null && isMatch && b.getAttribute('data-value') === 'true');
          b.classList.toggle('no', draft[field] != null && isMatch && b.getAttribute('data-value') === 'false');
        });
      }
      paintToggle();
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          draft[field] = btn.getAttribute('data-value') === 'true';
          paintToggle();
        });
      });
    });

    const commentsEl = document.getElementById('feedbackComments');
    commentsEl.value = draft.comments || '';
    commentsEl.addEventListener('input', () => { draft.comments = commentsEl.value; });

    const errorEl = document.getElementById('feedbackError');
    const submitBtn = document.getElementById('feedbackSubmitBtn');
    submitBtn.addEventListener('click', () => {
      const missing = FEEDBACK_QUESTIONS.map(([key]) => key).filter((k) => draft[k] === null);
      if (!draft.rating) { errorEl.textContent = 'Please select a star rating.'; errorEl.style.display = 'block'; return; }
      if (missing.length) { errorEl.textContent = 'Please answer every question above.'; errorEl.style.display = 'block'; return; }
      errorEl.style.display = 'none';
      submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';
      fetch('/api/tracking/order/' + encodeURIComponent(o.tokenNo) + '/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: draft.rating, onTime: draft.onTime, cargoHandling: draft.cargoHandling,
          communication: draft.communication, deliverySuccess: draft.deliverySuccess, recommend: draft.recommend,
          comments: draft.comments,
        }),
      })
        .then((r) => r.json())
        .then((result) => {
          if (!result.ok) throw new Error(result.error || 'Could not submit feedback.');
          delete feedbackDrafts[o.tokenNo];
          if (window.LS && LS.showSuccess) LS.showSuccess('Thanks for your feedback!');
          loadDetail(o.tokenNo);
        })
        .catch((err) => {
          errorEl.textContent = err.message;
          errorEl.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit feedback';
        });
    });
  }

  function renderList(orders) {
    currentOrders = orders;
    if (!orders.length) {
      listWrap.innerHTML = '<div class="empty-state">No orders found yet. Once you get an estimate and book or send a rate request, it will appear here.</div>';
      return;
    }
    listWrap.innerHTML = '<div class="order-list">' + orders.map(o => `
      <div class="order-card ${o.tokenNo === selectedToken ? 'active' : ''}" data-token="${o.tokenNo}">
        <span class="token">${o.tokenNo}</span>
        <span class="kind-chip">${o.kind === 'booking' ? 'Booking' : 'Rate request'}</span>
        <div class="route">${o.pickup || '—'} → ${o.destination || '—'}</div>
        <div class="meta">${o.material || '—'} · ${o.weight != null ? o.weight + ' tons' : '—'}</div>
        <span class="status-chip ${statusClass(o.tracking && o.tracking.status)}">${(o.tracking && o.tracking.status) || 'Booked'}</span>
      </div>
    `).join('') + '</div>';

    listWrap.querySelectorAll('.order-card').forEach(card => {
      card.addEventListener('click', () => selectOrder(card.getAttribute('data-token')));
    });

    if (!selectedToken && orders.length) selectedToken = orders[0].tokenNo;
    if (selectedToken) loadDetail(selectedToken, { showLoading: true });
  }

  function selectOrder(token) {
    selectedToken = token;
    listWrap.querySelectorAll('.order-card').forEach(c => c.classList.toggle('active', c.getAttribute('data-token') === token));
    loadDetail(token, { showLoading: true });
  }

  function parseLocation(str) {
    if (!str) return { city: '', state: '' };
    const parts = String(str).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) return { city: parts[0], state: parts.slice(1).join(', ') };
    return { city: parts[0] || '', state: '' };
  }

  function renderDetail(o) {
    const t = o.tracking || {};
    const progress = Math.max(0, Math.min(100, Number(t.progressPercent || 0)));
    const remainingKm = o.distanceKm != null ? Math.round(o.distanceKm * (1 - progress / 100)) : null;
    // A shipment with no location, no remarks, no vehicle info, still at
    // 0% and the default "Booked" status has never actually been touched
    // by Admin yet — say so plainly instead of showing a wall of dashes.
    const hasAnyTrackingInfo = !!(t.currentLocation || t.remarks || t.vehicleInfo || progress > 0 || (t.status && t.status !== 'Booked'));

    const origin = parseLocation(o.pickup);
    const dest = parseLocation(o.destination);
    const current = parseLocation(t.currentLocation);

    detailPanel.innerHTML = `
      <div class="detail-head">
        <div>
          <div class="detail-route">${o.pickup || '—'} → ${o.destination || '—'} <span class="kind-chip">${o.kind === 'booking' ? 'Booking' : 'Rate request'}</span></div>
          <div class="detail-token">Token No. ${o.tokenNo} ${LS.copyBtnHtml(o.tokenNo)}</div>
        </div>
        <span class="status-chip ${statusClass(t.status)}" style="font-size:12.5px; padding:6px 14px;">${t.status || 'Booked'}</span>
      </div>

      ${delayRiskButtonHtml(o)}

      ${!hasAnyTrackingInfo ? '<div class="remarks-box" style="margin-top:14px;">No tracking information available yet. Admin will update this once the shipment starts moving.</div>' : ''}

      <div class="route-line">
        <div class="route-point">
          <div class="dot"></div>
          <div class="lbl">Origin</div>
          <div class="val">${origin.city || o.pickup || '—'}</div>
          ${origin.state ? `<div class="sub-val">${origin.state}</div>` : ''}
        </div>
        <div class="route-dash"></div>
        <div class="route-point current">
          <div class="dot"></div>
          <div class="lbl">Current location</div>
          <div class="val">${current.city || 'Awaiting update'}</div>
          ${current.state ? `<div class="sub-val">${current.state}</div>` : ''}
          ${current.city ? `<div class="truck-at-note">📍 Truck currently at: ${current.city}</div>` : ''}
        </div>
        <div class="route-dash"></div>
        <div class="route-point">
          <div class="dot"></div>
          <div class="lbl">Destination</div>
          <div class="val">${dest.city || o.destination || '—'}</div>
          ${dest.state ? `<div class="sub-val">${dest.state}</div>` : ''}
        </div>
      </div>

      <div id="trackingMap" class="tracking-map"></div>
      <div class="map-toolbar">
        ${liveStatusBadge(o.liveGps)}
        <button type="button" class="ls-btn-link" id="toggleHistoryBtn">Show route history</button>
      </div>
      <div id="historyPanel" style="display:none;"></div>

      <div class="progress-wrap">
        <div class="progress-track"><div class="progress-fill" style="width:${progress}%;"></div></div>
        <div class="progress-labels">
          <span>${progress}% of route completed</span>
          <span>${remainingKm != null ? remainingKm + ' km remaining' : ''}</span>
        </div>
      </div>

      <div class="info-grid">
        <div class="info-cell"><div class="k">Material</div><div class="v">${o.material || '—'}</div></div>
        <div class="info-cell"><div class="k">Weight</div><div class="v">${o.weight != null ? o.weight + ' tons' : '—'}</div></div>
        <div class="info-cell"><div class="k">Total distance</div><div class="v">${o.distanceKm != null ? o.distanceKm + ' km' : '—'}</div></div>
        <div class="info-cell"><div class="k">Carrier</div><div class="v">${o.carrierCompanyName || 'Not yet assigned'}</div></div>
        <div class="info-cell"><div class="k">Broker</div><div class="v">${o.brokerCompanyName || 'Not yet assigned'}</div></div>
        <div class="info-cell"><div class="k">Driver / truck info</div><div class="v">${t.vehicleInfo || 'Not yet provided'}</div></div>
      </div>

      ${t.remarks ? `<div class="remarks-box">📝 ${t.remarks}</div>` : ''}
      ${o.delay && o.delay.active ? `<div class="remarks-box" style="background:#fde8e4; border-color:#f0b8ab; color:#8a2f1f;">⚠️ Delayed${o.delay.currentLocation ? ' at ' + o.delay.currentLocation : ''}${o.delay.reason ? ' — ' + o.delay.reason : ''}</div>` : ''}

      ${o.hasLiveGps ? '<div class="gps-live-badge">🟢 Live GPS — updating in real time</div>' : ''}
      ${renderFlowStepper(o.flow)}
      ${renderDocsBlock(o)}
      ${o.podStatus && o.podStatus !== 'pending' ? `<div class="remarks-box">📦 POD status: <b>${o.podStatus.charAt(0).toUpperCase() + o.podStatus.slice(1)}</b>${o.podRejectionReason ? ' — ' + o.podRejectionReason : ''}</div>` : ''}
      ${renderFeedbackBlock(o)}

      <div class="detail-section" style="margin-top:18px;">
        <h3 style="font-family:'Baloo 2', sans-serif; font-size:15px; margin-bottom:8px;">Trip Timeline</h3>
        <div id="trackingTimelineList"><p style="font-size:12.5px; color:#7a867e;">Loading trip history…</p></div>
      </div>

      <div class="updated-note">Last updated: ${t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'} — refreshes automatically.</div>
    `;

    renderMap(o);
    wireFeedbackForm(o);
    wireHistoryToggle(o);
    loadTrackingTimeline(o.tokenNo, o.loadStage);
    const delayRiskBtn = document.getElementById('delayRiskBtn');
    if (delayRiskBtn) delayRiskBtn.addEventListener('click', () => runDelayRiskCheck(o.tokenNo, delayRiskBtn));
  }

  // Chronological TrackingEvent history (spec section 19 "Load Details /
  // Tracking Page > Tracking") — fetched separately from the rest of the
  // detail payload since it's its own collection now (see
  // lib/opsModels.js TrackingEvent / GET /api/loads/:token/tracking).
  // Rendered through the shared LSTripTimeline component (public/assets/
  // trip-timeline.js) so the milestone ladder looks identical across every
  // role's UI — no docLinkFn passed here since evidence-photo URLs
  // currently route through an admin-only endpoint (see GPS_TRACKING_
  // SYSTEM-adjacent doc-access notes); a shipper viewer just won't see a
  // "View evidence" link on steps that have one, rather than a broken one.
  function loadTrackingTimeline(token, currentStage) {
    fetch('/api/loads/' + encodeURIComponent(token) + '/tracking')
      .then((r) => (r.ok ? r.json() : []))
      .then((events) => {
        const list = document.getElementById('trackingTimelineList');
        if (!list) return;
        if (window.LSTripTimeline) {
          LSTripTimeline.render(list, { currentStage, events: events || [] });
        } else {
          list.innerHTML = '<p style="font-size:12.5px; color:#7a867e;">No trip updates recorded yet.</p>';
        }
      })
      .catch(() => {
        const list = document.getElementById('trackingTimelineList');
        if (list) list.innerHTML = '<p style="font-size:12.5px; color:#7a867e;">Could not load trip history.</p>';
      });
  }

  // ---- Real interactive map (Leaflet + free OpenStreetMap tiles) ----
  // Shows actual pins for origin / current location / destination on a
  // real map, with a line connecting them — distinct from the text-based
  // route-line summary above, which stays as a quick-glance strip.
  //
  // This now delegates to the shared LSLiveMap module (public/assets/live-map.js)
  // instead of building its own Leaflet map inline, so this page and the
  // Admin Tracking page share one implementation, and so a live
  // 'tracking:location' push (see the socket handler above) can move the
  // marker in place via currentLiveMap.updateCurrent() without rebuilding
  // the whole map. A fresh LSLiveMap instance is created on every
  // renderDetail() call because renderDetail() replaces the whole panel's
  // innerHTML each time (poll refresh, order switch), which throws away
  // the previous #trackingMap DOM node — the old Leaflet instance is
  // explicitly torn down first via destroy().
  function buildLiveMeta(o) {
    const t = o.tracking || {};
    const g = o.liveGps || {};
    return {
      vehicleNumber: g.vehicleNumber || t.vehicleInfo || undefined,
      driverName: g.driverName || undefined,
      speedKph: g.speedKph,
      headingDeg: g.headingDeg,
      accuracy: g.accuracy,
      updatedAt: g.updatedAt || t.updatedAt,
      status: g.status || (o.hasLiveGps ? 'live' : 'not_active'),
    };
  }

  function renderMap(o) {
    const mapEl = document.getElementById('trackingMap');
    if (!mapEl) return;

    if (currentLiveMap) {
      currentLiveMap.destroy();
      currentLiveMap = null;
    }

    if (!window.LSLiveMap) {
      mapEl.innerHTML = '<div class="map-unavailable">Map library did not load.</div>';
      return;
    }

    currentLiveMap = window.LSLiveMap.create(mapEl);
    currentLiveMeta = buildLiveMeta(o);
    currentLiveMap.render(o.mapCoords, currentLiveMeta);
  }

  // ---- Bounded route-history view ----
  // Lazily fetches GET /api/orders/:token/tracking-history (already capped
  // server-side via gpsConfig's max/default point limits — see
  // server_load.js) the first time the shipper opens it, then draws it as
  // a separate polyline on the same live map via LSLiveMap.renderHistory().
  // Toggling closed/open again just shows/hides the already-fetched panel
  // instead of re-fetching every time.
  function wireHistoryToggle(o) {
    const btn = document.getElementById('toggleHistoryBtn');
    const panel = document.getElementById('historyPanel');
    if (!btn || !panel) return;
    let loaded = false;
    btn.addEventListener('click', () => {
      const isOpen = panel.style.display !== 'none';
      if (isOpen) {
        panel.style.display = 'none';
        btn.textContent = 'Show route history';
        return;
      }
      panel.style.display = 'block';
      btn.textContent = 'Hide route history';
      if (loaded) return;
      loaded = true;
      panel.innerHTML = '<div class="history-status">Loading route history…</div>';
      fetch('/api/orders/' + encodeURIComponent(o.tokenNo) + '/tracking-history?limit=300')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('request failed'))))
        .then((data) => {
          const points = (data && data.points) || [];
          if (!points.length) {
            panel.innerHTML = '<div class="history-status">No GPS history recorded for this trip yet.</div>';
            return;
          }
          const totalCount = data.totalCount != null ? data.totalCount : points.length;
          panel.innerHTML = '<div class="history-status">Showing ' + points.length + ' of ' + totalCount + ' recorded points' +
            (data.truncated ? ' — narrow the time range for more detail' : '') + '.</div>';
          if (currentLiveMap) currentLiveMap.renderHistory(points);
        })
        .catch(() => {
          panel.innerHTML = '<div class="history-status">Could not load route history.</div>';
        });
    });
  }

  function loadDetail(token, opts) {
    const showLoading = opts && opts.showLoading;
    if (showLoading) {
      detailPanel.innerHTML = '<div class="empty-state" style="box-shadow:none;"><span class="ls-spinner"></span> Loading tracking details…</div>';
    }
    joinLiveRoom(token);
    fetch('/api/tracking/order/' + encodeURIComponent(token))
      .then(res => {
        if (res.status === 401) { window.location.href = '/login/shipper'; return null; }
        return res.json();
      })
      .then(order => {
        if (!order) return;
        if (order.error) { detailPanel.innerHTML = '<div class="empty-state" style="box-shadow:none;">' + order.error + '</div>'; return; }
        renderDetail(order);
      })
      .catch(() => {
        detailPanel.innerHTML = '<div class="empty-state" style="box-shadow:none;">Could not load tracking details.</div>';
      });
  }

  function loadActive() {
    fetch('/api/tracking/my-active')
      .then(res => {
        if (res.status === 401) { window.location.href = '/login/shipper'; return null; }
        return res.json();
      })
      .then(orders => { if (orders) renderList(orders); })
      .catch(() => {
        listWrap.innerHTML = '<div class="empty-state">Could not load your bookings.</div>';
      });
  }

  function runSearch() {
    const tokenNo = document.getElementById('searchToken').value.trim();
    const from = document.getElementById('searchFrom').value.trim();
    const to = document.getElementById('searchTo').value.trim();
    if (!tokenNo && !from && !to) { loadActive(); return; }
    if (window.LS && LS.Track) {
      // Track that a search happened, and which fields were used — never
      // the actual search text itself.
      LS.Track.log('SEARCH_PERFORMED', 'SEARCH_PERFORMED', {
        byOrderNo: String(!!tokenNo), byFromCity: String(!!from), byToCity: String(!!to),
      });
    }
    const qs = new URLSearchParams();
    if (tokenNo) qs.set('tokenNo', tokenNo);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const searchStatus = document.getElementById('searchStatus');
    searchStatus.classList.add('show');
    fetch('/api/tracking/search?' + qs.toString())
      .then(res => res.json())
      .then(orders => {
        selectedToken = null;
        if (!orders.length) {
          listWrap.innerHTML = LS.noResultsHtml('No orders match your search.');
        } else {
          renderList(orders);
        }
      })
      .catch(() => {})
      .finally(() => searchStatus.classList.remove('show'));
  }

  document.getElementById('searchBtn').addEventListener('click', runSearch);
  document.getElementById('clearBtn').addEventListener('click', () => {
    document.getElementById('searchToken').value = '';
    document.getElementById('searchFrom').value = '';
    document.getElementById('searchTo').value = '';
    selectedToken = null;
    loadActive();
  });
  ['searchToken', 'searchFrom', 'searchTo'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  });

  // If arriving via a "Track this order" link with ?token=, jump straight
  // to that order's search-and-select — still going through the normal
  // active-bookings load so the token is highlighted in context.
  if (selectedToken) {
    document.getElementById('searchToken').value = selectedToken;
  }
  loadActive();

  // Poll every 12s so admin's manual tracking updates appear here without
  // the shipper needing to refresh the page.
  pollTimer = setInterval(() => {
    if (selectedToken) loadDetail(selectedToken);
    loadActive();
  }, 12000);
