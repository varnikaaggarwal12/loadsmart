  const ROLE_LABEL = { shipper: 'Shipper', carrier: 'Carrier', broker: 'Broker' };
  let state = { role: 'shipper', view: 'entities', entity: null, order: null };

  function escapeHtml(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function statusClass(s){ return String(s || '').replace(/[^a-zA-Z]/g, ''); }

  // ---- Live GPS push (Socket.IO) ----
  // Mirrors the shipper Live Tracking page (views/portal/live-tracking.js):
  // one room per Token No., a dedicated 'tracking:location' event moves
  // the existing map marker in place (LSLiveMap.updateCurrent()) with no
  // panel rebuild, while a 'load:update' carrying anything beyond a bare
  // `gps` key still triggers a full order re-fetch since those changes
  // (stage, POD, assignment, etc.) touch more of the panel than the map.
  let liveSocket = null;
  let joinedTrackingRoom = null;
  let currentLiveMap = null;
  let currentLiveMeta = {};
  if (typeof io === 'function') {
    liveSocket = io();
    liveSocket.on('load:update', (payload) => {
      if (!payload || !state.order || payload.tokenNo !== state.order.tokenNo) return;
      const otherKeys = Object.keys(payload).filter((k) => k !== 'tokenNo' && k !== 'gps');
      if (otherKeys.length === 0) return; // GPS-only push — 'tracking:location' already handles it
      openOrder(state.order.tokenNo);
    });
    liveSocket.on('tracking:location', (point) => {
      if (!point || !state.order || point.tokenNo !== state.order.tokenNo || !currentLiveMap) return;
      currentLiveMap.updateCurrent({ lat: point.lat, lon: point.lng }, {
        ...currentLiveMeta,
        speedKph: point.speedKph, headingDeg: point.headingDeg, accuracy: point.accuracy,
        updatedAt: point.updatedAt, status: 'live',
      });
      const note = document.getElementById('liveMapUpdatedNote');
      if (note) note.textContent = 'Last GPS update: ' + new Date(point.updatedAt || Date.now()).toLocaleString() + ' — live.';
    });
  }
  function joinTrackingRoom(tokenNo) {
    if (!liveSocket || !tokenNo || tokenNo === joinedTrackingRoom) return;
    joinedTrackingRoom = tokenNo;
    liveSocket.emit('join', { tokenNo });
  }

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

  function buildLiveMeta(o) {
    const t = o.tracking || {};
    const g = o.liveGps || {};
    return {
      vehicleNumber: g.vehicleNumber || t.vehicleInfo || undefined,
      speedKph: g.speedKph,
      headingDeg: g.headingDeg,
      accuracy: g.accuracy,
      updatedAt: g.updatedAt || t.updatedAt,
      status: g.status || (o.hasLiveGps ? 'live' : 'not_active'),
    };
  }

  // Delegates to the shared LSLiveMap module (public/assets/live-map.js) —
  // same map code the shipper Live Tracking page uses, so admin sees the
  // exact same live-updating truck marker instead of a separate/absent map.
  function renderLiveMap(o) {
    const mapEl = document.getElementById('adminTrackingMap');
    if (!mapEl) return;
    if (currentLiveMap) { currentLiveMap.destroy(); currentLiveMap = null; }
    if (!window.LSLiveMap) {
      mapEl.innerHTML = '<div class="map-unavailable">Map library did not load.</div>';
      return;
    }
    currentLiveMap = window.LSLiveMap.create(mapEl);
    currentLiveMeta = buildLiveMeta(o);
    currentLiveMap.render(o.mapCoords, currentLiveMeta);
  }

  function wireHistoryToggle(o) {
    const btn = document.getElementById('toggleHistoryBtn');
    const panel = document.getElementById('historyPanel');
    if (!btn || !panel) return;
    let loaded = false;
    btn.addEventListener('click', () => {
      const isOpen = panel.style.display !== 'none';
      if (isOpen) { panel.style.display = 'none'; btn.textContent = 'Show route history'; return; }
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
        .catch(() => { panel.innerHTML = '<div class="history-status">Could not load route history.</div>'; });
    });
  }

  // ---------- Overview stats ----------
  function loadOverview() {
    fetch('/api/admin/tracking/overview').then(r => r.json()).then(d => {
      document.getElementById('statShippers').textContent = d.shippers ?? '—';
      document.getElementById('statBrokers').textContent = d.brokers ?? '—';
      document.getElementById('statCarriers').textContent = d.carriers ?? '—';
      document.getElementById('statActive').textContent = d.activeOrders ?? '—';
    }).catch(() => {});
  }
  loadOverview();

  // ---------- Tabs ----------
  document.getElementById('roleTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state = { role: btn.getAttribute('data-role'), view: 'entities', entity: null, order: null };
    renderCrumbs();
    loadEntities('');
  });

  function renderCrumbs() {
    const crumbs = document.getElementById('crumbs');
    const parts = [`<span class="link" onclick="goEntities()">${ROLE_LABEL[state.role]}s</span>`];
    if (state.entity) parts.push(`<span class="link" onclick="goEntityDetail()">${escapeHtml(state.entity.companyName || state.entity.username)}</span>`);
    if (state.order) parts.push(`<span>${escapeHtml(state.order.tokenNo)}</span>`);
    crumbs.innerHTML = parts.join(' &nbsp;›&nbsp; ');
  }
  function goEntities() { state.view = 'entities'; state.entity = null; state.order = null; renderCrumbs(); loadEntities(''); }
  function goEntityDetail() { state.view = 'entityDetail'; state.order = null; renderCrumbs(); loadOrders('', '', ''); }
  window.goEntities = goEntities;
  window.goEntityDetail = goEntityDetail;

  // ---------- Step 1: entity list ----------
  function loadEntities(q) {
    const root = document.getElementById('viewRoot');
    root.innerHTML = `
      <div class="search-bar">
        <div class="ls-search-box">
          <span class="ls-search-icon">🔍</span>
          <input type="text" id="entitySearchInput" class="ls-search-input" placeholder="Search by username or company name…" value="${escapeHtml(q || '')}">
        </div>
        <button class="btn btn-primary" id="entitySearchBtn">Search</button>
      </div>
      <div class="ls-search-status" id="entitySearchStatus"><span class="ls-spinner"></span> Searching…</div>
      <div id="entityListWrap"><div class="empty-state">Loading…</div></div>
    `;
    document.getElementById('entitySearchBtn').addEventListener('click', () => {
      loadEntities(document.getElementById('entitySearchInput').value.trim());
    });
    document.getElementById('entitySearchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadEntities(e.target.value.trim());
    });

    const statusEl = document.getElementById('entitySearchStatus');
    statusEl.classList.add('show');
    fetch('/api/admin/tracking/' + state.role + '/search?q=' + encodeURIComponent(q || ''))
      .then(r => r.json())
      .then(records => {
        const wrap = document.getElementById('entityListWrap');
        if (!records.length) {
          wrap.innerHTML = q ? LS.noResultsHtml('No ' + state.role + 's found for "' + escapeHtml(q) + '".')
            : '<div class="empty-state">No ' + state.role + 's found yet.</div>';
          return;
        }
        wrap.innerHTML = '<div class="entity-list">' + records.map(r => `
          <div class="entity-card" data-username="${escapeHtml(r.username || '')}">
            <div class="name">${escapeHtml(r.companyName || r.contactPerson || r.username)}</div>
            <div class="meta">${escapeHtml(r.email || r.phoneNumber || '—')}</div>
            <span class="username">${escapeHtml(r.username || '—')}</span> ${r.username ? LS.copyBtnHtml(r.username) : ''}
          </div>
        `).join('') + '</div>';
        wrap.querySelectorAll('.entity-card').forEach((card, i) => {
          card.addEventListener('click', (e) => { if (!e.target.closest('.ls-copy-btn')) openEntity(records[i]); });
        });
      })
      .catch(() => { document.getElementById('entityListWrap').innerHTML = '<div class="empty-state">Could not load records.</div>'; })
      .finally(() => statusEl.classList.remove('show'));
  }

  // ---------- Step 2: entity detail + orders ----------
  function openEntity(record) {
    state.view = 'entityDetail';
    state.entity = record;
    state.order = null;
    renderCrumbs();
    loadOrders('', '', '');
  }

  function loadOrders(tokenNo, from, to) {
    const root = document.getElementById('viewRoot');
    const r = state.entity;
    root.innerHTML = `
      <div class="entity-detail-card">
        <div>
          <h2>${escapeHtml(r.companyName || r.contactPerson || r.username)}</h2>
          <div class="sub">${ROLE_LABEL[state.role]} · Username <b>${escapeHtml(r.username || '—')}</b> · ${escapeHtml(r.email || r.phoneNumber || '—')}</div>
        </div>
        <div class="rows">
          <div><b id="orderCountNum">—</b><span style="color:#7a867e;">Total orders</span></div>
        </div>
      </div>
      <div class="search-bar">
        <div class="ls-search-box">
          <span class="ls-search-icon">🔍</span>
          <input type="text" id="orderTokenInput" class="ls-search-input" placeholder="Search Token/Order No.…" value="${escapeHtml(tokenNo||'')}">
        </div>
        <div class="ls-search-box">
          <span class="ls-search-icon">🔍</span>
          <input type="text" id="orderFromInput" class="ls-search-input" placeholder="From city…" value="${escapeHtml(from||'')}">
        </div>
        <div class="ls-search-box">
          <span class="ls-search-icon">🔍</span>
          <input type="text" id="orderToInput" class="ls-search-input" placeholder="To city…" value="${escapeHtml(to||'')}">
        </div>
        <button class="btn btn-primary" id="orderSearchBtn">Search</button>
        <button class="btn btn-ghost" id="backToEntitiesBtn">← Back</button>
      </div>
      <div class="ls-search-status" id="orderSearchStatus"><span class="ls-spinner"></span> Searching…</div>
      <div id="orderListWrap"><div class="empty-state">Loading…</div></div>
    `;
    document.getElementById('backToEntitiesBtn').addEventListener('click', goEntities);
    const runOrderSearch = () => loadOrders(
      document.getElementById('orderTokenInput').value.trim(),
      document.getElementById('orderFromInput').value.trim(),
      document.getElementById('orderToInput').value.trim()
    );
    document.getElementById('orderSearchBtn').addEventListener('click', runOrderSearch);
    ['orderTokenInput','orderFromInput','orderToInput'].forEach(id => {
      document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') runOrderSearch(); });
    });

    const qs = new URLSearchParams();
    if (tokenNo) qs.set('tokenNo', tokenNo);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);

    const orderStatusEl = document.getElementById('orderSearchStatus');
    orderStatusEl.classList.add('show');
    fetch('/api/admin/tracking/' + state.role + '/' + encodeURIComponent(r.username) + '/orders?' + qs.toString())
      .then(res => res.json())
      .then(orders => {
        document.getElementById('orderCountNum').textContent = orders.length;
        const wrap = document.getElementById('orderListWrap');
        if (!orders.length) {
          wrap.innerHTML = (tokenNo||from||to)
            ? LS.noResultsHtml('No orders match your search for this ' + state.role + '.')
            : '<div class="empty-state">No orders found for this ' + state.role + ' yet.</div>';
          return;
        }
        wrap.innerHTML = `<div class="order-table-wrap"><table>
          <thead><tr><th>Token No.</th><th>Route</th><th>Kind</th><th>Booking status</th><th>Tracking status</th><th>Created</th></tr></thead>
          <tbody>${orders.map((o,i) => `
            <tr data-idx="${i}">
              <td><span class="token-badge">${escapeHtml(o.tokenNo || '—')}</span> ${o.tokenNo ? LS.copyBtnHtml(o.tokenNo) : ''}</td>
              <td>${escapeHtml(o.pickup || '—')} → ${escapeHtml(o.destination || '—')}</td>
              <td>${o.kind === 'booking' ? 'Booking' : 'Rate request'}</td>
              <td>${escapeHtml(o.status || 'pending')}</td>
              <td><span class="status-pill ${statusClass(o.tracking && o.tracking.status)}">${escapeHtml((o.tracking && o.tracking.status) || 'Booked')}</span></td>
              <td>${o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '—'}</td>
            </tr>
          `).join('')}</tbody>
        </table></div>`;
        wrap.querySelectorAll('tbody tr').forEach((row, i) => {
          row.addEventListener('click', () => openOrder(orders[i].tokenNo));
        });
      })
      .catch(() => { document.getElementById('orderListWrap').innerHTML = '<div class="empty-state">Could not load orders.</div>'; });
  }

  // ---------- Step 3: order detail + manual update ----------
  function openOrder(tokenNo) {
    fetch('/api/admin/tracking/order/' + encodeURIComponent(tokenNo))
      .then(r => r.json())
      .then(order => {
        if (order.error) { alert(order.error); return; }
        state.view = 'orderDetail';
        state.order = order;
        renderCrumbs();
        renderOrderDetail(order);
      })
      .catch(() => alert('Could not load order details.'));
  }

  function renderOrderDetail(o) {
    const t = o.tracking || {};
    const root = document.getElementById('viewRoot');
    root.innerHTML = `
      <div class="search-bar" style="margin-bottom:16px;">
        <button class="btn btn-ghost" id="backToOrdersBtn">← Back to orders</button>
      </div>
      ${renderFlowStepperHtml(o.flow)}
      <div class="order-detail-grid">
        <div class="panel">
          <h2>Order details — ${escapeHtml(o.tokenNo)} ${LS.copyBtnHtml(o.tokenNo)}</h2>
          <div class="info-row"><span class="k">Shipper</span><span class="v">${escapeHtml(o.companyName || o.shipperUsername || '—')}</span></div>
          <div class="info-row"><span class="k">Route</span><span class="v">${escapeHtml(o.pickup || '—')} → ${escapeHtml(o.destination || '—')}</span></div>
          <div class="info-row"><span class="k">Material</span><span class="v">${escapeHtml(o.material || '—')}</span></div>
          <div class="info-row"><span class="k">Weight</span><span class="v">${o.weight != null ? o.weight + ' tons' : '—'}</span></div>
          <div class="info-row"><span class="k">Distance</span><span class="v">${o.distanceKm != null ? o.distanceKm + ' km' : '—'}</span></div>
          <div class="info-row"><span class="k">Booking status</span><span class="v">${escapeHtml(o.status || 'pending')}</span></div>
          <div class="info-row"><span class="k">Carrier assigned</span><span class="v">${escapeHtml(o.carrierCompanyName || 'Not yet assigned')}</span></div>
          <div class="info-row"><span class="k">Broker assigned</span><span class="v">${escapeHtml(o.brokerCompanyName || 'Not yet assigned')}</span></div>
          <div class="info-row"><span class="k">Current tracking status</span><span class="v"><span class="status-pill ${statusClass(t.status)}">${escapeHtml(t.status || 'Booked')}</span></span></div>
          <div class="info-row"><span class="k">Current location</span><span class="v">${escapeHtml(t.currentLocation || '—')}</span></div>
          <div class="info-row"><span class="k">Progress</span><span class="v">${t.progressPercent != null ? t.progressPercent + '%' : '0%'}</span></div>
          <div class="info-row"><span class="k">Remarks</span><span class="v">${escapeHtml(t.remarks || '—')}</span></div>
          <div class="info-row"><span class="k">Driver / truck info</span><span class="v">${escapeHtml(t.vehicleInfo || '—')}</span></div>
          <div class="info-row"><span class="k">Last updated</span><span class="v">${t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}</span></div>
          ${delayRiskButtonHtml(o)}
        </div>

        <div class="panel">
          <h2>Manual tracking update</h2>
          <div class="form-row">
            <div class="form-field">
              <label>Current location / city</label>
              <input type="text" id="fLocation" value="${escapeHtml(t.currentLocation || '')}">
            </div>
            <div class="form-field">
              <label>Progress (%)</label>
              <input type="number" id="fProgress" min="0" max="100" value="${t.progressPercent != null ? t.progressPercent : 0}">
            </div>
          </div>
          <div class="form-field">
            <label>Status</label>
            <select id="fStatus">
              ${['Booked','Confirmed','Picked Up','In Transit','Out for Delivery','Delayed','Delivered'].map(s =>
                `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-field">
            <label>Destination</label>
            <input type="text" id="fDestination" value="${escapeHtml(o.destination || '')}">
          </div>
          <div class="form-field">
            <label>Driver / truck info</label>
            <input type="text" id="fVehicleInfo" placeholder="e.g. Truck DL01AB1234, Driver: Ramesh (98765xxxxx)" value="${escapeHtml(t.vehicleInfo || '')}">
          </div>
          <div class="form-field">
            <label>Tracking remarks</label>
            <textarea id="fRemarks">${escapeHtml(t.remarks || '')}</textarea>
          </div>
          <div class="form-row">
            <div class="form-field">
              <label>Assign carrier</label>
              <select id="fCarrier"><option value="">Loading…</option></select>
            </div>
            <div class="form-field">
              <label>Assign broker</label>
              <select id="fBroker"><option value="">Loading…</option></select>
            </div>
          </div>
          <button class="btn btn-primary" id="saveUpdateBtn">Save tracking update</button>
          <div class="save-msg" id="saveMsg"></div>
        </div>

        <div class="panel" style="grid-column:1 / -1;">
          <h2>Live GPS map</h2>
          <div id="adminTrackingMap" class="tracking-map"></div>
          <div class="map-toolbar">
            ${liveStatusBadge(o.liveGps)}
            <button type="button" class="ls-btn-link" id="toggleHistoryBtn">Show route history</button>
          </div>
          <div id="historyPanel" style="display:none;"></div>
          <div class="history-status" id="liveMapUpdatedNote">${o.liveGps && o.liveGps.updatedAt ? 'Last GPS update: ' + new Date(o.liveGps.updatedAt).toLocaleString() + '.' : 'No GPS update received yet for this trip.'}</div>
        </div>

        <div class="panel" style="grid-column:1 / -1;">
          <h2>Trip Timeline</h2>
          <div id="tripTimeline"><p class="history-status">Loading trip history…</p></div>
        </div>

        <div class="panel" style="grid-column:1 / -1;">
          <h2>Documents — Load Invoice, Transport Invoice &amp; POD</h2>
          ${renderDocsPanelHtml(o)}
        </div>
      </div>
    `;

    document.getElementById('backToOrdersBtn').addEventListener('click', goEntityDetail);
    const delayRiskBtn = document.getElementById('delayRiskBtn');
    if (delayRiskBtn) delayRiskBtn.addEventListener('click', () => runDelayRiskCheck(o.tokenNo, delayRiskBtn));
    populateAssignmentSelect('carrier', 'fCarrier', o.carrierUsername);
    populateAssignmentSelect('broker', 'fBroker', o.brokerUsername);
    document.getElementById('saveUpdateBtn').addEventListener('click', () => saveUpdate(o.tokenNo));
    wireDocsPanelActions(o);
    renderLiveMap(o);
    wireHistoryToggle(o);
    loadTripTimeline(o);
    joinTrackingRoom(o.tokenNo);
  }

  // Admin can see attached evidence photos (checkpoint/delay/POD-adjacent
  // photoPath values currently all route through the admin-only
  // /admin/kyc-photo/:filename endpoint) — append the admin bearer token as
  // a query param since a plain <a href> click doesn't carry the
  // auth.js-patched fetch() Authorization header (same pattern as the
  // shipper/carrier portals' userDocUrl() helper).
  function adminDocUrl(path) {
    let token = '';
    try { token = sessionStorage.getItem('ls_admin_token') || ''; } catch (e) { /* ignore */ }
    if (!token || !path) return path;
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
  }

  function loadTripTimeline(o) {
    fetch('/api/loads/' + encodeURIComponent(o.tokenNo) + '/tracking')
      .then((r) => (r.ok ? r.json() : []))
      .then((events) => {
        const el = document.getElementById('tripTimeline');
        if (!el) return;
        if (window.LSTripTimeline) {
          LSTripTimeline.render(el, { currentStage: o.loadStage, events: events || [], docLinkFn: adminDocUrl });
        } else {
          el.innerHTML = '<p class="history-status">No trip updates recorded yet.</p>';
        }
      })
      .catch(() => {
        const el = document.getElementById('tripTimeline');
        if (el) el.innerHTML = '<p class="history-status">Could not load trip history.</p>';
      });
  }

  function withAdminTokenDoc(url) {
    let token = '';
    try { token = sessionStorage.getItem('ls_admin_token') || ''; } catch (e) { /* ignore */ }
    if (!token) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
  }

  // ---------- AI Delay Risk ----------
  const DELAY_RISK_STAGES = ['ASSIGNED', 'DRIVER_ACCEPTED', 'ARRIVED_PICKUP', 'LOADING', 'LOADED', 'DEPARTED_PICKUP', 'IN_TRANSIT', 'REACHED_DESTINATION', 'UNLOADING', 'UNLOADING_COMPLETE'];
  let delayRiskCache = {}; // keyed by tokenNo — survives the panel being rebuilt by GPS/status pushes
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
    fetch('/api/admin/ai/delay-risk/' + encodeURIComponent(tokenNo), { method: 'POST' })
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

  function renderFlowStepperHtml(flow) {
    if (!flow || !flow.steps) return '';
    return '<div class="flow-stepper" style="margin-bottom:16px;">' + flow.steps.map((s, i) => {
      const cls = i === flow.currentIndex ? 'flow-step current' : (s.done ? 'flow-step done' : 'flow-step');
      return `<span class="${cls}"><span class="dot"></span>${escapeHtml(s.label)}</span>`;
    }).join('') + '</div>';
  }

  function renderDocsPanelHtml(o) {
    const loadInvoiceRow = `<div class="doc-row"><span class="k">Load Invoice</span>${
      o.loadInvoicePath
        ? `<a href="${withAdminTokenDoc('/api/orders/' + encodeURIComponent(o.tokenNo) + '/document/load-invoice')}" target="_blank" rel="noopener" class="doc-link">📄 View</a>`
        : `<span class="doc-chip pending">Not generated yet</span>`
    }</div>`;
    const shipperInvoiceRow = `<div class="doc-row"><span class="k">Shipper-Uploaded Invoice</span>${
      o.invoicePath
        ? `<a href="${withAdminTokenDoc(o.invoicePath)}" target="_blank" rel="noopener" class="doc-link">📄 View</a>` +
          (o.invoiceVerified ? '<span class="doc-chip verified">✓ Verified</span>' : '<span class="doc-chip pending">Awaiting review</span>')
        : `<span class="doc-chip missing">Not uploaded yet</span>`
    }</div>`;
    const transportInvoiceRow = `<div class="doc-row"><span class="k">Transport Invoice</span>${
      o.transportInvoicePath
        ? `<a href="${withAdminTokenDoc('/api/orders/' + encodeURIComponent(o.tokenNo) + '/document/transport-invoice')}" target="_blank" rel="noopener" class="doc-link">📄 View</a>`
        : `<span class="doc-chip pending">Generated automatically after POD is uploaded</span>`
    }</div>`;
    const podActionsDisabled = !o.podPath;
    const podRow = `<div class="doc-row">
        <span class="k">Proof of Delivery</span>
        ${o.podPath
          ? `<a href="${withAdminTokenDoc('/api/orders/' + encodeURIComponent(o.tokenNo) + '/document/pod')}" target="_blank" rel="noopener" class="doc-link">📄 View POD</a>` +
            (o.podVerified ? '<span class="doc-chip verified">✓ Verified</span>' : '<span class="doc-chip pending">Awaiting review</span>')
          : '<span class="doc-chip missing">Not uploaded by carrier yet</span>'}
        <span class="pod-verify-actions">
          <button type="button" class="accept" id="podVerifyBtn" ${podActionsDisabled || o.podVerified ? 'disabled' : ''}>Mark POD Verified</button>
          <button type="button" class="reject" id="podRejectBtn" ${podActionsDisabled ? 'disabled' : ''}>Reject POD</button>
        </span>
      </div>`;
    const podAiRow = renderPodAiCheckHtml(o.podAiCheck);
    return loadInvoiceRow + shipperInvoiceRow + transportInvoiceRow + podRow + podAiRow;
  }

  // ---------- POD AI pre-check (read-only) ----------
  // Ran automatically server-side the moment the carrier uploaded the POD
  // photo — this only ever DISPLAYS whatever the server already computed
  // (see toTrackingSummary's podAiCheck shaping in server_load.js); nothing
  // here fetches or triggers anything. null (not checked / AI not
  // configured / not yet run) renders nothing at all.
  function renderPodAiCheckHtml(check) {
    if (!check) return '';
    if (check.looksValid) {
      return `<div class="ai-pod-note valid">✅ AI pre-check: looks valid — ${escapeHtml(check.summary || '')}</div>`;
    }
    return `<div class="ai-pod-note flagged">⚠️ AI pre-check flagged this — ${escapeHtml(check.summary || '')}
      ${check.concerns && check.concerns.length ? '<ul class="ai-concerns-list">' + check.concerns.map(c => '<li>' + escapeHtml(c) + '</li>').join('') + '</ul>' : ''}
    </div>`;
  }

  function wireDocsPanelActions(o) {
    const verifyBtn = document.getElementById('podVerifyBtn');
    const rejectBtn = document.getElementById('podRejectBtn');
    if (verifyBtn) verifyBtn.addEventListener('click', () => setPodVerification(o.tokenNo, true));
    if (rejectBtn) rejectBtn.addEventListener('click', () => {
      const reason = prompt('Reason for rejecting this POD:');
      if (reason === null) return; // cancelled
      setPodVerification(o.tokenNo, false, reason);
    });
  }

  function setPodVerification(tokenNo, valid, reason) {
    fetch('/api/admin/tracking/order/' + encodeURIComponent(tokenNo) + '/verify-pod', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valid, reason }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not update POD verification.');
        return d;
      })
      .then((d) => {
        state.order = { ...state.order, podVerified: d.podVerified, podRejectionReason: d.podRejectionReason };
        renderOrderDetail(state.order);
        if (window.LS && LS.showSuccess) LS.showSuccess(valid ? 'POD marked verified!' : 'POD rejected.');
      })
      .catch((err) => alert(err.message));
  }

  function populateAssignmentSelect(role, selectId, currentUsername) {
    fetch('/api/admin/tracking/' + role + '/search?q=')
      .then(r => r.json())
      .then(records => {
        const sel = document.getElementById(selectId);
        const options = ['<option value="">— Not assigned —</option>']
          .concat(records.map(r => `<option value="${escapeHtml(r.username)}" ${r.username === currentUsername ? 'selected' : ''}>${escapeHtml(r.companyName || r.contactPerson || r.username)} (${escapeHtml(r.username)})</option>`));
        sel.innerHTML = options.join('');
      })
      .catch(() => { document.getElementById(selectId).innerHTML = '<option value="">Could not load list</option>'; });
  }

  function saveUpdate(tokenNo) {
    const btn = document.getElementById('saveUpdateBtn');
    const msg = document.getElementById('saveMsg');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const payload = {
      currentLocation: document.getElementById('fLocation').value,
      status: document.getElementById('fStatus').value,
      progressPercent: document.getElementById('fProgress').value,
      destination: document.getElementById('fDestination').value,
      remarks: document.getElementById('fRemarks').value,
      vehicleInfo: document.getElementById('fVehicleInfo').value,
      carrierUsername: document.getElementById('fCarrier').value,
      brokerUsername: document.getElementById('fBroker').value,
    };
    fetch('/api/admin/tracking/order/' + encodeURIComponent(tokenNo) + '/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not save the update.');
        return d;
      })
      .then(order => {
        state.order = order;
        msg.textContent = "Tracking update saved — it is now visible on the shipper's Live Tracking dashboard.";
        msg.className = 'save-msg ok';
        msg.style.display = 'block';
        renderOrderDetail(order);
        showTrackingUpdatePopup(order);
      })
      .catch(err => {
        msg.textContent = err.message;
        msg.className = 'save-msg err';
        msg.style.display = 'block';
        showTrackingUpdateFailedPopup(err.message);
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = 'Save tracking update';
      });
  }

  // ---------- Tracking update confirmation popup ----------
  function showTrackingUpdatePopup(order) {
    const t = order.tracking || {};
    document.getElementById('tuModalBox').className = 'tu-modal-box ok';
    document.getElementById('tuModalIcon').textContent = '✓';
    document.getElementById('tuModalTitle').textContent = 'Tracking Updated Successfully';
    document.getElementById('tuModalMessage').style.display = 'none';
    const rows = document.getElementById('tuModalRows');
    rows.style.display = 'block';
    rows.innerHTML = `
      <div class="row"><span class="k">Token</span><span class="v">${escapeHtml(order.tokenNo)}</span></div>
      <div class="row"><span class="k">Status</span><span class="v">${escapeHtml(t.status || 'Booked')}</span></div>
      <div class="row"><span class="k">Current Location</span><span class="v">${escapeHtml(t.currentLocation || '—')}</span></div>
      <div class="row"><span class="k">Destination</span><span class="v">${escapeHtml(order.destination || '—')}</span></div>
      <div class="row"><span class="k">Last Updated</span><span class="v">${t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}</span></div>
    `;
    document.getElementById('tuModalOverlay').classList.add('show');
  }

  function showTrackingUpdateFailedPopup(errorMessage) {
    document.getElementById('tuModalBox').className = 'tu-modal-box err';
    document.getElementById('tuModalIcon').textContent = '✕';
    document.getElementById('tuModalTitle').textContent = 'Tracking Update Failed';
    document.getElementById('tuModalRows').style.display = 'none';
    const msgEl = document.getElementById('tuModalMessage');
    msgEl.style.display = 'block';
    msgEl.textContent = errorMessage || 'Something went wrong while saving the update. Please try again.';
    document.getElementById('tuModalOverlay').classList.add('show');
  }

  document.getElementById('tuModalCloseBtn').addEventListener('click', () => {
    document.getElementById('tuModalOverlay').classList.remove('show');
  });
  document.getElementById('tuModalOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('tuModalOverlay')) {
      document.getElementById('tuModalOverlay').classList.remove('show');
    }
  });

  // ---------- Initial load ----------
  renderCrumbs();
  loadEntities('');
