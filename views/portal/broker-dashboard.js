/**
 * views/portal/broker-dashboard.js
 * Broker Portal dashboard — real API data only. Every fetch() call here goes
 * through window.fetch, which /assets/auth.js has already patched to attach
 * "Authorization: Bearer <ls_user_token>" and to bounce to /login/broker on
 * a 401 — this file never touches tokens directly.
 */
(function () {
  'use strict';

  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function fmtInr(n) {
    if (n === null || n === undefined || n === '') return '—';
    return '₹' + Number(n).toLocaleString('en-IN');
  }
  function toast(msg) {
    const el = document.getElementById('lsToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3200);
  }
  function myDocUrl(storedPath) {
    // Stored doc paths are either the new permanent GridFS format
    // (/api/files/<fileId> — already an ownership-checked route, used as
    //-is) or the legacy on-disk format (/admin/kyc-photo/<filename>,
    // admin-only) — a broker views their OWN legacy document through the
    // ownership-checked /api/my-documents/<filename> route instead (same
    // filename). Either way, the request needs this tab's own bearer token
    // attached as ?token=, since a plain <a href> navigation can't send an
    // Authorization header the way fetch() can (this was previously
    // missing here, making every document link 401).
    if (!storedPath) return '';
    let token = '';
    try { token = sessionStorage.getItem('ls_user_token') || ''; } catch (e) { /* ignore */ }
    const base = /^\/api\/files\//.test(storedPath)
      ? storedPath
      : '/api/my-documents/' + String(storedPath).split('/').pop();
    return base + (token ? (base.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token) : '');
  }

  // ---------------- Theme toggle ----------------
  (function initTheme() {
    const KEY = 'ls_theme';
    function apply(theme) {
      document.body.classList.toggle('dark-mode', theme === 'dark');
      const icon = document.getElementById('themeIcon');
      const label = document.getElementById('themeLabel');
      if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
      if (label) label.textContent = theme === 'dark' ? 'Light' : 'Dark';
    }
    apply(localStorage.getItem(KEY) || 'light');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', () => {
      const next = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
      apply(next);
    });
  })();

  document.getElementById('logoutBtn').addEventListener('click', () => LS.Auth.logoutUser('broker'));
  if (window.LSNotifBell) LSNotifBell.init({ tokenKey: 'ls_user_token', mountSelector: '#notifBellMount' });

  // ---------------- Tabs ----------------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('panel-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
      if (btn.dataset.tab === 'matching' && !matchingLoadedOnce) loadMatchingTab();
      if (btn.dataset.tab === 'loads' && !loadsLoadedOnce) loadLoads();
      if (btn.dataset.tab === 'loads') loadMyPostedLoads();
      if (btn.dataset.tab === 'automation' && !automationLoadedOnce) loadAutomation();
      if (btn.dataset.tab === 'automation') { searchCarrierConnectCards(); loadMyCarrierConnections(); }
      if (btn.dataset.tab === 'bids' && !bidsLoadedOnce) loadBids();
      if (btn.dataset.tab === 'shipments' && !shipmentsLoadedOnce) loadShipments();
      if (btn.dataset.tab === 'kyc' && !kycLoadedOnce) loadKyc();
      if (btn.dataset.tab === 'assistant' && !aiStatusCheckedOnce) checkAiStatus();
      if (btn.dataset.tab === 'profile' && !profileLoadedOnce) loadProfileForm();
    });
  });

  // ================= Decorative "Logistics Market Network" background =================
  // Connected shipper/broker/carrier nodes with animated bid signals, moving
  // route particles, load pulses and network lines. Purely decorative
  // (pointer-events:none via CSS) and disabled entirely when the visitor
  // prefers reduced motion.
  (function initNetworkBackground() {
    const canvas = document.getElementById('lsNetworkCanvas');
    if (!canvas) return;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;
    const ctx = canvas.getContext('2d');
    let w, h, nodes = [], links = [], particles = [];
    const NODE_TYPES = ['shipper', 'broker', 'carrier'];
    const COLORS = { shipper: '#0e3a24', broker: '#e8722c', carrier: '#12492e', line: 'rgba(23,37,29,0.18)' };

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }
    function buildNetwork() {
      const count = Math.max(14, Math.min(28, Math.floor((w * h) / 65000)));
      nodes = [];
      for (let i = 0; i < count; i++) {
        nodes.push({
          x: Math.random() * w, y: Math.random() * h,
          type: NODE_TYPES[i % 3], r: 2.6 + Math.random() * 2.2,
          pulse: Math.random() * Math.PI * 2,
        });
      }
      links = [];
      for (let i = 0; i < nodes.length; i++) {
        let nearest = null, best = Infinity;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          const dist = dx * dx + dy * dy;
          if (dist < best) { best = dist; nearest = j; }
        }
        if (nearest !== null) links.push([i, nearest]);
      }
      // A handful of extra cross-links so it reads as a network, not a tree.
      for (let k = 0; k < Math.floor(nodes.length / 2); k++) {
        const a = Math.floor(Math.random() * nodes.length);
        const b = Math.floor(Math.random() * nodes.length);
        if (a !== b) links.push([a, b]);
      }
      particles = links.slice(0, Math.floor(links.length / 2)).map(([a, b]) => ({
        a, b, t: Math.random(), speed: 0.0025 + Math.random() * 0.004,
      }));
    }
    resize();
    buildNetwork();
    window.addEventListener('resize', () => { resize(); buildNetwork(); });

    function draw() {
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      ctx.strokeStyle = COLORS.line;
      links.forEach(([a, b]) => {
        ctx.beginPath();
        ctx.moveTo(nodes[a].x, nodes[a].y);
        ctx.lineTo(nodes[b].x, nodes[b].y);
        ctx.stroke();
      });
      // Moving "bid signal" / route particles travelling along network lines.
      particles.forEach((p) => {
        p.t += p.speed;
        if (p.t > 1) p.t = 0;
        const na = nodes[p.a], nb = nodes[p.b];
        const x = na.x + (nb.x - na.x) * p.t;
        const y = na.y + (nb.y - na.y) * p.t;
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.broker;
        ctx.fill();
      });
      // Nodes with a soft "load pulse".
      nodes.forEach((n) => {
        n.pulse += 0.02;
        const pulseR = n.r + Math.sin(n.pulse) * 1.4;
        ctx.beginPath();
        ctx.arc(n.x, n.y, pulseR, 0, Math.PI * 2);
        ctx.fillStyle = COLORS[n.type];
        ctx.globalAlpha = 0.75;
        ctx.fill();
        ctx.globalAlpha = 1;
      });
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  })();

  // ================= Overview =================
  function renderCards(cards) {
    const grid = document.getElementById('cardsGrid');
    const items = [
      { label: 'Total loads handled', value: cards.totalLoadsHandled },
      { label: 'Active loads', value: cards.activeLoads },
      { label: 'Pending requests', value: cards.pendingRequests },
      { label: 'Accepted loads', value: cards.acceptedLoads },
      { label: 'Completed loads', value: cards.completedLoads },
      {
        label: 'Total brokerage / commission',
        value: cards.totalBrokerageCommission === null ? '—' : fmtInr(cards.totalBrokerageCommission),
        note: cards.totalBrokerageCommissionNote,
      },
      { label: 'KYC status', value: cards.kycStatus, warn: cards.kycStatus !== 'APPROVED' },
      {
        label: 'Reliability score',
        value: cards.reliabilityScore === null ? '—' : cards.reliabilityScore + '%',
        note: cards.reliabilityNote,
      },
    ];
    grid.innerHTML = items.map((c) => `
      <div class="stat-card ${c.warn ? 'warn' : ''}">
        <div class="label">${escapeHtml(c.label)}</div>
        <div class="value">${escapeHtml(String(c.value ?? '0'))}</div>
        ${c.note ? `<div class="note">${escapeHtml(c.note)}</div>` : ''}
      </div>`).join('');
  }

  function renderOpportunities(dash) {
    const wrap = document.getElementById('opportunityList');
    if (!dash.opportunities || !dash.opportunities.length) {
      wrap.innerHTML = `<div class="empty-state">${dash.preferencesConfigured ? 'No matching loads right now — check back soon.' : 'No data yet. Set your preferred routes and truck types in Profile to personalize this list — showing general open loads for now.'}</div>`;
      return;
    }
    wrap.innerHTML = dash.opportunities.map((o) => `
      <div class="opportunity-item">
        <span class="score-badge">${escapeHtml(String(o.score))}</span>
        <div class="route">${escapeHtml(o.pickup || '—')} → ${escapeHtml(o.destination || '—')}</div>
        <div class="meta">Token ${escapeHtml(o.tokenNo)} · ${escapeHtml(o.material || 'Material n/a')} · ${escapeHtml(String(o.weight || '—'))} kg · ${escapeHtml(o.requiredTruckType || '—')}</div>
        ${o.reasons && o.reasons.length ? `<ul class="reasons">${o.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
      </div>`).join('');
  }

  function renderRisk(list) {
    const wrap = document.getElementById('riskList');
    if (!list || !list.length) {
      wrap.innerHTML = '<div class="risk-item ok">✅ Nothing needs your attention right now.</div>';
      return;
    }
    wrap.innerHTML = list.map((r) => {
      const ok = r.key === 'ALL_CLEAR';
      const icon = ok ? '✅' : (r.severity === 'warning' ? '⚠️' : 'ℹ️');
      return `<div class="risk-item ${ok ? 'ok' : ''}">${icon} <div>${escapeHtml(r.message)}</div></div>`;
    }).join('');
  }

  function renderTimeline(items) {
    const wrap = document.getElementById('timelineList');
    if (!items || !items.length) {
      wrap.innerHTML = '<div class="empty-state">No activity yet.</div>';
      return;
    }
    wrap.innerHTML = items.map((t) => `
      <div class="timeline-item">
        <span class="dot"></span>
        <div>
          <div class="t">${escapeHtml(fmtDateTime(t.at))}</div>
          <div class="l">${escapeHtml(t.label || '')}</div>
          ${t.detail ? `<div class="d">${escapeHtml(t.detail)}</div>` : ''}
        </div>
      </div>`).join('');
  }

  let lastDashboard = null;
  function loadDashboard() {
    fetch('/api/broker/dashboard').then((r) => r.json()).then((data) => {
      if (data.error) { toast(data.error); return; }
      lastDashboard = data;
      renderCards(data.cards);
      renderOpportunities(data);
      renderRisk(data.riskIndicators);
      renderTimeline(data.timeline);
      const banner = document.getElementById('kycBanner');
      if (data.cards.kycStatus !== 'APPROVED') {
        banner.textContent = `Your KYC status is ${data.cards.kycStatus}. ${data.cards.kycStatus === 'DRAFT' ? 'Finish and submit your KYC documents to unlock bidding.' : 'You will be able to submit bids once admin approves your KYC.'}`;
      } else {
        banner.textContent = 'Your account is fully verified — you can submit bids on available loads.';
      }
    }).catch(() => toast('Could not load your dashboard right now.'));
  }
  fetch('/api/broker/profile').then((r) => r.json()).then((rec) => {
    if (rec && !rec.error) {
      document.getElementById('welcomeHeading').textContent = 'Welcome back, ' + (rec.companyName || rec.contactPerson || rec.username);
    }
  }).catch(() => {});
  loadDashboard();

  // ================= Load Board =================
  let loadsLoadedOnce = false;
  function currentFilters() {
    const q = new URLSearchParams();
    const map = {
      filterOrigin: 'origin', filterDestination: 'destination', filterTruckType: 'truckType',
      filterMinWeight: 'minWeight', filterMaxWeight: 'maxWeight', filterFromDate: 'fromDate', filterToDate: 'toDate',
    };
    Object.keys(map).forEach((id) => {
      const v = document.getElementById(id).value;
      if (v) q.set(map[id], v);
    });
    return q.toString();
  }
  function loadLoads() {
    loadsLoadedOnce = true;
    const wrap = document.getElementById('loadsList');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading available loads…</div>';
    fetch('/api/broker/loads?' + currentFilters()).then((r) => r.json()).then((loads) => {
      if (loads.error) { document.getElementById('loadsError').textContent = loads.error; wrap.innerHTML = ''; return; }
      document.getElementById('loadsError').textContent = '';
      if (!loads.length) { wrap.innerHTML = '<div class="empty-state">No open loads match your filters right now.</div>'; return; }
      wrap.innerHTML = loads.map((l) => `
        <div class="load-card">
          <div class="route">${escapeHtml(l.pickup)} → ${escapeHtml(l.destination)}</div>
          <div class="meta">
            Token ${escapeHtml(l.tokenNo)} · ${escapeHtml(l.material || '—')} · ${escapeHtml(String(l.weight || '—'))} kg<br>
            Truck: ${escapeHtml(l.requiredTruckType || '—')} ${escapeHtml(l.requiredBodyType || '')}<br>
            Pickup: ${escapeHtml(fmtDate(l.pickupDateTime))} · Bidding closes: ${escapeHtml(fmtDateTime(l.biddingDeadline))}
            ${l.biddingExpired ? '<br><span class="badge REJECTED">Bidding closed</span>' : ''}
            ${l.myBid ? `<br><span class="badge ${escapeHtml(l.myBid.status)}">Your bid: ${escapeHtml(l.myBid.status)}</span>` : ''}
          </div>
          <div class="actions">
            <button type="button" class="btn-secondary" data-view="${escapeHtml(l.tokenNo)}">View details</button>
            ${!l.myBid && !l.biddingExpired ? `<button type="button" class="btn-primary" data-bid="${escapeHtml(l.tokenNo)}">Submit bid</button>` : ''}
          </div>
        </div>`).join('');
      wrap.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openLoadDetail(b.dataset.view)));
      wrap.querySelectorAll('[data-bid]').forEach((b) => b.addEventListener('click', () => openBidModal(b.dataset.bid)));
    }).catch(() => { wrap.innerHTML = ''; document.getElementById('loadsError').textContent = 'Could not load available loads right now.'; });
  }
  document.getElementById('applyFiltersBtn').addEventListener('click', loadLoads);
  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    ['filterOrigin', 'filterDestination', 'filterTruckType', 'filterMinWeight', 'filterMaxWeight', 'filterFromDate', 'filterToDate']
      .forEach((id) => { document.getElementById(id).value = ''; });
    loadLoads();
  });

  function openLoadDetail(token) {
    const modal = document.getElementById('loadDetailModal');
    const body = document.getElementById('loadDetailBody');
    body.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading…</div>';
    modal.hidden = false;
    fetch('/api/broker/loads/' + encodeURIComponent(token)).then((r) => r.json()).then((l) => {
      if (l.error) { body.innerHTML = `<div class="banner error">${escapeHtml(l.error)}</div>`; return; }
      body.innerHTML = `
        <h2>${escapeHtml(l.pickup)} → ${escapeHtml(l.destination)}</h2>
        <p class="hint">Token ${escapeHtml(l.tokenNo)} · Shipper: ${escapeHtml(l.shipperCompanyName || '—')}</p>
        <div class="field-grid">
          <div class="field"><label>Material</label><div>${escapeHtml(l.material || '—')}</div></div>
          <div class="field"><label>Weight</label><div>${escapeHtml(String(l.weight || '—'))} kg</div></div>
          <div class="field"><label>Distance</label><div>${escapeHtml(String(l.distanceKm || '—'))} km</div></div>
          <div class="field"><label>Truck type</label><div>${escapeHtml(l.requiredTruckType || '—')} ${escapeHtml(l.requiredBodyType || '')}</div></div>
          <div class="field"><label>Pickup</label><div>${escapeHtml(l.pickupAddress || l.pickup || '—')}</div></div>
          <div class="field"><label>Destination</label><div>${escapeHtml(l.destAddress || l.destination || '—')}</div></div>
          <div class="field"><label>Pickup date</label><div>${escapeHtml(fmtDate(l.pickupDateTime))}</div></div>
          <div class="field"><label>Bidding deadline</label><div>${escapeHtml(fmtDateTime(l.biddingDeadline))}</div></div>
        </div>
        <h2 style="font-size:16px; margin-top:18px;">Eligible carrier / truck options (${l.eligibleTrucks.length})</h2>
        ${l.eligibleTrucks.length ? l.eligibleTrucks.map((t) => `
          <div class="load-card" style="margin-bottom:8px;">
            <div class="route">${escapeHtml(t.vehicleNumber || t.id)}</div>
            <div class="meta">${escapeHtml(t.truckType || '—')} ${escapeHtml(t.bodyType || '')} · ${escapeHtml(String(t.capacityTons || '—'))} T · Currently at ${escapeHtml(t.currentLocation || '—')}</div>
          </div>`).join('') : '<div class="empty-state">No eligible verified trucks are available for this load right now.</div>'}
        <div class="actions" style="margin-top:14px;">
          <button type="button" class="btn-primary" id="detailBidBtn">Submit bid on this load</button>
          <button type="button" class="btn-secondary" id="detailBestCarrierBtn">🤖 Recommend best carrier</button>
        </div>`;
      document.getElementById('bestCarrierMatchBox').innerHTML = '';
      document.getElementById('detailBidBtn').addEventListener('click', () => { modal.hidden = true; openBidModal(token, l.eligibleTrucks); });
      document.getElementById('detailBestCarrierBtn').addEventListener('click', () => loadBestCarrierMatch(token));
    }).catch(() => { body.innerHTML = '<div class="banner error">Could not load this load right now.</div>'; });
  }
  document.getElementById('closeLoadDetail').addEventListener('click', () => { document.getElementById('loadDetailModal').hidden = true; });

  function loadBestCarrierMatch(token) {
    const box = document.getElementById('bestCarrierMatchBox');
    box.innerHTML = '<div class="empty-state" style="padding:16px;"><span class="ls-spinner"></span> Scoring available carriers…</div>';
    fetch('/api/broker/load-matches/' + encodeURIComponent(token)).then((r) => r.json()).then((data) => {
      if (data.error) { box.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
      if (!data.bestCarrier) {
        box.innerHTML = `<div class="empty-state" style="padding:16px;">${escapeHtml(data.message || 'No suitable truck found. Try another Carrier or adjust the requirements.')}</div>`;
        return;
      }
      const b = data.bestCarrier;
      box.innerHTML = `
        <div class="load-card" style="margin-top:12px; border-color:var(--leaf);">
          <div class="route">🏆 ${escapeHtml(b.carrierCompanyName)} <span class="score-badge-inline">${escapeHtml(String(b.matchScore))}</span></div>
          <div class="meta">
            Truck ${escapeHtml(b.vehicleNumber || b.truckId)} · ${escapeHtml(b.truckType || '—')} · ${escapeHtml(String(b.capacityTons || '—'))} T<br>
            ${b.driverName ? 'Driver: ' + escapeHtml(b.driverName) + '<br>' : ''}
            ${b.trustScore !== null && b.trustScore !== undefined ? 'Trust score: ' + escapeHtml(String(b.trustScore)) + '<br>' : ''}
            Currently at ${escapeHtml(b.currentLocation || '—')}
            ${b.reasons && b.reasons.length ? `<ul class="reasons">${b.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
          </div>
          <p class="hint" style="margin-top:8px;">Considered ${escapeHtml(String(data.consideredCount))} truck(s) platform-wide. Go to Carrier Connect to save this load and request a Shipper connection.</p>
        </div>`;
    }).catch(() => { box.innerHTML = '<div class="banner error">Could not compute a recommendation right now.</div>'; });
  }

  let bidModalToken = null;
  function openBidModal(token, eligibleTrucks) {
    bidModalToken = token;
    document.getElementById('bidModalError').textContent = '';
    document.getElementById('bidAmountInput').value = '';
    document.getElementById('bidNotesInput').value = '';
    const select = document.getElementById('bidTruckSelect');
    select.innerHTML = '<option value="">Loading eligible trucks…</option>';
    document.getElementById('bidModal').hidden = false;
    const fillSelect = (trucks) => {
      if (!trucks || !trucks.length) { select.innerHTML = '<option value="">No eligible trucks available</option>'; return; }
      select.innerHTML = trucks.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.vehicleNumber || t.id)} — ${escapeHtml(t.truckType || '')} ${escapeHtml(t.bodyType || '')} (${escapeHtml(String(t.capacityTons || '—'))} T)</option>`).join('');
    };
    if (eligibleTrucks) fillSelect(eligibleTrucks);
    else fetch('/api/broker/loads/' + encodeURIComponent(token)).then((r) => r.json()).then((l) => fillSelect(l.eligibleTrucks)).catch(() => fillSelect([]));
  }
  document.getElementById('closeBidModal').addEventListener('click', () => { document.getElementById('bidModal').hidden = true; });
  document.getElementById('submitBidBtn').addEventListener('click', () => {
    const truckId = document.getElementById('bidTruckSelect').value;
    const bidAmount = Number(document.getElementById('bidAmountInput').value);
    const notes = document.getElementById('bidNotesInput').value;
    const errBox = document.getElementById('bidModalError');
    if (!truckId) { errBox.textContent = 'Select an eligible truck first.'; return; }
    if (!bidAmount || bidAmount <= 0) { errBox.textContent = 'Enter a valid bid amount.'; return; }
    errBox.textContent = '';
    fetch('/api/broker/bids', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenNo: bidModalToken, truckId, bidAmount, notes }),
    }).then((r) => r.json()).then((data) => {
      if (data.error) { errBox.textContent = data.error; return; }
      document.getElementById('bidModal').hidden = true;
      toast('Bid submitted!');
      loadLoads();
      loadDashboard();
    }).catch(() => { errBox.textContent = 'Could not submit your bid right now.'; });
  });

  // ================= Load Board: My Posted Loads (Post New Load) =================
  function loadMyPostedLoads() {
    const wrap = document.getElementById('myPostedLoadsList');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading your posted loads…</div>';
    fetch('/api/broker/loads/mine').then((r) => r.json()).then((loads) => {
      if (loads.error) { document.getElementById('myPostedLoadsError').textContent = loads.error; wrap.innerHTML = ''; return; }
      document.getElementById('myPostedLoadsError').textContent = '';
      if (!loads.length) { wrap.innerHTML = '<div class="empty-state">You haven\'t posted any loads yet — click "+ Post New Load" above.</div>'; return; }
      wrap.innerHTML = loads.map((l) => `
        <div class="load-card" style="margin-bottom:10px;">
          <div class="route">${escapeHtml(l.pickup)} → ${escapeHtml(l.destination)} <span class="badge ${escapeHtml(l.brokerLoadStatus)}">${escapeHtml(l.brokerLoadStatus)}</span></div>
          <div class="meta">
            Token ${escapeHtml(l.tokenNo)} · ${escapeHtml(l.material || '—')} · ${escapeHtml(String(l.weight || '—'))} kg · ${escapeHtml(l.requiredTruckType || '—')} · ${escapeHtml(String(l.numberOfTrucks || 1))} truck(s)<br>
            Pickup ${escapeHtml(fmtDate(l.pickupDateTime))}${l.deliveryDeadline ? ' · Delivery by ' + escapeHtml(fmtDate(l.deliveryDeadline)) : ''}${l.budgetRate ? ' · Budget ' + escapeHtml(fmtInr(l.budgetRate)) : ''}<br>
            Stage: <span class="badge">${escapeHtml(l.loadStage || '—')}</span> · Bids received: ${escapeHtml(String(l.bidCount || 0))}
            ${l.biddingExpired ? '<br><span class="badge REJECTED">Bidding closed</span>' : ''}
          </div>
          <div class="actions">
            ${l.canEdit ? `<button type="button" class="btn-secondary" data-edit-load="${escapeHtml(l.tokenNo)}">Edit</button>` : ''}
            ${l.brokerLoadStatus === 'DRAFT' ? `<button type="button" class="btn-primary" data-open-bidding="${escapeHtml(l.tokenNo)}">Open for bidding</button>` : ''}
            <button type="button" class="btn-secondary" data-find-carrier-for-load="${escapeHtml(l.tokenNo)}">Find Carrier</button>
            ${l.brokerLoadStatus === 'POSTED' ? `<button type="button" class="btn-secondary" data-view-load-bids="${escapeHtml(l.tokenNo)}">View bids (${escapeHtml(String(l.bidCount || 0))})</button>` : ''}
            ${l.canCancel ? `<button type="button" class="btn-secondary" data-cancel-load="${escapeHtml(l.tokenNo)}">Cancel</button>` : ''}
          </div>
        </div>`).join('');
      wrap.querySelectorAll('[data-edit-load]').forEach((b) => b.addEventListener('click', () => openPostLoadModal(b.dataset.editLoad)));
      wrap.querySelectorAll('[data-open-bidding]').forEach((b) => b.addEventListener('click', () => {
        if (!confirm('Open this load for bidding? It will become visible to every carrier on the Load Board.')) return;
        fetch('/api/broker/loads/' + encodeURIComponent(b.dataset.openBidding) + '/open-bidding', { method: 'POST' }).then((r) => r.json()).then((data) => {
          if (data.error) { toast(data.error); return; }
          toast('Load opened for bidding — carriers have been notified.');
          loadMyPostedLoads(); loadLoads();
        }).catch(() => toast('Could not open that load for bidding right now.'));
      }));
      wrap.querySelectorAll('[data-find-carrier-for-load]').forEach((b) => b.addEventListener('click', () => openFindCarrierModal(b.dataset.findCarrierForLoad)));
      wrap.querySelectorAll('[data-view-load-bids]').forEach((b) => b.addEventListener('click', () => openViewBidsModal(b.dataset.viewLoadBids)));
      wrap.querySelectorAll('[data-cancel-load]').forEach((b) => b.addEventListener('click', () => {
        if (!confirm('Cancel this posted load?')) return;
        fetch('/api/broker/loads/' + encodeURIComponent(b.dataset.cancelLoad) + '/cancel', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Cancelled by broker.' }),
        }).then((r) => r.json()).then((data) => {
          if (data.error) { toast(data.error); return; }
          toast('Load cancelled.');
          loadMyPostedLoads();
        }).catch(() => toast('Could not cancel that load right now.'));
      }));
    }).catch(() => { wrap.innerHTML = ''; document.getElementById('myPostedLoadsError').textContent = 'Could not load your posted loads right now.'; });
  }

  const POST_LOAD_FIELDS = ['pickup', 'destination', 'pickupDateTime', 'deliveryDeadline', 'material', 'weight', 'requiredTruckType', 'requiredBodyType', 'numberOfTrucks', 'budgetRate', 'contactPerson', 'contactPhone', 'shipperCompanyName', 'loadingInstructions', 'unloadingInstructions', 'specialRequirements'];
  const POST_LOAD_FIELD_IDS = { pickup: 'plPickup', destination: 'plDestination', pickupDateTime: 'plPickupDateTime', deliveryDeadline: 'plDeliveryDeadline', material: 'plMaterial', weight: 'plWeight', requiredTruckType: 'plRequiredTruckType', requiredBodyType: 'plRequiredBodyType', numberOfTrucks: 'plNumberOfTrucks', budgetRate: 'plBudgetRate', contactPerson: 'plContactPerson', contactPhone: 'plContactPhone', shipperCompanyName: 'plShipperCompanyName', loadingInstructions: 'plLoadingInstructions', unloadingInstructions: 'plUnloadingInstructions', specialRequirements: 'plSpecialRequirements' };
  let postLoadEditToken = null;
  function clearPostLoadForm() {
    Object.values(POST_LOAD_FIELD_IDS).forEach((id) => { document.getElementById(id).value = ''; });
    document.getElementById('plNumberOfTrucks').value = 1;
    document.getElementById('plAdvancePaymentRequired').checked = false;
    document.getElementById('plAdvancePaymentPercent').value = '';
    document.getElementById('plRequiredDocuments').value = '';
    document.getElementById('postLoadError').textContent = '';
  }
  function openPostLoadModal(editToken) {
    postLoadEditToken = editToken || null;
    clearPostLoadForm();
    document.getElementById('postLoadModalTitle').textContent = editToken ? 'Edit load ' + editToken : 'Post a new load';
    document.getElementById('submitPostLoadBtn').textContent = editToken ? 'Save changes' : 'Save as draft';
    document.getElementById('postLoadModal').hidden = false;
    if (editToken) {
      fetch('/api/broker/loads/mine').then((r) => r.json()).then((loads) => {
        const l = (loads || []).find((x) => x.tokenNo === editToken);
        if (!l) return;
        POST_LOAD_FIELDS.forEach((f) => {
          const el = document.getElementById(POST_LOAD_FIELD_IDS[f]);
          if (!el) return;
          if (f === 'pickupDateTime' || f === 'deliveryDeadline') {
            el.value = l[f] ? new Date(l[f]).toISOString().slice(0, 16) : '';
          } else if (l[f] !== undefined && l[f] !== null) el.value = l[f];
        });
      }).catch(() => {});
    }
  }
  document.getElementById('openPostLoadBtn').addEventListener('click', () => openPostLoadModal(null));
  document.getElementById('closePostLoadModal').addEventListener('click', () => { document.getElementById('postLoadModal').hidden = true; });
  document.getElementById('submitPostLoadBtn').addEventListener('click', () => {
    const errBox = document.getElementById('postLoadError');
    const body = {};
    POST_LOAD_FIELDS.forEach((f) => { body[f] = document.getElementById(POST_LOAD_FIELD_IDS[f]).value; });
    body.advancePaymentRequired = document.getElementById('plAdvancePaymentRequired').checked;
    body.advancePaymentPercent = document.getElementById('plAdvancePaymentPercent').value;
    body.requiredDocuments = splitCsv(document.getElementById('plRequiredDocuments').value);
    if (!body.pickup || !body.destination) { errBox.textContent = 'Pickup and destination are required.'; return; }
    if (!body.material) { errBox.textContent = 'Material / category is required.'; return; }
    if (!body.weight || Number(body.weight) <= 0) { errBox.textContent = 'Enter a valid weight.'; return; }
    if (!body.requiredTruckType) { errBox.textContent = 'Required truck type is required.'; return; }
    if (!body.pickupDateTime) { errBox.textContent = 'Pickup date is required.'; return; }
    if (!body.contactPerson || !body.contactPhone) { errBox.textContent = 'Contact person and phone are required.'; return; }
    errBox.textContent = '';
    const submitBtn = document.getElementById('submitPostLoadBtn');
    submitBtn.disabled = true;
    const url = postLoadEditToken ? '/api/broker/loads/' + encodeURIComponent(postLoadEditToken) : '/api/broker/loads';
    const method = postLoadEditToken ? 'PATCH' : 'POST';
    fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json()).then((data) => {
        submitBtn.disabled = false;
        if (data.error) { errBox.textContent = data.error + (data.fieldErrors ? ' ' + data.fieldErrors.map((e) => e.message).join(' ') : ''); return; }
        toast(postLoadEditToken ? 'Load updated.' : 'Load saved as draft.');
        document.getElementById('postLoadModal').hidden = true;
        loadMyPostedLoads();
      }).catch(() => { submitBtn.disabled = false; errBox.textContent = 'Could not save that load right now.'; });
  });

  // "Find Carrier" — reuses the Load Matching engine (Panel B) for one
  // specific load, opened directly from a Load Board card.
  function openFindCarrierModal(tokenNo) {
    const modal = document.getElementById('findCarrierModal');
    const body = document.getElementById('findCarrierBody');
    body.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Scoring available carriers…</div>';
    modal.hidden = false;
    fetch('/api/broker/load-matching/carriers/' + encodeURIComponent(tokenNo)).then((r) => r.json()).then((data) => {
      if (data.error) { body.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
      const matches = data.matches || [];
      body.innerHTML = `
        <h2>Matching carriers — ${escapeHtml(data.pickup)} → ${escapeHtml(data.destination)}</h2>
        <p class="hint">Load ${escapeHtml(data.tokenNo)} · Weighted match: Origin 25% · Destination 25% · Truck type 15% · Capacity 15% · Availability 10% · Verification 5% · Trust 5%</p>
        ${!matches.length ? `<div class="empty-state">${escapeHtml(data.message || 'No suitable carrier found for this load right now.')}</div>` : matches.map((m) => `
        <div class="load-card" style="margin-bottom:10px;">
          <div class="route">${escapeHtml(m.carrierCompanyName)} <span class="score-badge-inline">${escapeHtml(String(m.matchScore))}% match</span></div>
          <div class="meta">
            Truck ${escapeHtml(m.vehicleNumber || m.truckId)} · ${escapeHtml(m.truckType || '—')} · ${escapeHtml(String(m.capacityTons || '—'))} T · ${m.carrierVerified ? 'Verified' : 'Unverified'}<br>
            ${m.driverName ? 'Driver: ' + escapeHtml(m.driverName) + '<br>' : ''}
            <em>${escapeHtml(m.explanation || '')}</em>
          </div>
          <div class="actions">
            <button type="button" class="btn-secondary" data-fc-connect="${escapeHtml(m.carrierId)}">Send connection request</button>
            <button type="button" class="btn-primary" data-fc-invite="${escapeHtml(m.carrierId)}">Invite to bid</button>
          </div>
        </div>`).join('')}`;
      body.querySelectorAll('[data-fc-connect]').forEach((b) => b.addEventListener('click', () => sendCarrierConnectionRequest(b.dataset.fcConnect)));
      body.querySelectorAll('[data-fc-invite]').forEach((b) => b.addEventListener('click', () => inviteCarrierToLoad(b.dataset.fcInvite, tokenNo)));
    }).catch(() => { body.innerHTML = '<div class="banner error">Could not load carrier matches right now.</div>'; });
  }
  document.getElementById('closeFindCarrierModal').addEventListener('click', () => { document.getElementById('findCarrierModal').hidden = true; });

  function openViewBidsModal(tokenNo) {
    const modal = document.getElementById('viewBidsModal');
    const body = document.getElementById('viewBidsBody');
    body.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading ranked offers…</div>';
    modal.hidden = false;
    fetch('/api/broker/loads/' + encodeURIComponent(tokenNo) + '/bids').then((r) => r.json()).then((data) => {
      if (data.error) { body.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
      const offers = data.offers || [];
      body.innerHTML = `
        <h2>Bids on load ${escapeHtml(tokenNo)}</h2>
        <p class="hint">Read-only ranked view. Actually accepting an offer must go through the shipper's own accept-bid flow.</p>
        ${!offers.length ? '<div class="empty-state">No active bids on this load yet.</div>' : offers.map((o) => `
          <div class="bid-card" style="margin-bottom:8px;">
            <div class="route">#${escapeHtml(String(o.rank))} ${escapeHtml(o.carrierCompanyName)}</div>
            <div class="meta">Final price: ${escapeHtml(fmtInr(o.finalShipperPrice))} · Match score: ${escapeHtml(String(o.aiMatchScore ?? '—'))} · Trust: ${escapeHtml(String(o.trustScore ?? '—'))} · ${escapeHtml(o.truckType || '—')} (${escapeHtml(String(o.capacityTons || '—'))} T)</div>
          </div>`).join('')}`;
    }).catch(() => { body.innerHTML = '<div class="banner error">Could not load bids right now.</div>'; });
  }
  document.getElementById('closeViewBidsModal').addEventListener('click', () => { document.getElementById('viewBidsModal').hidden = true; });

  // ================= Load Matching (dedicated tab) =================
  // Deterministic, rule-based matching — works with or without the AI
  // provider configured (see lib/brokerAutomation.js / brokerService.js on
  // the backend). Never claims to be AI-generated.
  let matchingLoadedOnce = false;
  function loadMatchingTab() {
    matchingLoadedOnce = true;
    loadMatchingLoads();
    populateMatchingLoadSelect();
  }
  function loadMatchingLoads() {
    const wrap = document.getElementById('matchingLoadsList');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Scoring open loads against your saved routes…</div>';
    fetch('/api/broker/load-matching/loads').then((r) => r.json()).then((data) => {
      if (data.error) { document.getElementById('matchingLoadsError').textContent = data.error; wrap.innerHTML = ''; return; }
      document.getElementById('matchingLoadsError').textContent = '';
      const matches = data.matches || [];
      if (!matches.length) {
        wrap.innerHTML = `<div class="empty-state">${data.preferencesConfigured ? 'No open loads match your saved preferences right now.' : 'No preferences saved yet — set your preferred routes and truck types in Profile to personalize this list. Showing general open loads for now.'}</div>`;
        return;
      }
      wrap.innerHTML = matches.map((m) => `
        <div class="opportunity-item">
          <span class="score-badge">${escapeHtml(String(m.score))}%</span>
          <div class="route">${escapeHtml(m.pickup || '—')} → ${escapeHtml(m.destination || '—')}</div>
          <div class="meta">Token ${escapeHtml(m.tokenNo)} · ${escapeHtml(m.material || 'Material n/a')} · ${escapeHtml(String(m.weight || '—'))} kg · ${escapeHtml(m.requiredTruckType || '—')} · Pickup ${escapeHtml(fmtDate(m.pickupDateTime))}</div>
          ${m.reasons && m.reasons.length ? `<ul class="reasons">${m.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
        </div>`).join('');
    }).catch(() => { wrap.innerHTML = ''; document.getElementById('matchingLoadsError').textContent = 'Could not compute load matches right now.'; });
  }
  function populateMatchingLoadSelect() {
    const select = document.getElementById('matchingLoadSelect');
    fetch('/api/broker/loads').then((r) => r.json()).then((loads) => {
      if (!Array.isArray(loads)) return;
      select.innerHTML = '<option value="">Select an open load…</option>' +
        loads.map((l) => `<option value="${escapeHtml(l.tokenNo)}">${escapeHtml(l.tokenNo)} — ${escapeHtml(l.pickup)} → ${escapeHtml(l.destination)}</option>`).join('');
    }).catch(() => {});
  }
  document.getElementById('matchingRunBtn').addEventListener('click', () => {
    const tokenNo = document.getElementById('matchingLoadSelect').value;
    const errBox = document.getElementById('matchingCarriersError');
    const wrap = document.getElementById('matchingCarriersList');
    if (!tokenNo) { errBox.textContent = 'Select a load first.'; return; }
    errBox.textContent = '';
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Scoring available carriers…</div>';
    fetch('/api/broker/load-matching/carriers/' + encodeURIComponent(tokenNo)).then((r) => r.json()).then((data) => {
      if (data.error) { errBox.textContent = data.error; wrap.innerHTML = ''; return; }
      const matches = data.matches || [];
      if (!matches.length) { wrap.innerHTML = `<div class="empty-state">${escapeHtml(data.message || 'No suitable truck found for this load right now.')}</div>`; return; }
      wrap.innerHTML = matches.map((m) => `
        <div class="load-card" style="margin-bottom:10px;">
          <div class="route">${escapeHtml(m.carrierCompanyName)} <span class="score-badge-inline">${escapeHtml(String(m.matchScore))}% match</span> ${m.carrierVerified ? '<span class="badge ACCEPTED">Verified</span>' : ''}</div>
          <div class="meta">
            Truck ${escapeHtml(m.vehicleNumber || m.truckId)} · ${escapeHtml(m.truckType || '—')} ${escapeHtml(m.bodyType || '')} · ${escapeHtml(String(m.capacityTons || '—'))} T<br>
            ${m.driverName ? 'Driver: ' + escapeHtml(m.driverName) + '<br>' : ''}
            ${m.carrierTrustScore !== null && m.carrierTrustScore !== undefined ? 'Trust score: ' + escapeHtml(String(m.carrierTrustScore)) + '<br>' : ''}
            Currently at ${escapeHtml(m.currentLocation || '—')} · Status: ${escapeHtml(m.truckStatus || '—')}<br>
            <em>${escapeHtml(m.explanation || '')}</em>
          </div>
          <div class="actions">
            <button type="button" class="btn-secondary" data-mc-view-carrier="${escapeHtml(m.carrierId)}">View profile</button>
            <button type="button" class="btn-primary" data-mc-invite="${escapeHtml(m.carrierId)}" data-mc-load="${escapeHtml(tokenNo)}">Invite to bid</button>
          </div>
        </div>`).join('');
      wrap.querySelectorAll('[data-mc-view-carrier]').forEach((b) => b.addEventListener('click', () => openCarrierProfileModal(b.dataset.mcViewCarrier)));
      wrap.querySelectorAll('[data-mc-invite]').forEach((b) => b.addEventListener('click', () => inviteCarrierToLoad(b.dataset.mcInvite, b.dataset.mcLoad)));
    }).catch(() => { wrap.innerHTML = ''; errBox.textContent = 'Could not compute carrier matches right now.'; });
  });

  function inviteCarrierToLoad(carrierId, tokenNo) {
    fetch('/api/broker/loads/' + encodeURIComponent(tokenNo) + '/invite-carrier', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ carrierId }),
    }).then((r) => r.json()).then((data) => {
      if (data.error) { toast(data.error); return; }
      toast('Invitation sent — the carrier has been notified.');
    }).catch(() => toast('Could not send that invitation right now.'));
  }

  // ================= My Bids =================
  let bidsLoadedOnce = false;
  function loadBids() {
    bidsLoadedOnce = true;
    const wrap = document.getElementById('bidsList');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading your bids…</div>';
    const status = document.getElementById('bidStatusFilter').value;
    fetch('/api/broker/bids' + (status ? '?status=' + status : '')).then((r) => r.json()).then((bids) => {
      if (bids.error) { document.getElementById('bidsError').textContent = bids.error; wrap.innerHTML = ''; return; }
      document.getElementById('bidsError').textContent = '';
      if (!bids.length) { wrap.innerHTML = '<div class="empty-state">No bids yet — browse the Load Board to submit one.</div>'; return; }
      wrap.innerHTML = bids.map((b) => `
        <div class="bid-card">
          <div class="route">${b.load ? escapeHtml(b.load.pickup) + ' → ' + escapeHtml(b.load.destination) : 'Load ' + escapeHtml(b.loadId)} <span class="badge ${escapeHtml(b.status)}">${escapeHtml(b.status)}</span></div>
          <div class="meta">
            Token ${escapeHtml(b.loadId)} · Your bid: ${escapeHtml(fmtInr(b.bidAmount))} · Truck ${escapeHtml(b.vehicleNumber || b.truckId || '—')}<br>
            Submitted ${escapeHtml(fmtDateTime(b.createdAt))}
            ${b.status === 'REJECTED' && b.rejectionReason ? `<br>Reason: ${escapeHtml(b.rejectionReason)}` : ''}
            ${b.notes ? `<br>Notes: ${escapeHtml(b.notes)}` : ''}
          </div>
          ${['SUBMITTED', 'SHORTLISTED'].includes(b.status) ? `<div class="actions"><button type="button" class="btn-secondary" data-withdraw="${escapeHtml(b.id)}">Withdraw</button></div>` : ''}
        </div>`).join('');
      wrap.querySelectorAll('[data-withdraw]').forEach((btn) => btn.addEventListener('click', () => {
        if (!confirm('Withdraw this bid?')) return;
        fetch('/api/broker/bids/' + encodeURIComponent(btn.dataset.withdraw) + '/withdraw', { method: 'PATCH' })
          .then((r) => r.json()).then((data) => {
            if (data.error) { toast(data.error); return; }
            toast('Bid withdrawn.');
            loadBids();
          }).catch(() => toast('Could not withdraw that bid right now.'));
      }));
    }).catch(() => { wrap.innerHTML = ''; document.getElementById('bidsError').textContent = 'Could not load your bids right now.'; });
  }
  document.getElementById('bidStatusFilter').addEventListener('change', loadBids);
  document.getElementById('refreshBidsBtn').addEventListener('click', loadBids);

  // ================= My Shipments =================
  let shipmentsLoadedOnce = false;
  function loadShipments() {
    shipmentsLoadedOnce = true;
    const wrap = document.getElementById('shipmentsList');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading your shipments…</div>';
    const filterKey = document.getElementById('shipmentsFilterSelect').value;
    fetch('/api/broker/shipments' + (filterKey ? '?filter=' + encodeURIComponent(filterKey) : '')).then((r) => r.json()).then((loads) => {
      if (loads.error) { document.getElementById('shipmentsError').textContent = loads.error; wrap.innerHTML = ''; return; }
      document.getElementById('shipmentsError').textContent = '';
      if (!loads.length) { wrap.innerHTML = '<div class="empty-state">No shipments attached to your account yet.</div>'; return; }
      wrap.innerHTML = loads.map((l) => `
        <div class="shipment-card">
          <div class="route">${escapeHtml(l.pickup)} → ${escapeHtml(l.destination)}</div>
          <div class="meta">
            Token ${escapeHtml(l.tokenNo)} · ${escapeHtml(l.material || '—')} · ${escapeHtml(String(l.weight || '—'))} kg<br>
            Stage: <span class="badge">${escapeHtml(l.loadStageLabel || l.loadStage || '—')}</span>
            ${l.carrierCompanyName ? ` · Carrier: ${escapeHtml(l.carrierCompanyName)}` : ''}
            ${l.driverName ? ` · Driver: ${escapeHtml(l.driverName)}` : ''}
            ${l.vehicleNumber ? ` · Truck: ${escapeHtml(l.vehicleNumber)}` : ''}<br>
            Payment: <span class="badge">${escapeHtml(l.paymentStatus || '—')}</span>
            ${l.advancePaymentRequired ? ` · Advance: <span class="badge ${l.advancePaymentStatus === 'received' ? 'ACCEPTED' : 'PENDING_REVIEW'}">${escapeHtml(l.advancePaymentStatus)}</span>` : ''}
            ${l.podStatus ? ` · POD: <span class="badge">${escapeHtml(l.podStatus)}</span>` : ''}
            ${l.delay && l.delay.active ? '<br><span class="badge REJECTED">Delay reported</span>' : ''}
            ${l.trackingStatus ? `<br>Tracking: ${escapeHtml(l.trackingStatus)}` : ''}
            Last updated: ${escapeHtml(fmtDateTime(l.updatedAt))}
            ${l.completedAt ? `<br>Completed: ${escapeHtml(fmtDate(l.completedAt))}` : ''}
          </div>
          ${l.timeline && l.timeline.length ? `
          <details style="margin-top:8px;">
            <summary style="cursor:pointer; font-size:12.5px; font-weight:700; color:var(--green-deep);">Timeline (${l.timeline.length})</summary>
            <div class="timeline-list" style="margin-top:8px;">
              ${l.timeline.map((t) => `
                <div class="timeline-item">
                  <span class="dot"></span>
                  <div><div class="t">${escapeHtml(fmtDateTime(t.at))}</div><div class="l">${escapeHtml(t.label || t.type || '')}</div>${t.location ? `<div class="d">${escapeHtml(t.location)}</div>` : ''}</div>
                </div>`).join('')}
            </div>
          </details>` : ''}
        </div>`).join('');
    }).catch(() => { wrap.innerHTML = ''; document.getElementById('shipmentsError').textContent = 'Could not load your shipments right now.'; });
  }
  document.getElementById('shipmentsFilterSelect').addEventListener('change', loadShipments);
  document.getElementById('refreshShipmentsBtn').addEventListener('click', loadShipments);

  // ================= KYC & Documents =================
  let kycLoadedOnce = false;
  const DOC_DEFS = [
    { key: 'pan', label: 'PAN card', field: 'panDocumentPath', always: true },
    { key: 'gst', label: 'GST certificate', field: 'gstPhotoPath', conditional: 'hasGST' },
    { key: 'msme', label: 'MSME / Udyam certificate', field: 'msmePhotoPath', conditional: 'hasMSME' },
    { key: 'address', label: 'Address proof', field: 'addressProofPath', optional: true },
    { key: 'bank', label: 'Bank proof', field: 'bankProofPhotoPath', always: true },
    { key: 'profile', label: 'Profile photo', field: 'profilePhotoPath', optional: true },
  ];
  function loadKyc() {
    kycLoadedOnce = true;
    document.getElementById('kycStatusBlock').innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading…</div>';
    fetch('/api/broker/kyc').then((r) => r.json()).then((data) => {
      if (data.error) { toast(data.error); return; }
      const statusBlock = document.getElementById('kycStatusBlock');
      statusBlock.innerHTML = `
        <p><span class="badge ${escapeHtml(data.kycStatus)}">${escapeHtml(data.kycStatus)}</span></p>
        ${data.kycRejectionReason ? `<div class="banner error">${escapeHtml(data.kycRejectionReason)}</div>` : ''}
        ${data.kycDocumentsRequested ? `<div class="banner error">Admin requested: ${escapeHtml(data.kycDocumentsRequested)}</div>` : ''}
        ${data.missingDocuments && data.missingDocuments.length ? `<p class="hint">Still needed: ${data.missingDocuments.map(escapeHtml).join(', ')}</p>` : ''}
        ${data.aiKycReview ? `<div class="ai-note">AI document review summary: ${escapeHtml(data.aiKycReview.summary || 'reviewed')}</div>` : ''}
      `;
      const docsWrap = document.getElementById('kycDocsList');
      const applicable = DOC_DEFS.filter((d) => d.always || d.optional || data[d.conditional]);
      docsWrap.innerHTML = applicable.map((d) => {
        const path = data.documents[d.field];
        const aiReview = (data.aiDocumentReviews || []).find((r) => r.documentType === d.key.toUpperCase());
        return `
        <div class="kyc-doc-card">
          <div class="name">${escapeHtml(d.label)} ${d.optional ? '<span class="optional-tag">Optional</span>' : ''}</div>
          <div class="state">${path ? `✅ <a href="${escapeHtml(myDocUrl(path))}" target="_blank" rel="noopener">View uploaded document</a>` : '⏳ Not uploaded yet'}</div>
          ${aiReview ? `<div class="ai-note">AI review: ${aiReview.looksReadable ? 'Readable' : 'Unclear'} · ${aiReview.looksLikeExpectedDocument ? 'Looks correct' : 'May not match expected type'}${aiReview.concerns && aiReview.concerns.length ? ' — ' + escapeHtml(aiReview.concerns.join('; ')) : ''}<br><em>Advisory only — not official verification.</em></div>` : ''}
          <input type="file" accept="image/png,image/jpeg,application/pdf" data-doc="${escapeHtml(d.key)}">
        </div>`;
      }).join('');
      docsWrap.querySelectorAll('input[type=file]').forEach((input) => {
        input.addEventListener('change', () => handleDocUpload(input, input.dataset.doc));
      });
    }).catch(() => toast('Could not load your KYC status right now.'));
  }

  const UPLOAD_TYPE_MAP = { gst: 'gstPhoto', msme: 'msmePhoto', pan: 'panDocument', address: 'addressProof', bank: 'bankProof', profile: 'profilePhoto' };
  function handleDocUpload(input, docKey) {
    const file = input.files && input.files[0];
    if (!file) return;
    const isPdf = file.type === 'application/pdf';
    const isImg = ['image/png', 'image/jpeg'].includes(file.type);
    if (!isPdf && !isImg) { toast('Only JPG, PNG or PDF files are allowed.'); input.value = ''; return; }
    if (file.size > 8 * 1024 * 1024) { toast('File is too large (max 8MB).'); input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      fetch('/api/kyc/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: UPLOAD_TYPE_MAP[docKey], imageBase64: reader.result }),
      }).then((r) => r.json()).then((up) => {
        if (up.error) { toast(up.error); return; }
        return fetch('/api/broker/documents', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentType: docKey, path: up.path }),
        }).then((r) => r.json());
      }).then((res) => {
        if (!res) return;
        if (res.error) { toast(res.error); return; }
        toast('Document uploaded.');
        loadKyc();
      }).catch(() => toast('Could not upload that document right now.'));
    };
    reader.readAsDataURL(file);
  }
  document.getElementById('submitKycBtn').addEventListener('click', () => {
    fetch('/api/broker/kyc/submit', { method: 'POST' }).then((r) => r.json()).then((data) => {
      if (data.error) {
        toast(data.error + (data.missingDocuments ? ' (' + data.missingDocuments.join(', ') + ')' : ''));
        return;
      }
      toast('KYC submitted for review.');
      loadKyc();
      loadDashboard();
    }).catch(() => toast('Could not submit your KYC right now.'));
  });

  // ================= AI Assistant =================
  // Fix for the reported "AI isn't configured… then rate-limited" loop:
  // check configuration ONCE up front (never repeatedly probing a known-
  // broken endpoint), show ONE clear banner, and let the backend's own
  // deterministic fallback (lib/brokerAiFallback.js) answer the 5 supported
  // questions even while the banner is showing.
  let aiStatusCheckedOnce = false;
  let aiConfigured = true; // optimistic default until checked, so we never falsely claim "unavailable"
  let aiRequestInFlight = false;
  let lastAiQuestion = null;
  let lastAiQuestionAt = 0;
  const aiHistory = [];
  function checkAiStatus() {
    aiStatusCheckedOnce = true;
    fetch('/api/broker/ai/status').then((r) => r.json()).then((data) => {
      if (data.error) return;
      aiConfigured = !!data.aiConfigured;
      const banner = document.getElementById('aiUnavailableBanner');
      if (!aiConfigured) {
        banner.style.display = 'block';
        banner.textContent = 'AI Assistant is currently unavailable. Load Matching is still available using Smart Rule Matching, and the 5 quick questions below still work.';
      } else {
        banner.style.display = 'none';
        banner.textContent = '';
      }
    }).catch(() => {});
  }
  function appendAiMessage(role, text) {
    const log = document.getElementById('aiChatLog');
    const div = document.createElement('div');
    div.className = 'ai-msg ' + role;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  function sendAiMessage(message) {
    message = String(message || '').trim();
    if (!message) return;
    const sendBtn = document.getElementById('aiChatSendBtn');
    // Prevent duplicate submissions from repeated clicks while a request is
    // already in flight, and debounce the exact same question sent twice
    // within a few seconds (e.g. an accidental double-click / double-Enter).
    if (aiRequestInFlight) return;
    const now = Date.now();
    if (message === lastAiQuestion && now - lastAiQuestionAt < 4000) return;
    lastAiQuestion = message;
    lastAiQuestionAt = now;

    appendAiMessage('user', message);
    aiHistory.push({ role: 'user', text: message });
    document.getElementById('aiChatInput').value = '';
    aiRequestInFlight = true;
    sendBtn.disabled = true;
    fetch('/api/broker/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: aiHistory.slice(0, -1) }),
    }).then((r) => r.json().then((data) => ({ status: r.status, data }))).then(({ status, data }) => {
      aiRequestInFlight = false;
      sendBtn.disabled = false;
      if (data.error) {
        // Distinct, plain-language handling per status — never a raw stack
        // trace, never an automatic retry loop.
        if (status === 429) appendAiMessage('error', 'Too many questions in a short time — please wait a minute and try again.');
        else if (status === 503) appendAiMessage('error', data.error || 'The AI assistant is temporarily unavailable. Try one of the quick questions below, which work without it.');
        else if (status === 401) appendAiMessage('error', 'Your session has expired — please log in again.');
        else appendAiMessage('error', data.error || 'The AI assistant could not respond right now.');
        return;
      }
      appendAiMessage('assistant', data.reply);
      aiHistory.push({ role: 'assistant', text: data.reply });
      if (data.aiAvailable === false && aiConfigured) {
        // A configured provider just failed mid-request — reflect that in
        // the banner without another round-trip.
        aiConfigured = false;
        const banner = document.getElementById('aiUnavailableBanner');
        banner.style.display = 'block';
        banner.textContent = 'AI Assistant is currently unavailable. Load Matching is still available using Smart Rule Matching.';
      }
    }).catch(() => {
      aiRequestInFlight = false;
      sendBtn.disabled = false;
      appendAiMessage('error', 'The AI assistant could not respond right now. Please try again.');
    });
  }
  document.getElementById('aiChatSendBtn').addEventListener('click', () => sendAiMessage(document.getElementById('aiChatInput').value));
  document.getElementById('aiChatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAiMessage(document.getElementById('aiChatInput').value); });
  document.querySelectorAll('.suggestion-chip').forEach((chip) => chip.addEventListener('click', () => sendAiMessage(chip.textContent)));

  // ================= Carrier Connect: roster search + connections =================
  // General, load-independent broker<->carrier networking — separate from
  // the per-carrier "select carrier -> find loads -> connect to shipper"
  // workflow further down (still available under "Advanced").
  function ccCurrentQuery() {
    const q = new URLSearchParams();
    const search = document.getElementById('ccSearchInput').value.trim();
    const truckType = document.getElementById('ccTruckTypeInput').value.trim();
    const minCapacity = document.getElementById('ccMinCapacityInput').value;
    const route = document.getElementById('ccRouteInput').value.trim();
    const minTrustScore = document.getElementById('ccMinTrustSelect').value;
    if (search) q.set('search', search);
    if (truckType) q.set('truckType', truckType);
    if (minCapacity) q.set('minCapacity', minCapacity);
    if (route) q.set('route', route);
    if (minTrustScore) q.set('minTrustScore', minTrustScore);
    if (document.getElementById('ccAvailableOnly').checked) q.set('availableOnly', 'true');
    if (document.getElementById('ccIncludeUnverified').checked) q.set('includeUnverified', 'true');
    return q.toString();
  }
  function searchCarrierConnectCards() {
    const wrap = document.getElementById('ccCarrierCards');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading carriers…</div>';
    fetch('/api/broker/carriers?' + ccCurrentQuery()).then((r) => r.json()).then((carriers) => {
      if (carriers.error) { document.getElementById('ccSearchError').textContent = carriers.error; wrap.innerHTML = ''; return; }
      document.getElementById('ccSearchError').textContent = '';
      if (!carriers.length) { wrap.innerHTML = '<div class="empty-state">No carriers match your filters right now.</div>'; return; }
      wrap.innerHTML = carriers.map((c) => `
        <div class="load-card">
          <div class="route">${escapeHtml(c.companyName)} ${c.verified ? '<span class="badge ACCEPTED">Verified</span>' : '<span class="badge">Unverified</span>'}</div>
          <div class="meta">
            @${escapeHtml(c.username)} ${c.city ? '· ' + escapeHtml(c.city) : ''}<br>
            ${c.truckCount} truck(s)${c.truckTypes.length ? ' · ' + escapeHtml(c.truckTypes.join(', ')) : ''}${c.maxCapacityTons ? ' · up to ' + escapeHtml(String(c.maxCapacityTons)) + ' T' : ''}<br>
            ${c.hasAvailableTruck ? '<span class="badge ACCEPTED">Truck available</span>' : '<span class="badge">No truck free</span>'}
            ${c.trustScore !== null ? ' · Trust: ' + escapeHtml(String(c.trustScore)) : ''}
            ${c.connectionStatus ? `<br><span class="badge ${escapeHtml(c.connectionStatus)}">${escapeHtml(c.connectionStatus)}</span>` : ''}
          </div>
          <div class="actions">
            <button type="button" class="btn-secondary" data-cc-profile="${escapeHtml(c.id)}">View profile</button>
            ${!c.connectionStatus || c.connectionStatus === 'REJECTED' || c.connectionStatus === 'CANCELLED' ? `<button type="button" class="btn-primary" data-cc-connect="${escapeHtml(c.id)}">Connect</button>` : ''}
            <button type="button" class="btn-secondary" data-cc-invite="${escapeHtml(c.id)}">Invite to load</button>
          </div>
        </div>`).join('');
      wrap.querySelectorAll('[data-cc-profile]').forEach((b) => b.addEventListener('click', () => openCarrierProfileModal(b.dataset.ccProfile)));
      wrap.querySelectorAll('[data-cc-connect]').forEach((b) => b.addEventListener('click', () => sendCarrierConnectionRequest(b.dataset.ccConnect)));
      wrap.querySelectorAll('[data-cc-invite]').forEach((b) => b.addEventListener('click', () => openInviteCarrierModal(b.dataset.ccInvite)));
    }).catch(() => { wrap.innerHTML = ''; document.getElementById('ccSearchError').textContent = 'Could not load carriers right now.'; });
  }
  document.getElementById('ccSearchBtn').addEventListener('click', searchCarrierConnectCards);

  function sendCarrierConnectionRequest(carrierId) {
    fetch('/api/broker/carrier-connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ carrierId }),
    }).then((r) => r.json()).then((data) => {
      if (data.error) { toast(data.error); return; }
      toast('Connection request sent.');
      searchCarrierConnectCards();
      loadMyCarrierConnections();
    }).catch(() => toast('Could not send that connection request right now.'));
  }

  function openCarrierProfileModal(carrierId) {
    const modal = document.getElementById('carrierProfileModal');
    const body = document.getElementById('carrierProfileBody');
    body.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading…</div>';
    modal.hidden = false;
    fetch('/api/broker/carriers/' + encodeURIComponent(carrierId)).then((r) => r.json()).then((c) => {
      if (c.error) { body.innerHTML = `<div class="banner error">${escapeHtml(c.error)}</div>`; return; }
      body.innerHTML = `
        <h2>${escapeHtml(c.companyName)} ${c.verified ? '<span class="badge ACCEPTED">Verified</span>' : ''}</h2>
        <p class="hint">@${escapeHtml(c.username)} ${c.city ? '· ' + escapeHtml(c.city) : ''} ${c.mobileNumber ? '· ' + escapeHtml(c.mobileNumber) : ''}</p>
        <p>Trust score: ${c.trustScore !== null ? escapeHtml(String(c.trustScore)) : '—'} · ${escapeHtml(String(c.driverCount))} driver(s) on file</p>
        <h2 style="font-size:15px;">Fleet (${c.trucks.length})</h2>
        ${c.trucks.length ? c.trucks.map((t) => `
          <div class="load-card" style="margin-bottom:8px;">
            <div class="route">${escapeHtml(t.vehicleNumber)} ${t.verified ? '<span class="badge ACCEPTED">Verified</span>' : ''}</div>
            <div class="meta">${escapeHtml(t.truckType || '—')} ${escapeHtml(t.bodyType || '')} · ${escapeHtml(String(t.capacityTons || '—'))} T · ${escapeHtml(t.status)} · At ${escapeHtml(t.currentLocation || '—')}</div>
          </div>`).join('') : '<div class="empty-state">No trucks on file yet.</div>'}`;
    }).catch(() => { body.innerHTML = '<div class="banner error">Could not load this carrier right now.</div>'; });
  }
  document.getElementById('closeCarrierProfileModal').addEventListener('click', () => { document.getElementById('carrierProfileModal').hidden = true; });

  let inviteCarrierTargetId = null;
  function openInviteCarrierModal(carrierId) {
    inviteCarrierTargetId = carrierId;
    document.getElementById('inviteCarrierError').textContent = '';
    const select = document.getElementById('inviteCarrierLoadSelect');
    select.innerHTML = '<option value="">Loading your open loads…</option>';
    document.getElementById('inviteCarrierModal').hidden = false;
    fetch('/api/broker/loads').then((r) => r.json()).then((loads) => {
      if (!Array.isArray(loads) || !loads.length) { select.innerHTML = '<option value="">No open loads right now</option>'; return; }
      select.innerHTML = loads.map((l) => `<option value="${escapeHtml(l.tokenNo)}">${escapeHtml(l.tokenNo)} — ${escapeHtml(l.pickup)} → ${escapeHtml(l.destination)}</option>`).join('');
    }).catch(() => { select.innerHTML = '<option value="">Could not load your loads</option>'; });
  }
  document.getElementById('closeInviteCarrierModal').addEventListener('click', () => { document.getElementById('inviteCarrierModal').hidden = true; });
  document.getElementById('submitInviteCarrierBtn').addEventListener('click', () => {
    const tokenNo = document.getElementById('inviteCarrierLoadSelect').value;
    if (!tokenNo) { document.getElementById('inviteCarrierError').textContent = 'Select a load first.'; return; }
    fetch('/api/broker/loads/' + encodeURIComponent(tokenNo) + '/invite-carrier', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ carrierId: inviteCarrierTargetId }),
    }).then((r) => r.json()).then((data) => {
      if (data.error) { document.getElementById('inviteCarrierError').textContent = data.error; return; }
      document.getElementById('inviteCarrierModal').hidden = true;
      toast('Invitation sent.');
    }).catch(() => { document.getElementById('inviteCarrierError').textContent = 'Could not send that invitation right now.'; });
  });

  function loadMyCarrierConnections() {
    const wrap = document.getElementById('ccConnectionsList');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading…</div>';
    fetch('/api/broker/carrier-connections').then((r) => r.json()).then((rows) => {
      if (rows.error) { document.getElementById('ccConnectionsError').textContent = rows.error; wrap.innerHTML = ''; return; }
      document.getElementById('ccConnectionsError').textContent = '';
      if (!rows.length) { wrap.innerHTML = '<div class="empty-state">No connection requests yet — search carriers above and click Connect.</div>'; return; }
      wrap.innerHTML = rows.map((c) => `
        <div class="load-card" style="margin-bottom:8px;">
          <div class="route">${escapeHtml(c.carrierCompanyName)} <span class="badge ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></div>
          <div class="meta">Requested ${escapeHtml(fmtDateTime(c.createdAt))}${c.respondedAt ? ' · Responded ' + escapeHtml(fmtDateTime(c.respondedAt)) : ''}${c.message ? '<br>Note: ' + escapeHtml(c.message) : ''}</div>
          ${c.status === 'PENDING' ? `<div class="actions"><button type="button" class="btn-secondary" data-cancel-cc="${escapeHtml(c.id)}">Cancel</button></div>` : ''}
        </div>`).join('');
      wrap.querySelectorAll('[data-cancel-cc]').forEach((b) => b.addEventListener('click', () => {
        if (!confirm('Cancel this connection request?')) return;
        fetch('/api/broker/carrier-connections/' + encodeURIComponent(b.dataset.cancelCc), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'CANCELLED' }),
        }).then((r) => r.json()).then((data) => {
          if (data.error) { toast(data.error); return; }
          toast('Connection request cancelled.');
          loadMyCarrierConnections();
          searchCarrierConnectCards();
        }).catch(() => toast('Could not cancel that connection right now.'));
      }));
    }).catch(() => { wrap.innerHTML = ''; document.getElementById('ccConnectionsError').textContent = 'Could not load your connections right now.'; });
  }
  document.getElementById('refreshMyConnectionsBtn').addEventListener('click', loadMyCarrierConnections);

  // ================= Carrier Connect (Broker Automation) =================
  let automationLoadedOnce = false;
  let selectedCarrier = null; // { id, username, companyName, mobileNumber, city, status }

  function loadAutomation() {
    automationLoadedOnce = true;
    searchCarriers('');
    loadSavedLoads();
    loadConnections();
    loadAutomationNotifications();
  }

  function renderCarrierResults(carriers) {
    const wrap = document.getElementById('carrierResultsList');
    if (!carriers || !carriers.length) { wrap.innerHTML = '<div class="empty-state">No verified carriers found.</div>'; return; }
    wrap.innerHTML = carriers.map((c) => `
      <div class="carrier-result-item ${selectedCarrier && selectedCarrier.id === c.id ? 'selected' : ''}">
        <div>
          <div class="name">${escapeHtml(c.companyName)}</div>
          <div class="meta">@${escapeHtml(c.username)} ${c.city ? '· ' + escapeHtml(c.city) : ''} ${c.mobileNumber ? '· ' + escapeHtml(c.mobileNumber) : ''}</div>
        </div>
        <button type="button" class="btn-secondary" data-select-carrier="${escapeHtml(c.id)}">${selectedCarrier && selectedCarrier.id === c.id ? 'Selected' : 'Select'}</button>
      </div>`).join('');
    wrap.querySelectorAll('[data-select-carrier]').forEach((btn) => btn.addEventListener('click', () => {
      const c = carriers.find((x) => x.id === btn.dataset.selectCarrier);
      if (c) selectCarrier(c);
    }));
  }
  function searchCarriers(query) {
    const wrap = document.getElementById('carrierResultsList');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Searching carriers…</div>';
    fetch('/api/broker/carriers' + (query ? '?search=' + encodeURIComponent(query) : '')).then((r) => r.json()).then((data) => {
      if (data.error) { document.getElementById('carrierSearchError').textContent = data.error; wrap.innerHTML = ''; return; }
      document.getElementById('carrierSearchError').textContent = '';
      renderCarrierResults(data);
    }).catch(() => { wrap.innerHTML = ''; document.getElementById('carrierSearchError').textContent = 'Could not search carriers right now.'; });
  }
  document.getElementById('carrierSearchBtn').addEventListener('click', () => searchCarriers(document.getElementById('carrierSearchInput').value.trim()));
  document.getElementById('carrierSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchCarriers(document.getElementById('carrierSearchInput').value.trim()); });

  function selectCarrier(carrier) {
    selectedCarrier = carrier;
    const banner = document.getElementById('selectedCarrierBanner');
    banner.style.display = 'block';
    banner.textContent = `Acting on behalf of: ${carrier.companyName} (@${carrier.username})`;
    document.getElementById('recommendedLoadsCard').style.display = 'block';
    loadRecommendedLoads();
  }

  function loadRecommendedLoads() {
    if (!selectedCarrier) return;
    const wrap = document.getElementById('recommendedLoadsList');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Finding suitable loads for this carrier…</div>';
    fetch('/api/broker/carriers/' + encodeURIComponent(selectedCarrier.id) + '/recommendations').then((r) => r.json()).then((data) => {
      if (data.error) { wrap.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
      const recs = data.recommendations || [];
      if (!recs.length) { wrap.innerHTML = '<div class="empty-state">No suitable load found for this carrier\'s current fleet right now.</div>'; return; }
      wrap.innerHTML = recs.map((r) => `
        <div class="load-card" style="margin-bottom:10px;">
          <div class="route">${escapeHtml(r.pickup)} → ${escapeHtml(r.destination)} <span class="score-badge-inline">${escapeHtml(String(r.matchScore))}</span></div>
          <div class="meta">
            Token ${escapeHtml(r.tokenNo)} · ${escapeHtml(r.requiredTruckType || '—')} · ${escapeHtml(String(r.weight || '—'))} kg<br>
            Best truck: ${escapeHtml(r.bestVehicleNumber || r.bestTruckId)}
            ${r.reduceEmptyTravel ? '<br><span class="badge accepted">May reduce empty travel</span>' : ''}
            ${r.reasons && r.reasons.length ? `<ul class="reasons">${r.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
          </div>
          <div class="actions">
            <button type="button" class="btn-primary" data-save-load="${escapeHtml(r.tokenNo)}">Save for this carrier</button>
          </div>
        </div>`).join('');
      wrap.querySelectorAll('[data-save-load]').forEach((btn) => btn.addEventListener('click', () => saveLoadForCarrier(btn.dataset.saveLoad)));
    }).catch(() => { wrap.innerHTML = '<div class="banner error">Could not load recommendations right now.</div>'; });
  }

  function saveLoadForCarrier(tokenNo) {
    if (!selectedCarrier) { toast('Select a carrier first.'); return; }
    fetch('/api/broker/saved-loads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrierId: selectedCarrier.id, tokenNo }),
    }).then((r) => r.json()).then((data) => {
      if (data.error) { toast(data.error); return; }
      toast('Load saved for ' + selectedCarrier.companyName + '.');
      loadSavedLoads();
    }).catch(() => toast('Could not save that load right now.'));
  }

  function loadSavedLoads() {
    const wrap = document.getElementById('savedLoadsList');
    wrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading saved loads…</div>';
    fetch('/api/broker/saved-loads').then((r) => r.json()).then((rows) => {
      if (rows.error) { document.getElementById('savedLoadsError').textContent = rows.error; wrap.innerHTML = ''; return; }
      document.getElementById('savedLoadsError').textContent = '';
      if (!rows.length) { wrap.innerHTML = '<div class="empty-state">No saved loads yet — select a carrier above and save a recommended load.</div>'; return; }
      wrap.innerHTML = rows.map((r) => `
        <div class="load-card" style="margin-bottom:10px;">
          <div class="route">${escapeHtml(r.loadSnapshot.pickup)} → ${escapeHtml(r.loadSnapshot.destination)} <span class="badge ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></div>
          <div class="meta">
            Token ${escapeHtml(r.loadId)} · For carrier: ${escapeHtml(r.carrierCompanyName)}<br>
            ${escapeHtml(r.loadSnapshot.material || '—')} · ${escapeHtml(String(r.loadSnapshot.weight || '—'))} kg · ${escapeHtml(r.loadSnapshot.requiredTruckType || '—')}<br>
            Saved ${escapeHtml(fmtDateTime(r.createdAt))}
            ${r.liveLoadStage && r.liveLoadStage !== 'BIDDING_OPEN' ? `<br><span class="badge REJECTED">Load is now ${escapeHtml(r.liveLoadStage)} — no longer open</span>` : ''}
          </div>
          <div class="actions">
            <button type="button" class="btn-primary" data-find-trucks="${escapeHtml(r.id)}" data-carrier="${escapeHtml(r.carrierId)}" data-load="${escapeHtml(r.loadId)}" ${r.liveLoadStage && r.liveLoadStage !== 'BIDDING_OPEN' ? 'disabled' : ''}>Find suitable truck</button>
            <button type="button" class="btn-secondary" data-remove-saved="${escapeHtml(r.id)}">Remove</button>
          </div>
        </div>`).join('');
      wrap.querySelectorAll('[data-find-trucks]').forEach((btn) => btn.addEventListener('click', () => openTruckMatchModal(btn.dataset.carrier, btn.dataset.load)));
      wrap.querySelectorAll('[data-remove-saved]').forEach((btn) => btn.addEventListener('click', () => {
        if (!confirm('Remove this saved load?')) return;
        fetch('/api/broker/saved-loads/' + encodeURIComponent(btn.dataset.removeSaved), { method: 'DELETE' }).then((r) => r.json()).then((data) => {
          if (data.error) { toast(data.error); return; }
          toast('Removed.');
          loadSavedLoads();
        }).catch(() => toast('Could not remove that saved load right now.'));
      }));
    }).catch(() => { wrap.innerHTML = ''; document.getElementById('savedLoadsError').textContent = 'Could not load your saved loads right now.'; });
  }
  document.getElementById('refreshSavedLoadsBtn').addEventListener('click', loadSavedLoads);

  function openTruckMatchModal(carrierId, tokenNo) {
    const modal = document.getElementById('truckMatchModal');
    const body = document.getElementById('truckMatchBody');
    body.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Matching this carrier\'s fleet to the load…</div>';
    modal.hidden = false;
    fetch('/api/broker/carriers/' + encodeURIComponent(carrierId) + '/trucks?loadToken=' + encodeURIComponent(tokenNo)).then((r) => r.json()).then((data) => {
      if (data.error) { body.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
      const matches = data.matches || [];
      body.innerHTML = `
        <h2>Suitable trucks — ${escapeHtml(data.carrier.companyName)}</h2>
        <p class="hint">For load ${escapeHtml(data.load.tokenNo)}: ${escapeHtml(data.load.pickup)} → ${escapeHtml(data.load.destination)}</p>
        ${!matches.length ? `<div class="empty-state">${escapeHtml(data.message || 'No suitable truck found. Try another Carrier or adjust the requirements.')}</div>` : matches.map((m) => `
          <div class="load-card" style="margin-bottom:10px;">
            <div class="route">${escapeHtml(m.vehicleNumber || m.truckId)} <span class="score-badge-inline">${escapeHtml(String(m.matchScore))}</span></div>
            <div class="meta">
              ${escapeHtml(m.truckType || '—')} ${escapeHtml(m.bodyType || '')} · ${escapeHtml(String(m.capacityTons || '—'))} T · ${escapeHtml(m.complianceStatus)}<br>
              ${m.driverName ? 'Driver: ' + escapeHtml(m.driverName) + (m.driverAvailable === false ? ' (currently unavailable)' : '') + '<br>' : 'No driver linked yet<br>'}
              Currently at ${escapeHtml(m.currentLocation || '—')}
              <ul class="reasons">${m.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
              <em>${escapeHtml(m.recommendation)}</em>
            </div>
            <div class="actions">
              <button type="button" class="btn-primary" data-request-connection="${escapeHtml(m.truckId)}">Select truck → Request Shipper connection</button>
            </div>
          </div>`).join('')}
        ${data.ineligible && data.ineligible.length ? `<h2 style="font-size:14px; margin-top:16px;">Not eligible (${data.ineligible.length})</h2>${data.ineligible.map((t) => `<div class="empty-state" style="text-align:left; padding:8px 4px;">${escapeHtml(t.vehicleNumber || t.truckId)}: ${escapeHtml((t.reasons || []).join('; '))}</div>`).join('')}` : ''}
      `;
      body.querySelectorAll('[data-request-connection]').forEach((btn) => btn.addEventListener('click', () => {
        if (!confirm('Request a Shipper connection for this carrier and truck? This notifies the shipper and carrier — it does not accept the load or assign the truck by itself.')) return;
        requestShipperConnection(carrierId, tokenNo, btn.dataset.requestConnection);
      }));
    }).catch(() => { body.innerHTML = '<div class="banner error">Could not load truck matches right now.</div>'; });
  }
  document.getElementById('closeTruckMatchModal').addEventListener('click', () => { document.getElementById('truckMatchModal').hidden = true; });

  function requestShipperConnection(carrierId, tokenNo, truckId) {
    fetch('/api/broker/connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrierId, tokenNo, truckId }),
    }).then((r) => r.json()).then((data) => {
      if (data.error) { toast(data.error); return; }
      document.getElementById('truckMatchModal').hidden = true;
      toast('Connection request sent — shipper and carrier notified.');
      loadConnections();
      loadSavedLoads();
    }).catch(() => toast('Could not create that connection request right now.'));
  }

  const CONNECTION_ACTIVE_STATUSES = ['pending', 'shipper_notified', 'carrier_notified', 'negotiating'];
  function connectionCard(c) {
    const status = c.displayStatus || c.status;
    return `
      <div class="load-card" style="margin-bottom:10px;">
        <div class="route">${c.load ? escapeHtml(c.load.pickup) + ' → ' + escapeHtml(c.load.destination) : 'Load ' + escapeHtml(c.loadId)} <span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span></div>
        <div class="meta">
          Token ${escapeHtml(c.loadId)} · Carrier: ${escapeHtml(c.carrierCompanyName)} · Truck ${escapeHtml(c.vehicleNumber || c.truckId)}<br>
          ${c.shipperCompanyName ? 'Shipper: ' + escapeHtml(c.shipperCompanyName) + '<br>' : ''}
          ${c.bid ? 'Offer: ' + escapeHtml(fmtInr(c.bid.bidAmount)) + ' (' + escapeHtml(c.bid.status) + ')<br>' : ''}
          Requested ${escapeHtml(fmtDateTime(c.createdAt))}
        </div>
        ${CONNECTION_ACTIVE_STATUSES.includes(status) ? `
        <div class="actions">
          ${status !== 'negotiating' ? `<button type="button" class="btn-primary" data-place-offer="${escapeHtml(c.id)}" data-route="${escapeHtml((c.load ? c.load.pickup + ' → ' + c.load.destination : c.loadId))}">Place offer</button>` : `<button type="button" class="btn-secondary" data-place-offer="${escapeHtml(c.id)}" data-route="${escapeHtml((c.load ? c.load.pickup + ' → ' + c.load.destination : c.loadId))}">Update offer</button>`}
          <button type="button" class="btn-secondary" data-cancel-connection="${escapeHtml(c.id)}">Cancel</button>
        </div>` : ''}
      </div>`;
  }
  function loadConnections() {
    const activeWrap = document.getElementById('activeConnectionsList');
    const pastWrap = document.getElementById('pastConnectionsList');
    activeWrap.innerHTML = '<div class="empty-state"><span class="ls-spinner"></span> Loading your connection requests…</div>';
    fetch('/api/broker/connections').then((r) => r.json()).then((rows) => {
      if (rows.error) { document.getElementById('connectionsError').textContent = rows.error; activeWrap.innerHTML = ''; return; }
      document.getElementById('connectionsError').textContent = '';
      const active = rows.filter((c) => CONNECTION_ACTIVE_STATUSES.includes(c.displayStatus || c.status));
      const past = rows.filter((c) => !CONNECTION_ACTIVE_STATUSES.includes(c.displayStatus || c.status));
      activeWrap.innerHTML = active.length ? active.map(connectionCard).join('') : '<div class="empty-state">No active connection requests yet.</div>';
      pastWrap.innerHTML = past.length ? past.map(connectionCard).join('') : '<div class="empty-state">Nothing here yet.</div>';
      document.querySelectorAll('[data-place-offer]').forEach((btn) => btn.addEventListener('click', () => openConnectionBidModal(btn.dataset.placeOffer, btn.dataset.route)));
      document.querySelectorAll('[data-cancel-connection]').forEach((btn) => btn.addEventListener('click', () => {
        if (!confirm('Cancel this connection request?')) return;
        fetch('/api/broker/connections/' + encodeURIComponent(btn.dataset.cancelConnection) + '/status', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
        }).then((r) => r.json()).then((data) => {
          if (data.error) { toast(data.error); return; }
          toast('Connection cancelled.');
          loadConnections();
        }).catch(() => toast('Could not cancel that connection right now.'));
      }));
    }).catch(() => { activeWrap.innerHTML = ''; document.getElementById('connectionsError').textContent = 'Could not load your connections right now.'; });
  }

  let connectionBidId = null;
  function openConnectionBidModal(connectionId, routeLabel) {
    connectionBidId = connectionId;
    document.getElementById('connectionBidError').textContent = '';
    document.getElementById('connectionBidAmount').value = '';
    document.getElementById('connectionBidNotes').value = '';
    document.getElementById('connectionBidContext').textContent = routeLabel || '';
    document.getElementById('connectionBidModal').hidden = false;
  }
  document.getElementById('closeConnectionBidModal').addEventListener('click', () => { document.getElementById('connectionBidModal').hidden = true; });
  document.getElementById('submitConnectionBidBtn').addEventListener('click', () => {
    const bidAmount = Number(document.getElementById('connectionBidAmount').value);
    const notes = document.getElementById('connectionBidNotes').value;
    const errBox = document.getElementById('connectionBidError');
    if (!bidAmount || bidAmount <= 0) { errBox.textContent = 'Enter a valid offer amount.'; return; }
    errBox.textContent = '';
    fetch('/api/broker/connections/' + encodeURIComponent(connectionBidId) + '/bid', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bidAmount, notes }),
    }).then((r) => r.json()).then((data) => {
      if (data.error) { errBox.textContent = data.error; return; }
      document.getElementById('connectionBidModal').hidden = true;
      toast('Offer submitted — negotiation started.');
      loadConnections();
    }).catch(() => { errBox.textContent = 'Could not submit that offer right now.'; });
  });

  function loadAutomationNotifications() {
    const wrap = document.getElementById('automationNotifList');
    fetch('/api/notifications').then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!data) return;
      const items = (data.notifications || []).slice(0, 8);
      if (!items.length) { wrap.innerHTML = '<div class="empty-state">No notifications yet.</div>'; return; }
      wrap.innerHTML = items.map((n) => `
        <div class="timeline-item">
          <span class="dot"></span>
          <div>
            <div class="t">${escapeHtml(fmtDateTime(n.createdAt))} ${n.read ? '' : '· <b>New</b>'}</div>
            <div class="l">${escapeHtml(n.title)}</div>
            <div class="d">${escapeHtml(n.message)}</div>
          </div>
        </div>`).join('');
    }).catch(() => {});
  }

  // ================= Profile =================
  let profileLoadedOnce = false;
  function loadProfileForm() {
    profileLoadedOnce = true;
    fetch('/api/broker/profile').then((r) => r.json()).then((rec) => {
      if (rec.error) { toast(rec.error); return; }
      document.getElementById('profContactPerson').value = rec.contactPerson || '';
      document.getElementById('profCompanyName').value = rec.companyName || '';
      document.getElementById('profMobile').value = rec.mobileNumber || '';
      document.getElementById('profAddressLine').value = (rec.address && rec.address.addressLine) || '';
      document.getElementById('profCity').value = (rec.address && rec.address.city) || '';
      document.getElementById('profState').value = (rec.address && rec.address.state) || '';
      document.getElementById('profPincode').value = (rec.address && rec.address.pincode) || '';
      const prefs = rec.loadPreferences || {};
      document.getElementById('prefOrigins').value = (prefs.preferredOrigins || []).join(', ');
      document.getElementById('prefDestinations').value = (prefs.preferredDestinations || []).join(', ');
      document.getElementById('prefTruckTypes').value = (prefs.preferredTruckTypes || []).join(', ');
      document.getElementById('prefLoadCategories').value = (prefs.preferredLoadCategories || []).join(', ');
    }).catch(() => toast('Could not load your profile right now.'));
  }
  function splitCsv(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }
  document.getElementById('saveProfileBtn').addEventListener('click', () => {
    const errBox = document.getElementById('profileError');
    const okBox = document.getElementById('profileSuccess');
    errBox.textContent = ''; okBox.textContent = '';
    fetch('/api/broker/profile', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactPerson: document.getElementById('profContactPerson').value,
        companyName: document.getElementById('profCompanyName').value,
        mobileNumber: document.getElementById('profMobile').value,
        address: {
          addressLine: document.getElementById('profAddressLine').value,
          city: document.getElementById('profCity').value,
          state: document.getElementById('profState').value,
          pincode: document.getElementById('profPincode').value,
        },
      }),
    }).then((r) => r.json()).then((data) => {
      if (data.error) { errBox.textContent = data.error; return; }
      okBox.textContent = 'Profile updated.';
      toast('Profile saved.');
    }).catch(() => { errBox.textContent = 'Could not save your profile right now.'; });
  });
  document.getElementById('savePrefsBtn').addEventListener('click', () => {
    fetch('/api/broker/profile', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loadPreferences: {
          preferredOrigins: splitCsv(document.getElementById('prefOrigins').value),
          preferredDestinations: splitCsv(document.getElementById('prefDestinations').value),
          preferredTruckTypes: splitCsv(document.getElementById('prefTruckTypes').value),
          preferredLoadCategories: splitCsv(document.getElementById('prefLoadCategories').value),
        },
      }),
    }).then((r) => r.json()).then((data) => {
      if (data.error) { toast(data.error); return; }
      toast('Preferences saved — your Opportunity Radar will reflect these next time you load the dashboard.');
      loadDashboard();
    }).catch(() => toast('Could not save your preferences right now.'));
  });
})();
