  document.querySelectorAll('.fleet-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fleet-tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      document.getElementById('approvalsPanel').style.display = tab === 'approvals' ? 'block' : 'none';
      document.getElementById('trucksPanel').style.display = tab === 'trucks' ? 'block' : 'none';
      document.getElementById('driversPanel').style.display = tab === 'drivers' ? 'block' : 'none';
      document.getElementById('unmatchedPanel').style.display = tab === 'unmatched' ? 'block' : 'none';
    });
  });

  // ================= AI Recommendation Approvals (the one manual decision) =================
  function formatINR(n) { return '₹' + Number(n).toLocaleString('en-IN'); }

  function renderApprovals(loads) {
    const wrap = document.getElementById('approvalsPanel');
    document.getElementById('approvalsCount').textContent = loads.length ? loads.length : '';
    if (!loads.length) {
      wrap.innerHTML = '<div class="empty-state">No AI recommendations waiting on you right now — new loads will show up here the moment a match is found.</div>';
      return;
    }
    wrap.innerHTML = loads.map((l) => `
      <div class="approval-card" data-token="${l.tokenNo}">
        <div class="approval-head">
          <div>
            <div class="approval-route">${l.pickup} → ${l.destination} <span class="approval-token">(${l.tokenNo})</span></div>
            <div class="approval-sub">${l.material} · ${l.weight} Ton${l.requiredTruckType ? ' · ' + l.requiredTruckType : ''}</div>
          </div>
          <div class="match-score-badge">⭐ ${l.matchScore != null ? l.matchScore + '%' : '—'} Match</div>
        </div>
        <div class="approval-grid">
          <div class="approval-item">🚛 <b>Truck</b><span>${l.truck ? l.truck.vehicleNumber : '—'}</span></div>
          <div class="approval-item">👤 <b>Driver</b><span>${l.driver ? `<button type="button" class="fleet-row-link" data-view-driver="${l.driver.id}">${l.driver.name}</button>` : '—'}</span></div>
          <div class="approval-item">📦 <b>Capacity</b><span>${l.truck ? l.truck.capacityTons + ' Ton' : '—'}</span></div>
          <div class="approval-item">💰 <b>Est. Amount</b><span>${formatINR(l.estimatedRate)}</span></div>
        </div>
        <div class="approval-reason-box">
          <p class="approval-reason-title">AI Recommendation Reason</p>
          <ul class="approval-reason-list">${(l.matchReasons || []).map((r) => `<li>${r}</li>`).join('')}</ul>
        </div>
        <button type="button" class="ai-details-toggle" data-view-matches="${l.tokenNo}">View AI Matching Dashboard ▸</button>
        <div class="approval-actions">
          <button type="button" class="fleet-btn approve" data-approve="${l.tokenNo}">✓ Approve Assignment</button>
          <button type="button" class="fleet-btn reject" data-reject="${l.tokenNo}">✕ Reject</button>
        </div>
      </div>`).join('');

    wrap.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const token = btn.getAttribute('data-approve');
        btn.disabled = true; btn.textContent = 'Approving…';
        fetch(`/api/admin/fleet/loads/${token}/approve`, { method: 'POST' })
          .then((r) => r.json())
          .then((result) => {
            if (!result.ok) throw new Error(result.error || 'Could not approve.');
            if (window.LS && LS.showSuccess) LS.showSuccess('Driver assigned successfully. Confirmation emails have been sent.');
            loadApprovals();
          })
          .catch((err) => { if (window.LS && LS.showSuccess) LS.showSuccess(err.message); btn.disabled = false; btn.textContent = '✓ Approve Assignment'; });
      });
    });
    wrap.querySelectorAll('[data-reject]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const token = btn.getAttribute('data-reject');
        btn.disabled = true; btn.textContent = 'Rejecting…';
        fetch(`/api/admin/fleet/loads/${token}/reject`, { method: 'POST' })
          .then((r) => r.json())
          .then((result) => {
            if (!result.ok) throw new Error(result.error || 'Could not reject.');
            if (window.LS && LS.showSuccess) LS.showSuccess('Recommendation rejected — load returned to matching.');
            loadApprovals();
            loadUnmatched();
          })
          .catch((err) => { if (window.LS && LS.showSuccess) LS.showSuccess(err.message); btn.disabled = false; btn.textContent = '✕ Reject'; });
      });
    });
    wrap.querySelectorAll('[data-view-matches]').forEach((btn) => {
      btn.addEventListener('click', () => openMatchModal(btn.getAttribute('data-view-matches')));
    });
    wrap.querySelectorAll('[data-view-driver]').forEach((btn) => {
      btn.addEventListener('click', () => openDriverModal(btn.getAttribute('data-view-driver')));
    });
  }

  function loadApprovals() {
    fetch('/api/admin/fleet/pending-approvals').then((r) => r.json()).then(renderApprovals)
      .catch(() => { document.getElementById('approvalsPanel').innerHTML = '<div class="empty-state">Could not load AI recommendations.</div>'; });
  }

  function renderTrucks(trucks) {
    const wrap = document.getElementById('trucksPanel');
    if (!trucks.length) { wrap.innerHTML = '<div class="empty-state">No trucks have been onboarded by any carrier yet.</div>'; return; }
    wrap.innerHTML = trucks.map((t) => `
      <div class="fleet-row" data-id="${t.id}">
        <div>
          <div class="fleet-row-main">${t.vehicleNumber} — ${t.truckType} (${t.capacityTons}t)</div>
          <div class="fleet-row-sub">Carrier: ${t.carrierUsername} · Status: ${t.status}${t.currentLocation ? ' · ' + t.currentLocation : ''}</div>
        </div>
        <div class="fleet-row-actions">
          <span class="fleet-pill ${t.verified ? 'verified' : 'pending'}">${t.verified ? 'Verified' : 'Pending'}</span>
          <button type="button" class="fleet-btn ${t.verified ? 'unverify' : 'verify'}" data-verify-truck="${t.id}" data-value="${!t.verified}">
            ${t.verified ? 'Unverify' : 'Verify'}
          </button>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('[data-verify-truck]').forEach((btn) => {
      btn.addEventListener('click', () => setTruckVerified(btn.getAttribute('data-verify-truck'), btn.getAttribute('data-value') === 'true'));
    });
  }

  function renderDrivers(drivers) {
    const wrap = document.getElementById('driversPanel');
    if (!drivers.length) { wrap.innerHTML = '<div class="empty-state">No drivers have been onboarded by any carrier yet.</div>'; return; }
    wrap.innerHTML = drivers.map((d) => `
      <div class="fleet-row" data-id="${d.id}">
        <div>
          <div class="fleet-row-main">${d.name} — ${d.mobileNumber} ${d.blocked ? '<span class="ineligible-tag">Blocked</span>' : ''}</div>
          <div class="fleet-row-sub">Carrier: ${d.carrierUsername} · Licence ${d.licenseNumber} · Status: ${d.status} · Trust ${d.trustScore != null ? d.trustScore : 70}/100 · ${d.completedTrips || 0} trips</div>
        </div>
        <div class="fleet-row-actions">
          <span class="fleet-pill ${d.verified ? 'verified' : 'pending'}">${d.verified ? 'Verified' : 'Pending'}</span>
          <button type="button" class="fleet-btn ghost small" data-view-driver="${d.id}">View Profile</button>
          <button type="button" class="fleet-btn ${d.verified ? 'unverify' : 'verify'}" data-verify-driver="${d.id}" data-value="${!d.verified}">
            ${d.verified ? 'Unverify' : 'Verify'}
          </button>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('[data-verify-driver]').forEach((btn) => {
      btn.addEventListener('click', () => setDriverVerified(btn.getAttribute('data-verify-driver'), btn.getAttribute('data-value') === 'true'));
    });
    wrap.querySelectorAll('[data-view-driver]').forEach((btn) => {
      btn.addEventListener('click', () => openDriverModal(btn.getAttribute('data-view-driver')));
    });
  }

  function setTruckVerified(id, value) {
    fetch(`/api/admin/fleet/trucks/${id}/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verified: value }),
    }).then(() => { if (window.LS && LS.showSuccess) LS.showSuccess('Truck updated.'); loadTrucks(); });
  }
  function setDriverVerified(id, value) {
    fetch(`/api/admin/fleet/drivers/${id}/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verified: value }),
    }).then(() => { if (window.LS && LS.showSuccess) LS.showSuccess('Driver updated.'); loadDrivers(); });
  }

  function loadTrucks() {
    fetch('/api/admin/fleet/trucks').then((r) => r.json()).then(renderTrucks)
      .catch(() => { document.getElementById('trucksPanel').innerHTML = '<div class="empty-state">Could not load trucks.</div>'; });
  }
  function loadDrivers() {
    fetch('/api/admin/fleet/drivers').then((r) => r.json()).then(renderDrivers)
      .catch(() => { document.getElementById('driversPanel').innerHTML = '<div class="empty-state">Could not load drivers.</div>'; });
  }

  // "Unmatched loads" — loads still stuck at POSTED after the automatic
  // matching engine already tried and found nothing suitable (matchAttempted
  // is true but no truck/driver was assigned).
  function loadUnmatched() {
    fetch('/api/admin/fleet/unmatched-loads')
      .then((r) => r.json())
      .then((unmatched) => {
        const wrap = document.getElementById('unmatchedPanel');
        if (!unmatched.length) {
          wrap.innerHTML = '<div class="empty-state">No unmatched loads right now — everything posted has either been matched or hasn\'t been attempted yet.</div>';
          return;
        }
        wrap.innerHTML = unmatched.map((o) => `
          <div class="fleet-row" data-token="${o.tokenNo}">
            <div>
              <div class="fleet-row-main">${o.pickup} → ${o.destination} (${o.tokenNo})</div>
              <div class="fleet-row-sub">${o.matchNote || 'No suitable truck and driver are currently available.'}</div>
            </div>
            <div class="fleet-row-actions">
              <button type="button" class="fleet-btn ghost small" data-find-matches="${o.tokenNo}">Find matches</button>
              <button type="button" class="fleet-btn retry" data-retry="${o.tokenNo}">Retry match</button>
            </div>
          </div>`).join('');
        wrap.querySelectorAll('[data-retry]').forEach((btn) => {
          btn.addEventListener('click', () => {
            btn.disabled = true; btn.textContent = 'Matching…';
            fetch(`/api/admin/fleet/loads/${btn.getAttribute('data-retry')}/retry-match`, { method: 'POST' })
              .then((r) => r.json())
              .then((result) => {
                if (window.LS && LS.showSuccess) LS.showSuccess(result.matched ? 'Matched successfully!' : 'Still no suitable truck/driver available.');
                loadApprovals();
                loadUnmatched();
              })
              .finally(() => { btn.disabled = false; btn.textContent = 'Retry match'; });
          });
        });
        wrap.querySelectorAll('[data-find-matches]').forEach((btn) => {
          btn.addEventListener('click', () => openMatchModal(btn.getAttribute('data-find-matches')));
        });
      })
      .catch(() => {
        document.getElementById('unmatchedPanel').innerHTML = '<div class="empty-state">Could not load unmatched loads.</div>';
      });
  }

  // ================= Matching Dashboard modal =================
  // Best Match + Other Suitable Matches + Ineligible-with-reasons for one
  // load, backed by GET /api/admin/fleet/loads/:token/match-details —
  // exactly the same computeLoadMatches() the auto-match pipeline and the
  // /api/loads/:loadId/matches endpoint use, so this view can never show
  // something the engine wouldn't actually pick.
  const matchModal = document.getElementById('matchModal');
  const matchModalBody = document.getElementById('matchModalBody');
  let currentMatchLoadToken = null;

  function factorLabel(key) {
    const labels = {
      truckCompatibility: 'Truck fit', routeCompatibility: 'Route', availability: 'Availability',
      capacity: 'Capacity', driverTrust: 'Driver trust', onTimePerformance: 'On-time %', tripHistory: 'Trip history',
    };
    return labels[key] || key;
  }

  function matchCardHtml(c, opts) {
    opts = opts || {};
    const factors = Object.keys(c.breakdown || {}).map((k) => `
      <div class="factor-bar-row">
        <div class="factor-bar-label"><span>${factorLabel(k)}</span><span>${c.breakdown[k]}</span></div>
        <div class="factor-bar-track"><div class="factor-bar-fill" style="width:${c.breakdown[k]}%;"></div></div>
      </div>`).join('');
    return `
      <div class="match-card ${opts.best ? 'best' : ''}">
        ${opts.best ? '<span class="best-badge">★ Recommended match</span>' : ''}
        <div class="match-card-head">
          <div>
            <div class="match-card-title">${c.driverName} — ${c.vehicleNumber}</div>
            <div class="match-card-sub">${c.truckType || ''} · ${c.capacityTons}t · ${c.currentLocation || 'Location unknown'} · Trust ${c.trustScore}/100 · ${c.completedTrips} trip${c.completedTrips === 1 ? '' : 's'}</div>
          </div>
          <div class="match-score-ring"><b>${c.matchScore}%</b><span>Match</span></div>
        </div>
        <div class="factor-bars">${factors}</div>
        <ul class="match-card-reasons">${(c.reasons || []).map((r) => `<li>${r}</li>`).join('')}</ul>
        <div class="match-card-actions">
          <button type="button" class="fleet-btn assign small" data-assign-truck="${c.truckId}" data-assign-driver="${c.driverId}">✓ Assign this match</button>
          <button type="button" class="fleet-btn ghost small" data-view-driver="${c.driverId}">View driver</button>
        </div>
      </div>`;
  }

  function ineligibleCardHtml(c) {
    return `
      <div class="ineligible-card">
        <div class="ineligible-card-title">${c.driverName || 'Unassigned'} — ${c.vehicleNumber || '—'} <span class="ineligible-tag">Ineligible</span></div>
        <div class="ineligible-reason">${(c.reasons || []).join(' · ')}</div>
      </div>`;
  }

  function renderMatchDashboard(data) {
    document.getElementById('matchModalTitle').textContent = `Matching Dashboard — ${data.loadId}`;
    const parts = [];
    if (data.bestMatch) {
      parts.push('<div class="match-section-label">Best match</div>');
      parts.push(matchCardHtml(data.bestMatch, { best: true }));
    }
    if (data.otherMatches && data.otherMatches.length) {
      parts.push(`<div class="match-section-label">Other suitable matches (${data.otherMatches.length})</div>`);
      parts.push(data.otherMatches.map((c) => matchCardHtml(c)).join(''));
    }
    if (!data.bestMatch) {
      parts.push('<div class="empty-state" style="box-shadow:none;">No suitable truck/driver currently meets every requirement for this load.<br><br>Try again shortly, expand the pickup window, view nearby trucks in the Trucks tab, or contact dispatch.</div>');
    }
    if (data.ineligible && data.ineligible.length) {
      parts.push(`<div class="match-section-label">Not eligible (${data.ineligible.length})</div>`);
      parts.push(data.ineligible.map(ineligibleCardHtml).join(''));
    }
    matchModalBody.innerHTML = parts.join('');

    matchModalBody.querySelectorAll('[data-assign-truck]').forEach((btn) => {
      btn.addEventListener('click', () => assignCandidate(currentMatchLoadToken, btn.getAttribute('data-assign-truck'), btn.getAttribute('data-assign-driver'), btn));
    });
    matchModalBody.querySelectorAll('[data-view-driver]').forEach((btn) => {
      btn.addEventListener('click', () => openDriverModal(btn.getAttribute('data-view-driver')));
    });
  }

  function assignCandidate(tokenNo, truckId, driverId, btn) {
    if (!window.confirm('Assign this truck/driver to the load? This reserves the truck immediately.')) return;
    btn.disabled = true; btn.textContent = 'Assigning…';
    fetch(`/api/admin/fleet/loads/${tokenNo}/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ truckId, driverId }),
    })
      .then((r) => r.json())
      .then((result) => {
        if (!result.ok) throw new Error(result.error || 'Could not assign.');
        if (window.LS && LS.showSuccess) LS.showSuccess('Driver assigned successfully. Confirmation emails have been sent.');
        closeMatchModal();
        loadApprovals();
        loadUnmatched();
      })
      .catch((err) => {
        if (window.LS && LS.showSuccess) LS.showSuccess(err.message);
        btn.disabled = false; btn.textContent = '✓ Assign this match';
      });
  }

  function openMatchModal(tokenNo) {
    currentMatchLoadToken = tokenNo;
    document.getElementById('matchModalTitle').textContent = `Matching Dashboard — ${tokenNo}`;
    matchModalBody.innerHTML = '<div class="empty-state" style="box-shadow:none;"><span class="ls-spinner"></span> Loading matches…</div>';
    matchModal.style.display = 'flex';
    fetch(`/api/admin/fleet/loads/${tokenNo}/match-details`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { matchModalBody.innerHTML = `<div class="empty-state" style="box-shadow:none;">${data.error}</div>`; return; }
        renderMatchDashboard(data);
      })
      .catch(() => { matchModalBody.innerHTML = '<div class="empty-state" style="box-shadow:none;">Could not load matching details.</div>'; });
  }
  function closeMatchModal() { matchModal.style.display = 'none'; }
  document.getElementById('matchModalClose').addEventListener('click', closeMatchModal);
  matchModal.addEventListener('click', (e) => { if (e.target === matchModal) closeMatchModal(); });

  // ================= Driver Profile modal =================
  // Trust Score gauge (accessible: number + text label, never color-only)
  // + component breakdown + a lightweight custom trend chart (no chart
  // library in this project) + recent feedback, backed by
  // GET /api/admin/fleet/drivers/:id/profile.
  const driverModal = document.getElementById('driverModal');
  const driverModalBody = document.getElementById('driverModalBody');

  function trustLabelClass(label) { return String(label || '').toLowerCase().replace(/\s+/g, '-'); }

  function trustGaugeSvg(score) {
    const r = 40, c = 2 * Math.PI * r;
    const pct = Math.max(0, Math.min(100, score)) / 100;
    return `<svg viewBox="0 0 96 96">
      <circle cx="48" cy="48" r="${r}" fill="none" stroke="#e5e2d8" stroke-width="10"></circle>
      <circle cx="48" cy="48" r="${r}" fill="none" stroke="#0e3a24" stroke-width="10"
        stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" stroke-linecap="round"></circle>
    </svg>`;
  }

  function trustHistoryChart(history) {
    if (!history || history.length < 2) {
      return '<div class="trust-history-empty">Not enough monthly history yet to show a trend.</div>';
    }
    const w = 560, chartH = 80, pad = 8;
    const scores = history.map((item) => item.score);
    const min = Math.min(...scores, 50), max = Math.max(...scores, 100);
    const stepX = (w - pad * 2) / (history.length - 1);
    const scaleY = (score) => {
      const range = max - min || 1;
      return chartH - pad - ((score - min) / range) * (chartH - pad * 2);
    };
    const points = history.map((item, i) => ({ x: pad + i * stepX, y: scaleY(item.score), score: item.score, monthKey: item.monthKey }));
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const dots = points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#0e3a24"></circle>`).join('');
    const labels = points.map((p) => `<text x="${p.x.toFixed(1)}" y="${chartH - 2}" font-size="8" fill="#7a867e" text-anchor="middle">${p.monthKey.slice(5)}</text>`).join('');
    return `<svg viewBox="0 0 ${w} ${chartH}"><path d="${path}" fill="none" stroke="#0e3a24" stroke-width="2"></path>${dots}${labels}</svg>`;
  }

  function renderDriverProfile(data) {
    const d = data.driver, t = data.trust;
    document.getElementById('driverModalTitle').textContent = d.name;
    driverModalBody.innerHTML = `
      <div class="fleet-row-sub" style="margin-bottom:12px;">📞 ${d.mobileNumber || '—'}${d.email ? ' &nbsp;·&nbsp; ✉️ ' + d.email : ''}</div>
      <div class="trust-gauge-wrap">
        <div class="trust-gauge">${trustGaugeSvg(t.score)}<div class="trust-gauge-num"><b>${t.score}</b><span>/ 100</span></div></div>
        <div>
          <span class="trust-label-chip ${trustLabelClass(t.label)}">${t.label}</span>
          <div class="trust-confidence-note">Based on ${t.basedOnTrips} completed trip${t.basedOnTrips === 1 ? '' : 's'} · ${t.confidence}% confidence${t.confidence < 60 ? ' — still learning this driver' : ''}</div>
          ${d.blocked ? '<div class="ineligible-reason" style="margin-top:6px;">⚠ This driver is currently blocked.</div>' : ''}
        </div>
      </div>
      <div class="driver-stat-grid">
        <div class="driver-stat"><b>${t.components.customerRating != null ? t.components.customerRating + '★' : '—'}</b><span>Rating</span></div>
        <div class="driver-stat"><b>${d.completedTrips || 0}</b><span>Completed trips</span></div>
        <div class="driver-stat"><b>${t.components.onTimeRate != null ? t.components.onTimeRate + '%' : '—'}</b><span>On-time</span></div>
        <div class="driver-stat"><b>${t.components.completionRate != null ? t.components.completionRate + '%' : '—'}</b><span>Success rate</span></div>
        <div class="driver-stat"><b>${t.components.cancellationRate != null ? t.components.cancellationRate + '%' : '0%'}</b><span>Cancellation</span></div>
        <div class="driver-stat"><b>${t.components.recommendRate != null ? t.components.recommendRate + '%' : '—'}</b><span>Would recommend</span></div>
      </div>
      <div class="match-section-label">Trust score trend</div>
      <div class="trust-history-chart">${trustHistoryChart(data.history)}</div>
      <div class="match-section-label">Recent feedback</div>
      ${(data.recentFeedbacks && data.recentFeedbacks.length)
        ? data.recentFeedbacks.map((f) => `<div class="feedback-item"><span class="stars">${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)}</span>${f.comments || 'No comments left.'}</div>`).join('')
        : '<div class="trust-history-empty">No feedback submitted yet.</div>'}
      ${data.truck ? `<div class="match-section-label">Linked truck</div><div class="fleet-row" style="margin:0;"><div><div class="fleet-row-main">${data.truck.vehicleNumber}</div><div class="fleet-row-sub">${data.truck.truckType} · ${data.truck.capacityTons}t · ${data.truck.status}</div></div></div>` : ''}
    `;
  }

  function openDriverModal(driverId) {
    document.getElementById('driverModalTitle').textContent = 'Driver Profile';
    driverModalBody.innerHTML = '<div class="empty-state" style="box-shadow:none;"><span class="ls-spinner"></span> Loading driver…</div>';
    driverModal.style.display = 'flex';
    fetch(`/api/admin/fleet/drivers/${driverId}/profile`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { driverModalBody.innerHTML = `<div class="empty-state" style="box-shadow:none;">${data.error}</div>`; return; }
        renderDriverProfile(data);
      })
      .catch(() => { driverModalBody.innerHTML = '<div class="empty-state" style="box-shadow:none;">Could not load this driver\'s profile.</div>'; });
  }
  function closeDriverModal() { driverModal.style.display = 'none'; }
  document.getElementById('driverModalClose').addEventListener('click', closeDriverModal);
  driverModal.addEventListener('click', (e) => { if (e.target === driverModal) closeDriverModal(); });

  // ================= Admin AI Dispatch Assistant =================
  // Same /api/chat request/response contract as the public homepage
  // chatbot (site-enhance.js) — auth.js has already patched window.fetch
  // on every /admin/* page to attach "Authorization: Bearer <token>"
  // automatically, which is what unlocks the matching-aware admin
  // resolver server-side. Sensitive actions (ASSIGN_DRIVER) always render
  // as a Confirm/Cancel pair — the AI itself never calls /assign; only a
  // human clicking Confirm does.
  (function initFleetChat() {
    const launcher = document.getElementById('fleetChatLauncher');
    const panel = document.getElementById('fleetChatPanel');
    const closeBtn = document.getElementById('fleetChatClose');
    const messages = document.getElementById('fleetChatMessages');
    const form = document.getElementById('fleetChatForm');
    const input = document.getElementById('fleetChatInput');
    if (!launcher || !panel) return;

    let open = false;
    let conversation = [];

    function appendMsg(role, html) {
      const el = document.createElement('div');
      el.className = 'fleet-chat-msg ' + (role === 'user' ? 'user' : 'bot');
      el.innerHTML = html;
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
      return el;
    }

    function handleAction(action, payload) {
      payload = payload || {};
      if (action === 'SHOW_DRIVER' && payload.driverId) openDriverModal(payload.driverId);
      else if (action === 'SHOW_MATCHES' && payload.loadId) openMatchModal(payload.loadId);
      else if (action === 'SHOW_LOAD' && payload.loadId) openMatchModal(payload.loadId);
      else if (action === 'ASSIGN_DRIVER' && payload.requiresConfirmation) {
        // The assistant's own message bubble (appended by send(), just
        // before this runs) already asks the question — this only adds
        // the Confirm/Cancel pair underneath it. The AI itself never
        // calls /assign; only a human clicking Confirm does.
        const confirmRow = document.createElement('div');
        confirmRow.className = 'fleet-chat-confirm';
        confirmRow.innerHTML = '<button type="button" class="fleet-btn approve small">Confirm</button><button type="button" class="fleet-btn ghost small">Cancel</button>';
        messages.appendChild(confirmRow);
        confirmRow.querySelector('.approve').addEventListener('click', () => {
          confirmRow.innerHTML = '<span style="font-size:11.5px; color:#7a867e;">Assigning…</span>';
          fetch(`/api/admin/fleet/loads/${payload.loadId}/assign`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ truckId: payload.truckId, driverId: payload.driverId }),
          })
            .then((r) => r.json())
            .then((result) => {
              confirmRow.remove();
              appendMsg('bot', result.ok ? `✓ Assigned ${payload.driverName} to ${payload.loadId}.` : (result.error || 'Could not assign.'));
              loadApprovals(); loadUnmatched();
            })
            .catch(() => { confirmRow.remove(); appendMsg('bot', 'Could not reach the server to assign — please try from the Matching Dashboard instead.'); });
        });
        confirmRow.querySelector('.ghost').addEventListener('click', () => {
          confirmRow.remove();
          appendMsg('bot', 'Cancelled — no changes were made.');
        });
      }
    }

    function send(text) {
      text = (text || '').trim();
      if (!text) return;
      appendMsg('user', text);
      conversation.push({ role: 'user', content: text });
      input.value = '';
      const typing = appendMsg('bot', '<span class="ls-spinner"></span>');
      fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversation }),
      })
        .then((r) => r.json())
        .then((data) => {
          typing.remove();
          appendMsg('bot', data.message || 'Sorry, I could not process that.');
          conversation.push({ role: 'assistant', content: data.message || '' });
          if (data.action) handleAction(data.action, data.payload);
        })
        .catch(() => { typing.remove(); appendMsg('bot', 'Sorry — I couldn\'t reach the assistant just now.'); });
    }

    function toggle() {
      open = !open;
      panel.setAttribute('data-open', open ? 'true' : 'false');
      launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !messages.childElementCount) {
        appendMsg('bot', "Hi — I'm the dispatch assistant. Ask me things like \"find the best truck for LS1234567890\" or \"why was this driver selected?\".");
      }
    }
    launcher.addEventListener('click', toggle);
    closeBtn.addEventListener('click', toggle);
    form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  })();

  loadApprovals();
  loadTrucks();
  loadDrivers();
  loadUnmatched();
  // Approvals are the primary/live queue on this page — poll for new AI
  // recommendations the way the rest of the admin portal already polls
  // for updates (tracking, complaints), so a new match shows up without
  // a manual refresh.
  setInterval(loadApprovals, 15000);
