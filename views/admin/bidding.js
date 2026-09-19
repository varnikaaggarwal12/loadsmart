  let allLoads = [];
  let view = 'list'; // 'list' | 'detail'
  let selectedToken = null;
  let detailCache = null; // { load, bids } for selectedToken, populated once the detail fetch resolves

  function formatINR(n) { return n == null || n === '' ? '—' : '₹' + Number(n).toLocaleString('en-IN'); }
  function formatDateTime(v) { return v ? new Date(v).toLocaleString() : '—'; }
  function escapeHtml(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ---------- Load stage pill (reused for every loadStage value the bidding endpoints can return) ----------
  const STAGE_META = {
    BIDDING_OPEN:        { label: 'Bidding Open',      bg: '#e8722c', fg: '#3d2a12' },
    POSTED:              { label: 'Posted',            bg: '#c8cfc8', fg: '#17251d' },
    ASSIGNED:            { label: 'Assigned',          bg: '#c8cfc8', fg: '#17251d' },
    DRIVER_ACCEPTED:     { label: 'Driver Accepted',   bg: '#c8cfc8', fg: '#17251d' },
    ARRIVED_PICKUP:      { label: 'Arrived Pickup',    bg: '#c8cfc8', fg: '#17251d' },
    LOADING:             { label: 'Loading',           bg: '#c8cfc8', fg: '#17251d' },
    LOADED:              { label: 'Loaded',            bg: '#c8cfc8', fg: '#17251d' },
    DEPARTED_PICKUP:     { label: 'Departed Pickup',   bg: '#c8cfc8', fg: '#17251d' },
    IN_TRANSIT:          { label: 'In Transit',        bg: '#c8cfc8', fg: '#17251d' },
    REACHED_DESTINATION: { label: 'Reached Dest.',     bg: '#c8cfc8', fg: '#17251d' },
    UNLOADING:           { label: 'Unloading',         bg: '#c8cfc8', fg: '#17251d' },
    UNLOADING_COMPLETE:  { label: 'Unloading Done',    bg: '#c8cfc8', fg: '#17251d' },
    DELIVERED:           { label: 'Delivered',         bg: '#9adf8f', fg: '#0e3a24' },
    COMPLETED:           { label: 'Completed',         bg: '#9adf8f', fg: '#0e3a24' },
  };
  function stagePillHtml(stage) {
    const m = STAGE_META[stage] || { label: stage || '—', bg: '#c8cfc8', fg: '#17251d' };
    return '<span class="status-pill" style="background:' + m.bg + '; color:' + m.fg + ';">' + m.label + '</span>';
  }

  // ---------- Bid status pill ----------
  const BID_STATUS_META = {
    SUBMITTED:   { label: 'Submitted',   bg: '#cfe3f5', fg: '#0d3a5c' },
    SHORTLISTED: { label: 'Shortlisted', bg: '#e8722c', fg: '#3d2a12' },
    ACCEPTED:    { label: 'Accepted',    bg: '#9adf8f', fg: '#0e3a24' },
    REJECTED:    { label: 'Rejected',    bg: '#c0392b', fg: '#fff' },
    WITHDRAWN:   { label: 'Withdrawn',   bg: '#c8cfc8', fg: '#5c6a61' },
    EXPIRED:     { label: 'Expired',     bg: '#c8cfc8', fg: '#5c6a61' },
  };
  function bidStatusPillHtml(status) {
    const m = BID_STATUS_META[status] || { label: status || '—', bg: '#c8cfc8', fg: '#5c6a61' };
    return '<span class="status-pill" style="background:' + m.bg + '; color:' + m.fg + ';">' + m.label + '</span>';
  }

  function marginLineHtml(b) {
    if (b.marginType == null || b.marginValue == null) return '—';
    const valueLabel = b.marginType === 'PERCENTAGE' ? (Number(b.marginValue) + '%') : formatINR(b.marginValue);
    const amtLabel = b.marginAmount != null ? formatINR(b.marginAmount) : '—';
    return escapeHtml(b.marginType) + ' ' + escapeHtml(valueLabel) + ' <span class="margin-amt">(' + escapeHtml(amtLabel) + ')</span>';
  }

  // ---------- AI Risk Assessment (per bid) ----------
  // Keyed by bid id so a result survives the 15s silent poll re-rendering
  // the whole detail view (see loadDetail's `{ silent: true }` call below) —
  // without this cache the panel would flash away under the admin's cursor
  // a few seconds after they asked for it.
  let aiAssessmentCache = {};
  const AI_REC_META = {
    ACCEPT:  { label: 'ACCEPT',  bg: '#9adf8f', fg: '#0e3a24' },
    REVIEW:  { label: 'REVIEW',  bg: '#e8722c', fg: '#3d2a12' },
    CAUTION: { label: 'CAUTION', bg: '#c0392b', fg: '#fff' },
  };
  function aiRecBadgeHtml(rec) {
    const m = AI_REC_META[rec] || { label: rec || '—', bg: '#c8cfc8', fg: '#17251d' };
    return '<span class="ai-rec-badge" style="background:' + m.bg + '; color:' + m.fg + ';">' + escapeHtml(m.label) + '</span>';
  }
  function aiPanelHtml(bidId) {
    const state = aiAssessmentCache[bidId];
    if (!state) return '';
    if (state.status === 'loading') return '<div class="ai-assess-result"><span class="ls-spinner"></span> Assessing…</div>';
    if (state.status === 'not_configured') return '<div class="ai-muted-note">AI isn\'t configured on this server yet — set ANTHROPIC_API_KEY to enable this.</div>';
    if (state.status === 'error') return '<div class="ai-error-note">' + escapeHtml(state.error) + '</div>';
    if (state.status === 'done') {
      return '<div class="ai-assess-result">' +
        aiRecBadgeHtml(state.recommendation) +
        '<p class="ai-assess-text">' + escapeHtml(state.assessment) + '</p>' +
        (state.concerns && state.concerns.length ? '<ul class="ai-concerns-list">' + state.concerns.map(c => '<li>' + escapeHtml(c) + '</li>').join('') + '</ul>' : '') +
        '</div>';
    }
    return '';
  }
  function runBidAssessment(tokenNo, bidId, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Assessing…';
    aiAssessmentCache[bidId] = { status: 'loading' };
    const panel = document.getElementById('ai-panel-' + bidId);
    if (panel) panel.innerHTML = aiPanelHtml(bidId);
    fetch('/api/admin/ai/bid-assessment/' + encodeURIComponent(tokenNo) + '/' + encodeURIComponent(bidId), { method: 'POST' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (r.status === 503 && d.aiNotConfigured) { aiAssessmentCache[bidId] = { status: 'not_configured' }; return; }
        if (!r.ok) { aiAssessmentCache[bidId] = { status: 'error', error: d.error || 'The AI assessment failed. Please try again.' }; return; }
        aiAssessmentCache[bidId] = { status: 'done', recommendation: d.recommendation, assessment: d.assessment, concerns: d.concerns || [] };
      })
      .catch(() => { aiAssessmentCache[bidId] = { status: 'error', error: 'Could not reach the AI service. Please try again.' }; })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = '🤖 AI Assessment';
        const panel2 = document.getElementById('ai-panel-' + bidId);
        if (panel2) panel2.innerHTML = aiPanelHtml(bidId);
      });
  }

  function bidCardHtml(b, load) {
    const isWinner = load.winningBidId && b.id === load.winningBidId;
    return `
      <div class="bid-card ${isWinner ? 'winner' : ''}" data-bid-id="${escapeHtml(b.id)}">
        <div class="bid-card-top">
          <div>
            <span class="bid-carrier">${escapeHtml(b.carrierCompanyName || b.carrierUsername || '—')}${isWinner ? '<span class="winner-tag">★ Winning Bid</span>' : ''}</span>
            <div class="bid-sub">${escapeHtml(b.vehicleNumber || '—')} · Submitted ${formatDateTime(b.createdAt)}</div>
          </div>
          ${bidStatusPillHtml(b.status)}
        </div>
        <div class="bid-grid">
          <div class="bid-item"><b>Carrier Bid Amount</b><span>${formatINR(b.bidAmount)}</span></div>
          <div class="bid-item"><b>LoadSmart Margin</b><span>${marginLineHtml(b)}</span></div>
          <div class="bid-item final"><b>Final Shipper Price</b><span>${formatINR(b.finalShipperPrice)}</span></div>
          <div class="bid-item"><b>AI Match Score</b><span class="score-badge">${b.aiMatchScore != null ? b.aiMatchScore + '%' : '—'}</span></div>
          <div class="bid-item"><b>Trust Score</b><span>${b.trustScore != null ? b.trustScore + '/100' : '—'}</span></div>
        </div>
        ${b.notes ? '<div class="bid-notes"><b>Notes:</b> ' + escapeHtml(b.notes) + '</div>' : ''}
        <div class="ai-assess-row">
          <button type="button" class="ai-assess-btn" data-ai-bid-id="${escapeHtml(b.id)}">🤖 AI Assessment</button>
          <div class="ai-assess-panel" id="ai-panel-${escapeHtml(b.id)}">${aiPanelHtml(b.id)}</div>
        </div>
      </div>`;
  }

  // ---------- List view ----------
  function renderList(loads, query) {
    const countLine = document.getElementById('countLine');
    const wrap = document.getElementById('contentWrap');

    if (!allLoads.length) {
      countLine.textContent = 'No loads are currently open for bidding.';
      wrap.innerHTML = '<div class="empty-state">Nothing here yet — loads opened for carrier bidding will appear automatically.</div>';
      return;
    }
    if (!loads.length) {
      countLine.textContent = '0 of ' + allLoads.length + ' loads match your search.';
      wrap.innerHTML = LS.noResultsHtml('No loads match "' + escapeHtml(query || '') + '".');
      return;
    }
    countLine.textContent = query
      ? loads.length + ' of ' + allLoads.length + ' load' + (allLoads.length === 1 ? '' : 's') + ' match your search.'
      : loads.length + ' load' + (loads.length === 1 ? '' : 's') + ' in the bidding pipeline.';

    wrap.innerHTML = `
      <div class="bid-table-wrap">
        <table>
          <thead>
            <tr><th>Route</th><th>Token No.</th><th>Shipper</th><th>Stage</th><th>Bids</th><th>Bidding Deadline</th><th></th></tr>
          </thead>
          <tbody>
            ${loads.map(l => `
              <tr data-token="${escapeHtml(l.tokenNo)}">
                <td>${escapeHtml(l.pickup || '—')} → ${escapeHtml(l.destination || '—')}</td>
                <td><span class="id-badge">${escapeHtml(l.tokenNo)}</span></td>
                <td>${escapeHtml(l.companyName || '—')}</td>
                <td>${stagePillHtml(l.loadStage)}</td>
                <td>${l.bidCount != null ? l.bidCount : 0}</td>
                <td>${formatDateTime(l.biddingDeadline)}</td>
                <td><button type="button" class="view-bids-btn" data-view="${escapeHtml(l.tokenNo)}">View Bids</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    wrap.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', () => selectLoad(btn.getAttribute('data-view')));
    });
  }

  // ---------- Detail view ----------
  function renderDetail() {
    const countLine = document.getElementById('countLine');
    const wrap = document.getElementById('contentWrap');
    countLine.textContent = '';

    if (!detailCache || detailCache.load.tokenNo !== selectedToken) {
      wrap.innerHTML = '<button type="button" class="back-to-list-btn" id="bidBackBtn">← Back to all loads</button><div class="empty-state"><span class="ls-spinner"></span> Loading bid detail…</div>';
      document.getElementById('bidBackBtn').addEventListener('click', backToList);
      return;
    }

    const load = detailCache.load;
    const bids = detailCache.bids || [];
    const canClose = load.loadStage === 'BIDDING_OPEN';

    wrap.innerHTML = `
      <button type="button" class="back-to-list-btn" id="bidBackBtn">← Back to all loads</button>

      <div class="shipper-detail-head">
        <div>
          <h2>${escapeHtml(load.tokenNo)}</h2>
          <div class="sub">${escapeHtml(load.pickup || '—')} → ${escapeHtml(load.destination || '—')}</div>
        </div>
        <div class="shipper-detail-actions">
          ${stagePillHtml(load.loadStage)}
          ${canClose ? '<button type="button" class="close-bidding-btn" id="closeBiddingBtn">Close Bidding</button>' : ''}
        </div>
      </div>

      <div class="detail-section">
        <h3>Load Info</h3>
        <div class="detail-grid">
          <div class="drow"><span class="k">Token No.</span><span class="v">${escapeHtml(load.tokenNo)}</span></div>
          <div class="drow"><span class="k">Bidding Deadline</span><span class="v">${formatDateTime(load.biddingDeadline)}</span></div>
          <div class="drow"><span class="k">Winning Bid ID</span><span class="v">${load.winningBidId ? escapeHtml(load.winningBidId) : '—'}</span></div>
          <div class="drow"><span class="k">Total Bids</span><span class="v">${bids.length}</span></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Bids (${bids.length})</h3>
        ${bids.length ? bids.map(b => bidCardHtml(b, load)).join('') : '<p style="font-size:13px; color:#7a867e;">No bids have been submitted on this load yet.</p>'}
      </div>
    `;

    document.getElementById('bidBackBtn').addEventListener('click', backToList);
    const closeBtn = document.getElementById('closeBiddingBtn');
    if (closeBtn) closeBtn.addEventListener('click', () => closeBidding(load.tokenNo));
    wrap.querySelectorAll('.ai-assess-btn').forEach(btn => {
      const bidId = btn.getAttribute('data-ai-bid-id');
      btn.addEventListener('click', () => runBidAssessment(load.tokenNo, bidId, btn));
    });
  }

  function renderView() {
    if (view === 'detail') { renderDetail(); return; }
    renderList(allLoads, document.getElementById('biddingSearchInput').value.trim());
  }

  // ---------- Navigation ----------
  function selectLoad(tokenNo) {
    view = 'detail';
    selectedToken = tokenNo;
    detailCache = null;
    aiAssessmentCache = {};
    renderView();
    loadDetail(tokenNo);
  }

  function backToList() {
    view = 'list';
    selectedToken = null;
    detailCache = null;
    aiAssessmentCache = {};
    renderView();
  }

  // ---------- Data loading ----------
  function loadList(opts) {
    const forceRerender = !opts || opts.forceRerender !== false;
    const btn = document.getElementById('refreshBtn');
    if (btn && forceRerender) { btn.disabled = true; btn.textContent = '🔄 Refreshing…'; }
    return fetch('/api/admin/bidding/loads?_=' + Date.now())
      .then(res => res.json())
      .then(loads => {
        allLoads = loads;
        const note = document.getElementById('lastUpdatedNote');
        if (note) note.textContent = 'Last updated: ' + new Date().toLocaleTimeString();
        if (view === 'list') renderList(allLoads, document.getElementById('biddingSearchInput').value.trim());
      })
      .catch(() => {
        if (view === 'list') document.getElementById('countLine').textContent = 'Could not load data.';
      })
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
      });
  }

  function loadDetail(tokenNo, opts) {
    const silent = opts && opts.silent;
    return fetch('/api/admin/loads/' + encodeURIComponent(tokenNo) + '/bids?_=' + Date.now())
      .then(res => res.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        // The user may have navigated back to the list (or to a different
        // load) while this request was in flight — only apply it if it's
        // still relevant.
        if (selectedToken !== tokenNo) return;
        detailCache = data;
        if (view === 'detail') renderDetail();
      })
      .catch(err => {
        if (silent || selectedToken !== tokenNo) return;
        document.getElementById('contentWrap').innerHTML =
          '<button type="button" class="back-to-list-btn" id="bidBackBtn">← Back to all loads</button><div class="empty-state">Could not load bid details' + (err.message ? ': ' + escapeHtml(err.message) : '.') + '</div>';
        document.getElementById('bidBackBtn').addEventListener('click', backToList);
      });
  }

  function closeBidding(tokenNo) {
    if (!window.confirm('Close bidding on this load without selecting a carrier? All active bids will be rejected.')) return;
    const btn = document.getElementById('closeBiddingBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Closing…'; }
    fetch('/api/admin/loads/' + encodeURIComponent(tokenNo) + '/close-bidding', { method: 'POST' })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not close bidding.');
        return d;
      })
      .then(() => {
        if (window.LS && LS.showSuccess) LS.showSuccess('Bidding closed.');
        backToList();
        loadList();
      })
      .catch(err => {
        alert(err.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Close Bidding'; }
        loadDetail(tokenNo);
      });
  }

  // ---------- Init ----------
  loadList();
  document.getElementById('refreshBtn').addEventListener('click', () => loadList());

  // Local, instant filter over the already-loaded queue (route/token/shipper).
  LS.wireLocalSearch({
    inputEl: document.getElementById('biddingSearchInput'),
    getRecords: () => allLoads,
    fields: ['tokenNo', 'pickup', 'destination', 'companyName'],
    onResults: (filtered, query) => { if (view === 'list') renderList(filtered, query); },
  });

  // Poll so a newly submitted bid (or a deadline passing) shows up on an
  // already-open admin page without a manual refresh — same pattern the
  // rest of the admin portal uses. While a load's bid detail is open, quietly
  // refresh that load's bids in place instead of the whole list.
  setInterval(() => {
    if (view === 'list') loadList({ forceRerender: false });
    else if (view === 'detail' && selectedToken) loadDetail(selectedToken, { silent: true });
  }, 15000);
