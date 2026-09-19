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
  function formatINR(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN'); }

  const STATUS_LABEL = {
    SUBMITTED: 'Submitted', SHORTLISTED: 'Shortlisted', ACCEPTED: 'Accepted',
    REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn', EXPIRED: 'Expired',
  };

  // ---- Tabs ----
  document.querySelectorAll('.bid-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bid-tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      document.getElementById('availablePanel').style.display = tab === 'available' ? 'block' : 'none';
      document.getElementById('minePanel').style.display = tab === 'mine' ? 'block' : 'none';
    });
  });

  let availableLoads = [];
  let myBids = [];
  let myTrucks = [];
  let openFormToken = null; // tokenNo of the load whose inline bid form is currently open
  let formSubmitting = false;

  // ==================== AVAILABLE LOADS ====================

  function renderAvailableCard(l) {
    const deadlineHtml = l.biddingDeadline
      ? `<div class="deadline-row ${l.biddingExpired ? 'is-expired' : ''}">${l.biddingExpired ? '⛔ Bidding closed —' : 'Bidding closes:'} <b>${new Date(l.biddingDeadline).toLocaleString()}</b></div>`
      : '';

    let actionHtml;
    if (l.myBid) {
      const canWithdraw = ['SUBMITTED', 'SHORTLISTED'].includes(l.myBid.status);
      actionHtml = `
        <div class="my-bid-summary">
          <div class="txt">Your bid: <b>${formatINR(l.myBid.bidAmount)}</b> — <span class="status-pill ${l.myBid.status}">${STATUS_LABEL[l.myBid.status] || l.myBid.status}</span></div>
          ${canWithdraw ? `<button type="button" class="btn btn-danger" data-withdraw="${l.myBid.id}">Withdraw</button>` : ''}
        </div>`;
    } else if (l.biddingExpired) {
      actionHtml = `<div class="empty-state" style="padding:14px; background:transparent;">Bidding has closed for this load.</div>`;
    } else {
      const isOpen = openFormToken === l.tokenNo;
      actionHtml = isOpen
        ? renderBidForm(l)
        : `<button type="button" class="btn btn-primary" data-place-bid="${l.tokenNo}">Place Bid</button>`;
    }

    return `
      <div class="load-card ${l.biddingExpired ? 'expired' : ''}" data-token="${l.tokenNo}">
        <div class="load-head">
          <div>
            <div class="load-route">${l.pickup || '—'} → ${l.destination || '—'}</div>
            <div class="load-token">Token No. ${l.tokenNo || '—'} ${l.tokenNo ? LS.copyBtnHtml(l.tokenNo) : ''}</div>
            <div class="load-shipper">${l.shipperCompanyName || 'Shipper'}</div>
          </div>
          ${l.biddingExpired ? '<span class="status-pill expired-chip">Bidding Closed</span>' : ''}
        </div>

        <div class="info-grid">
          <div class="info-cell"><div class="k">Material</div><div class="v">${l.material || '—'}</div></div>
          <div class="info-cell"><div class="k">Load</div><div class="v">${l.weight != null ? l.weight + ' tons' : '—'}</div></div>
          <div class="info-cell"><div class="k">Distance</div><div class="v">${l.distanceKm != null ? l.distanceKm + ' km' : '—'}</div></div>
          <div class="info-cell"><div class="k">Truck Type Required</div><div class="v">${l.requiredTruckType || '—'}${l.requiredBodyType ? ' · ' + l.requiredBodyType : ''}</div></div>
          <div class="info-cell"><div class="k">Pickup</div><div class="v">${l.pickupDateTime ? new Date(l.pickupDateTime).toLocaleString() : '—'}</div></div>
          <div class="info-cell"><div class="k">Delivery Deadline</div><div class="v">${l.deliveryDeadline ? new Date(l.deliveryDeadline).toLocaleString() : '—'}</div></div>
        </div>

        ${deadlineHtml}
        ${actionHtml}
      </div>
    `;
  }

  function renderBidForm(l) {
    const eligibleTrucks = myTrucks.filter((t) => t.status === 'available');
    const truckOptionsHtml = eligibleTrucks.length
      ? eligibleTrucks.map((t) => `<option value="${t.id}">${t.vehicleNumber} — ${t.truckType} (${t.capacityTons}t)</option>`).join('')
      : '<option value="">No available trucks in your fleet</option>';
    return `
      <div class="bid-form" data-form-for="${l.tokenNo}">
        <div class="bid-form-error" data-form-error="${l.tokenNo}"></div>
        <div class="field">
          <label>Truck</label>
          <select data-truck-select="${l.tokenNo}" ${eligibleTrucks.length ? '' : 'disabled'}>${truckOptionsHtml}</select>
        </div>
        <div class="field">
          <label>Bid Amount (₹)</label>
          <input type="number" min="1" step="1" placeholder="e.g. 25000" data-bid-amount="${l.tokenNo}">
        </div>
        <div class="field">
          <label>Notes (optional)</label>
          <textarea placeholder="Anything the shipper should know about your offer…" data-bid-notes="${l.tokenNo}"></textarea>
        </div>
        <div class="bid-form-actions">
          <button type="button" class="btn btn-primary" data-submit-bid="${l.tokenNo}" ${eligibleTrucks.length ? '' : 'disabled'}>Submit Bid</button>
          <button type="button" class="btn btn-secondary" data-cancel-bid="${l.tokenNo}">Cancel</button>
        </div>
      </div>
    `;
  }

  function renderAvailableList() {
    const wrap = document.getElementById('availableListWrap');
    if (!availableLoads.length) {
      wrap.innerHTML = '<div class="empty-state">No loads are open for bidding right now. Check back soon.</div>';
      return;
    }
    wrap.innerHTML = availableLoads.map(renderAvailableCard).join('');
    wireAvailableActions();
  }

  function wireAvailableActions() {
    const wrap = document.getElementById('availableListWrap');
    wrap.querySelectorAll('[data-place-bid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openFormToken = btn.getAttribute('data-place-bid');
        renderAvailableList();
      });
    });
    wrap.querySelectorAll('[data-cancel-bid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openFormToken = null;
        renderAvailableList();
      });
    });
    wrap.querySelectorAll('[data-submit-bid]').forEach((btn) => {
      btn.addEventListener('click', () => submitBid(btn.getAttribute('data-submit-bid')));
    });
    wrap.querySelectorAll('[data-withdraw]').forEach((btn) => {
      btn.addEventListener('click', () => withdrawBid(btn.getAttribute('data-withdraw')));
    });
  }

  function setFormError(tokenNo, msg) {
    const el = document.querySelector(`[data-form-error="${tokenNo}"]`);
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.style.display = 'block';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  function submitBid(tokenNo) {
    if (formSubmitting) return;
    const truckSelect = document.querySelector(`[data-truck-select="${tokenNo}"]`);
    const amountInput = document.querySelector(`[data-bid-amount="${tokenNo}"]`);
    const notesInput = document.querySelector(`[data-bid-notes="${tokenNo}"]`);
    const truckId = truckSelect ? truckSelect.value : '';
    const bidAmount = amountInput ? Number(amountInput.value) : NaN;

    if (!truckId) { setFormError(tokenNo, 'Select a truck to bid with.'); return; }
    if (!Number.isFinite(bidAmount) || bidAmount <= 0) { setFormError(tokenNo, 'Enter a valid bid amount greater than zero.'); return; }
    setFormError(tokenNo, '');

    const submitBtn = document.querySelector(`[data-submit-bid="${tokenNo}"]`);
    formSubmitting = true;
    if (submitBtn) submitBtn.disabled = true;

    fetch('/api/carrier/loads/' + encodeURIComponent(tokenNo) + '/bids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ truckId, bidAmount, notes: notesInput ? notesInput.value.trim() : '' }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not submit your bid.');
        return data;
      })
      .then(() => {
        openFormToken = null;
        if (window.LS && LS.showSuccess) LS.showSuccess('Bid submitted!');
        loadAvailable();
        loadMyBids();
      })
      .catch((err) => {
        setFormError(tokenNo, err.message);
      })
      .finally(() => {
        formSubmitting = false;
        if (submitBtn) submitBtn.disabled = false;
      });
  }

  function withdrawBid(bidId) {
    if (!confirm('Withdraw this bid? This can\'t be undone.')) return;
    fetch('/api/carrier/bids/' + encodeURIComponent(bidId), { method: 'DELETE' })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not withdraw that bid.');
        return data;
      })
      .then(() => {
        if (window.LS && LS.showSuccess) LS.showSuccess('Bid withdrawn.');
        loadAvailable();
        loadMyBids();
      })
      .catch((err) => showError(err.message));
  }

  function loadAvailable() {
    fetch('/api/carrier/loads/available?_=' + Date.now())
      .then((res) => {
        if (res.status === 401) { window.location.href = '/login/carrier'; return null; }
        return res.json();
      })
      .then((records) => {
        if (!records) return;
        if (!Array.isArray(records)) throw new Error(records.error || 'Could not load available loads.');
        availableLoads = records;
        // If the load whose form was open has since disappeared/expired, close it.
        if (openFormToken && !availableLoads.some((l) => l.tokenNo === openFormToken && !l.biddingExpired && !l.myBid)) {
          openFormToken = null;
        }
        renderAvailableList();
      })
      .catch((err) => {
        document.getElementById('availableListWrap').innerHTML = '<div class="empty-state">Could not load available loads.</div>';
        showError(err.message || 'Could not load available loads.');
      });
  }

  function loadMyTrucks() {
    return fetch('/api/carrier/trucks')
      .then((res) => res.json())
      .then((data) => { myTrucks = Array.isArray(data) ? data : []; })
      .catch(() => { myTrucks = []; });
  }

  // ==================== MY BIDS ====================

  function renderMyBidCard(b) {
    const routeText = b.load ? `${b.load.pickup || '—'} → ${b.load.destination || '—'}` : 'Load no longer available';
    let statusExtra = '';
    if (b.status === 'REJECTED' && b.rejectionReason) {
      statusExtra = `<div class="rejection-note">📝 ${b.rejectionReason}</div>`;
    }
    return `
      <div class="my-bid-card" data-bid-id="${b.id}">
        <div class="my-bid-head">
          <div>
            <div class="load-route">${routeText}</div>
            <div class="load-token">Token No. ${b.loadId || '—'} ${b.loadId ? LS.copyBtnHtml(b.loadId) : ''}</div>
          </div>
          <span class="status-pill ${b.status}">${STATUS_LABEL[b.status] || b.status}</span>
        </div>
        <div class="info-grid">
          <div class="info-cell"><div class="k">Your Bid</div><div class="v">${formatINR(b.bidAmount)}</div></div>
          <div class="info-cell"><div class="k">Truck</div><div class="v">${b.vehicleNumber || '—'}</div></div>
          <div class="info-cell"><div class="k">Submitted</div><div class="v">${b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}</div></div>
        </div>
        ${b.notes ? `<div class="load-shipper">📝 ${b.notes}</div>` : ''}
        ${statusExtra}
      </div>
    `;
  }

  function renderMyBidsList() {
    const wrap = document.getElementById('myBidsListWrap');
    if (!myBids.length) {
      wrap.innerHTML = '<div class="empty-state">You haven\'t placed any bids yet. Head to Available Loads to place your first one.</div>';
      return;
    }
    wrap.innerHTML = myBids.map(renderMyBidCard).join('');
  }

  function loadMyBids() {
    fetch('/api/carrier/bids?_=' + Date.now())
      .then((res) => {
        if (res.status === 401) { window.location.href = '/login/carrier'; return null; }
        return res.json();
      })
      .then((records) => {
        if (!records) return;
        if (!Array.isArray(records)) throw new Error(records.error || 'Could not load your bids.');
        // Newest first — the API already sorts by createdAt desc, keep as-is.
        myBids = records;
        renderMyBidsList();
      })
      .catch((err) => {
        document.getElementById('myBidsListWrap').innerHTML = '<div class="empty-state">Could not load your bids.</div>';
      });
  }

  loadMyTrucks().then(loadAvailable);
  loadMyBids();

  // Poll available loads every 15s so new loads open for bidding appear
  // automatically, and my bids every 15s so status changes (shortlisted,
  // accepted, rejected by the shipper) show up without a manual refresh.
  setInterval(() => { loadMyTrucks().then(loadAvailable); }, 15000);
  setInterval(loadMyBids, 15000);
