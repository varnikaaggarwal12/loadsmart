  let allRecords = [];
  let view = 'list'; // 'list' | 'detail'
  let detailId = null;

  function formatINR(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN'); }
  function escapeHtml(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  const STATUS_META = {
    pending:   { label: 'Pending',                  bg: '#e8722c', fg: '#3d2a12' },
    countered: { label: 'Awaiting Shipper Response', bg: '#c8cfc8', fg: '#17251d' },
    accepted:  { label: 'Accepted',                  bg: '#9adf8f', fg: '#0e3a24' },
    rejected:  { label: 'Rejected',                  bg: '#c0392b', fg: '#fff' },
  };
  function statusPillHtml(st){
    const m = STATUS_META[st || 'pending'] || STATUS_META.pending;
    return '<span class="status-pill" style="background:' + m.bg + '; color:' + m.fg + ';">' + m.label + '</span>';
  }

  // ---------- AI Load Assessment ----------
  // Keyed by record id. The detail view isn't re-rendered by the background
  // poll (see loadRecords' `if (view === 'detail' && !forceRerender) return;`
  // below) so this doesn't strictly need to survive a re-render the way
  // bidding.js's per-bid cache does — kept anyway so a manual Refresh click
  // while viewing a detail doesn't wipe a result the admin just asked for.
  let aiLoadAssessmentCache = {};
  const AI_REC_META = {
    APPROVE: { label: 'APPROVE', bg: '#9adf8f', fg: '#0e3a24' },
    REVIEW:  { label: 'REVIEW',  bg: '#e8722c', fg: '#3d2a12' },
    CAUTION: { label: 'CAUTION', bg: '#c0392b', fg: '#fff' },
  };
  function aiRecBadgeHtml(rec) {
    const m = AI_REC_META[rec] || { label: rec || '—', bg: '#c8cfc8', fg: '#17251d' };
    return '<span class="ai-rec-badge" style="background:' + m.bg + '; color:' + m.fg + ';">' + escapeHtml(m.label) + '</span>';
  }
  function aiPanelHtml(id) {
    const state = aiLoadAssessmentCache[id];
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
  function runLoadAssessment(tokenNo, id, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Assessing…';
    aiLoadAssessmentCache[id] = { status: 'loading' };
    const panel = document.getElementById('ai-load-panel-' + id);
    if (panel) panel.innerHTML = aiPanelHtml(id);
    fetch('/api/admin/ai/load-assessment/' + encodeURIComponent(tokenNo), { method: 'POST' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (r.status === 503 && d.aiNotConfigured) { aiLoadAssessmentCache[id] = { status: 'not_configured' }; return; }
        if (!r.ok) { aiLoadAssessmentCache[id] = { status: 'error', error: d.error || 'The AI assessment failed. Please try again.' }; return; }
        aiLoadAssessmentCache[id] = { status: 'done', recommendation: d.recommendation, assessment: d.assessment, concerns: d.concerns || [] };
      })
      .catch(() => { aiLoadAssessmentCache[id] = { status: 'error', error: 'Could not reach the AI service. Please try again.' }; })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = '🤖 AI Assessment';
        const panel2 = document.getElementById('ai-load-panel-' + id);
        if (panel2) panel2.innerHTML = aiPanelHtml(id);
      });
  }

  function renderTable(records, query) {
    if (view === 'detail' && detailId) {
      const rec = allRecords.find(r => r.id === detailId);
      if (!rec) { view = 'list'; detailId = null; }
      else { document.getElementById('countLine').textContent = ''; renderDetail(rec); return; }
    }

    const countLine = document.getElementById('countLine');
    const wrap = document.getElementById('tableWrap');

    if (!allRecords.length) {
      countLine.textContent = 'No bookings or rate requests yet.';
      wrap.innerHTML = '<div class="empty-state">Nothing here yet — Estimate &amp; Booking activity from shippers will appear automatically.</div>';
      return;
    }
    if (!records.length) {
      countLine.textContent = '0 of ' + allRecords.length + ' requests match your search.';
      wrap.innerHTML = LS.noResultsHtml('No bookings or rate requests match "' + escapeHtml(query || '') + '".');
      return;
    }
    countLine.textContent = query
      ? records.length + ' of ' + allRecords.length + ' request' + (allRecords.length === 1 ? '' : 's') + ' match your search.'
      : records.length + ' request' + (records.length === 1 ? '' : 's') + ' on file.';

    // The backend already returns these sorted newest-first
    // (.sort({createdAt:-1})) — no .reverse() here, since that would flip
    // it back to oldest-first and bury every new request at the bottom.
    // Because this always reflects the same underlying sort order, a new
    // rate request lands at the top automatically, every time, with
    // nothing to remember or re-configure.
    wrap.innerHTML = '<div class="rr-card-grid">' + records.map(r => `
      <div class="rr-card" data-id="${escapeHtml(r.id)}">
        <div class="rr-top">
          <span class="id-badge">${escapeHtml(r.tokenNo || r.id)}</span>
          <span class="kind-badge ${r.kind}">${r.kind === 'booking' ? 'Booking' : 'Rate request'}</span>
        </div>
        <div class="rr-shipper">${escapeHtml(r.companyName || r.shipperUsername || '—')}</div>
        <div class="rr-route">${escapeHtml(r.pickup || '—')} → ${escapeHtml(r.destination || '—')}</div>
        <div class="rr-bottom">
          ${statusPillHtml(r.status)}
          <span class="rr-rate">${formatINR(r.requestedRate)}</span>
        </div>
      </div>
    `).join('') + '</div>';

    wrap.querySelectorAll('.rr-card').forEach(card => {
      card.addEventListener('click', () => {
        view = 'detail';
        detailId = card.getAttribute('data-id');
        aiLoadAssessmentCache = {};
        renderTable(allRecords, '');
      });
    });
  }

  function renderDetail(r) {
    const wrap = document.getElementById('tableWrap');
    const st = r.status || 'pending';
    const isFinal = st === 'accepted' || st === 'rejected';
    const providerLabel = r.carrierCompanyName
      ? r.carrierCompanyName + ' (Carrier)'
      : (r.brokerCompanyName ? r.brokerCompanyName + ' (Broker)' : 'Not selected — any provider');

    wrap.innerHTML = `
      <button type="button" class="back-to-list-btn" id="rrBackBtn">← Back to all requests</button>

      <div class="shipper-detail-head">
        <div>
          <h2>${escapeHtml(r.tokenNo || r.id)}</h2>
          <div class="sub">${r.kind === 'booking' ? 'Booking' : 'Rate request'} · Shipper <b>${escapeHtml(r.companyName || r.shipperUsername || '—')}</b></div>
        </div>
        <div class="shipper-detail-actions">
          ${statusPillHtml(st)}
        </div>
      </div>

      <div class="detail-section">
        <h3>Request Info</h3>
        <div class="detail-grid">
          <div class="drow"><span class="k">Request / Token ID</span><span class="v">${escapeHtml(r.tokenNo || r.id)}</span></div>
          <div class="drow"><span class="k">Reference</span><span class="v">${escapeHtml(r.id)}</span></div>
          <div class="drow"><span class="k">Shipper</span><span class="v">${escapeHtml(r.companyName || r.shipperUsername || '—')}</span></div>
          <div class="drow"><span class="k">Requested Provider</span><span class="v">${escapeHtml(providerLabel)}</span></div>
          <div class="drow"><span class="k">Date / Time</span><span class="v">${r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}</span></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Pickup &amp; Delivery</h3>
        <div class="detail-grid">
          <div class="drow"><span class="k">Pickup Location</span><span class="v">${escapeHtml(r.pickup || '—')}</span></div>
          <div class="drow"><span class="k">Delivery Destination</span><span class="v">${escapeHtml(r.destination || '—')}</span></div>
          ${r.pickupAddress ? '<div class="drow"><span class="k">Pickup Full Address</span><span class="v">' + escapeHtml(r.pickupAddress) + '</span></div>' : ''}
          ${r.destAddress ? '<div class="drow"><span class="k">Delivery Full Address</span><span class="v">' + escapeHtml(r.destAddress) + '</span></div>' : ''}
          <div class="drow"><span class="k">Distance</span><span class="v">${r.distanceKm != null ? r.distanceKm + ' km' : '—'}</span></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Vehicle / Load Info</h3>
        <div class="detail-grid">
          <div class="drow"><span class="k">Material</span><span class="v">${escapeHtml(r.material || '—')}</span></div>
          <div class="drow"><span class="k">Weight</span><span class="v">${r.weight != null ? r.weight + ' tons' : '—'}</span></div>
          <div class="drow"><span class="k">Vehicle Requirement</span><span class="v">${escapeHtml(r.requiredTruckType || 'Any')}</span></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Rate Info</h3>
        <div class="detail-grid">
          <div class="drow"><span class="k">Estimated Rate</span><span class="v">${formatINR(r.estimatedRate)}</span></div>
          <div class="drow"><span class="k">Shipper Requested Rate</span><span class="v">${formatINR(r.requestedRate)}</span></div>
          <div class="drow"><span class="k">Min Allowed Rate</span><span class="v">${formatINR(r.minAllowedRate)}</span></div>
          <div class="drow"><span class="k">Admin Counter Rate</span><span class="v">${formatINR(r.adminOfferedRate)}</span></div>
          ${r.finalRate != null ? '<div class="drow"><span class="k">Final Agreed Rate</span><span class="v" style="color:var(--green-deep);">' + formatINR(r.finalRate) + '</span></div>' : ''}
          ${r.rejectionReason ? '<div class="drow"><span class="k">Rejection Reason</span><span class="v">' + escapeHtml(r.rejectionReason) + '</span></div>' : ''}
        </div>
      </div>

      <div class="detail-section">
        <h3>Invoice</h3>
        ${r.invoicePath ? `
          <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:${r.invoiceVerified === false ? '14px' : '0'};">
            <a href="${r.invoicePath}" target="_blank" rel="noopener" class="doc-pdf-link">📄 View uploaded invoice</a>
            <span class="status-pill" style="background:${r.invoiceVerified ? '#9adf8f' : '#e8722c'}; color:${r.invoiceVerified ? '#0e3a24' : '#3d2a12'};">${r.invoiceVerified ? 'Verified' : 'Awaiting review'}</span>
          </div>
          ${!r.invoiceVerified ? `
            <div class="accept-reject-group">
              <button class="accept-btn" id="rrInvoiceValidBtn">Mark Invoice Valid</button>
              <button class="reject-btn" id="rrInvoiceInvalidBtn">Mark Invoice Invalid</button>
            </div>` : ''}
        ` : `<p style="font-size:13px; color:#7a867e;">Not uploaded yet — the shipper must upload an invoice before this load can be marked as picked up (truck loaded).</p>`}
      </div>

      <div class="detail-section">
        <h3>Admin Actions</h3>
        <div class="accept-reject-group" style="margin-bottom:16px;">
          <button class="accept-btn" id="rrAcceptBtn" ${isFinal ? 'disabled' : ''}>Accept Shipper Rate</button>
          <button class="reject-btn" id="rrRejectBtn" ${isFinal ? 'disabled' : ''}>Reject</button>
          <button type="button" class="ai-assess-btn" id="rrAiAssessBtn">🤖 AI Assessment</button>
        </div>
        <div class="ai-assess-panel" id="ai-load-panel-${escapeHtml(r.id)}" style="margin-bottom:16px;">${aiPanelHtml(r.id)}</div>
        <div class="counter-rate-cell">
          <div class="shipper-rate-compare"><span class="k">Shipper Requested Rate</span><span class="v">${formatINR(r.requestedRate)}</span></div>
          <label class="counter-label" for="rrCounterInput">Enter Admin Counter Rate</label>
          <input type="number" id="rrCounterInput" class="counter-input" placeholder="₹ e.g. 5500" value="${r.adminOfferedRate || ''}" ${isFinal ? 'disabled' : ''}>
          <button class="send-counter-btn" id="rrSendCounterBtn" ${isFinal ? 'disabled' : ''}>Send Counter Rate</button>
        </div>
      </div>
    `;

    document.getElementById('rrBackBtn').addEventListener('click', () => {
      view = 'list'; detailId = null; renderTable(allRecords, '');
    });
    if (document.getElementById('rrInvoiceValidBtn')) {
      document.getElementById('rrInvoiceValidBtn').addEventListener('click', () => verifyInvoice(r.id, true));
      document.getElementById('rrInvoiceInvalidBtn').addEventListener('click', () => verifyInvoice(r.id, false));
    }
    document.getElementById('rrAcceptBtn').addEventListener('click', () => setStatus(r.id, 'accepted'));
    document.getElementById('rrRejectBtn').addEventListener('click', () => {
      const reason = prompt('Reason for rejecting this request:') || '';
      if (!reason.trim()) return;
      setStatus(r.id, 'rejected', reason);
    });
    document.getElementById('rrAiAssessBtn').addEventListener('click', (e) => runLoadAssessment(r.tokenNo, r.id, e.currentTarget));
    document.getElementById('rrSendCounterBtn').addEventListener('click', () => sendCounterOffer(r.id));
  }

  function loadRecords(opts) {
    const forceRerender = !opts || opts.forceRerender !== false;
    const btn = document.getElementById('refreshBtn');
    if (btn && forceRerender) { btn.disabled = true; btn.textContent = '🔄 Refreshing…'; }
    // Cache-busting query param — belt-and-braces on top of the server's
    // Cache-Control: no-store header, so this call always hits the network
    // and never a stale cached response, regardless of browser/proxy.
    return fetch('/api/rate-requests?_=' + Date.now())
      .then(res => res.json())
      .then(records => {
        allRecords = records;
        const note = document.getElementById('lastUpdatedNote');
        if (note) note.textContent = 'Last updated: ' + new Date().toLocaleTimeString();
        // While a detail view is open, refresh the underlying data quietly
        // without re-rendering the DOM — re-rendering mid-edit would wipe
        // out whatever the admin is currently typing into the counter-rate
        // box. The fresh data is still used the moment they act on it
        // (Accept/Reject/Send Counter Rate) or go back to the list.
        if (view === 'detail' && !forceRerender) return;
        renderTable(allRecords, document.getElementById('rateSearchInput').value.trim());
      })
      .catch(() => {
        document.getElementById('countLine').textContent = 'Could not load data.';
      })
      .finally(() => {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
      });
  }

  loadRecords();
  document.getElementById('refreshBtn').addEventListener('click', () => loadRecords());

  // ---- Search (instant, local — the full list is already on the page) ----
  LS.wireLocalSearch({
    inputEl: document.getElementById('rateSearchInput'),
    getRecords: () => allRecords,
    fields: ['id', 'tokenNo', 'companyName', 'shipperUsername', 'pickup', 'destination', 'material'],
    onResults: (filtered, query) => renderTable(filtered, query),
  });

  // Poll every 8s so a newly submitted rate request shows up on an
  // already-open admin page without a manual reload — same pattern the
  // shipper's own Live Tracking dashboard already uses. The Refresh button
  // above gives an immediate, explicit alternative to waiting for this.
  setInterval(() => loadRecords({ forceRerender: false }), 8000);

  function refreshRecordInPlace(id, patch) {
    const idx = allRecords.findIndex(r => r.id === id);
    if (idx !== -1) allRecords[idx] = { ...allRecords[idx], ...patch };
    renderTable(allRecords, document.getElementById('rateSearchInput').value.trim());
  }

  function sendCounterOffer(id) {
    const input = document.getElementById('rrCounterInput');
    const rate = Number(input.value);
    if (!rate || rate <= 0) return alert('Enter a valid admin counter rate.');
    fetch('/api/rate-requests/' + id + '/counter-offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rate }),
    })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not send counter rate.');
        return d;
      })
      .then(d => {
        refreshRecordInPlace(id, { status: d.status, adminOfferedRate: d.adminOfferedRate });
        if (window.LS && LS.showSuccess) LS.showSuccess('Counter rate sent successfully!');
      })
      .catch(err => {
        alert(err.message);
        // The UI might be showing this request as still-actionable when
        // the backend actually already has a different status for it (e.g.
        // finalized by another admin session, or a stale page). Pull the
        // real current data so the screen self-corrects instead of
        // staying visually stuck on outdated info.
        loadRecords();
      });
  }

  function verifyInvoice(id, valid) {
    fetch('/api/rate-requests/' + id + '/verify-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valid }),
    })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not update invoice verification.');
        return d;
      })
      .then(d => {
        refreshRecordInPlace(id, { invoiceVerified: d.invoiceVerified });
        if (window.LS && LS.showSuccess) {
          LS.showSuccess(valid ? 'Invoice marked valid!' : 'Invoice marked invalid.');
        }
      })
      .catch(err => { alert(err.message); loadRecords(); });
  }

  function setStatus(id, status, reason) {
    fetch('/api/rate-requests/' + id + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not update status.');
        return d;
      })
      .then(d => {
        refreshRecordInPlace(id, { status: d.status, rejectionReason: d.rejectionReason, finalRate: d.finalRate });
        // API SUCCESS -> green tick popup. On failure the .catch() below
        // shows the existing alert() instead — never both, never a false
        // success.
        if (window.LS && LS.showSuccess) {
          LS.showSuccess(status === 'accepted' ? 'Request accepted successfully!' : 'Request rejected successfully!');
        }
      })
      .catch(err => {
        alert(err.message);
        loadRecords();
      });
  }
