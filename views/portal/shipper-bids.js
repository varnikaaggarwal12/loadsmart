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

  // Mirrors lib/loadStatusMachine.js's STAGE_LABELS (display text only —
  // purely cosmetic, no logic depends on these strings).
  const STAGE_LABELS = {
    POSTED: 'Load Posted', MATCHED: 'AI Match Found', BIDDING_OPEN: 'Open for Bidding',
    ASSIGNED: 'Carrier Assigned', DRIVER_ACCEPTED: 'Driver Accepted', DRIVER_REJECTED: 'Driver Rejected — Reassigning',
    ARRIVED_PICKUP: 'Reached Pickup', LOADING: 'Loading', LOADED: 'Picked Up', DEPARTED_PICKUP: 'Departed Pickup',
    IN_TRANSIT: 'In Transit', REACHED_DESTINATION: 'Reached Destination', UNLOADING: 'Unloading',
    UNLOADING_COMPLETE: 'Unloading Completed', DELIVERED: 'Delivered', COMPLETED: 'Completed',
  };

  // Cosmetic-only client-side bucketing of the Trust Score the API already
  // returns — no extra API call, just a friendlier label next to the number.
  function trustLabel(score) {
    if (score == null) return '';
    if (score >= 85) return 'Excellent';
    if (score >= 70) return 'Good';
    if (score >= 50) return 'Fair';
    return 'Needs review';
  }

  let allLoads = [];
  const offersByToken = {}; // tokenNo -> { loadStage, biddingDeadline, offers: [...] }

  // A load counts as "bidding" for this page if it was posted with
  // assignmentMode 'bidding', is currently open for bidding, or already has
  // a winning bid — i.e. any load that went through (or is going through)
  // the bidding flow, per spec.
  function isBiddingRecord(r) {
    return r.assignmentMode === 'bidding' || r.loadStage === 'BIDDING_OPEN' || !!r.winningBidId;
  }

  function renderOfferCard(tokenNo, o) {
    const trust = trustLabel(o.trustScore);
    return `
      <div class="offer-card ${o.rank === 1 ? 'rank-1' : ''}">
        <span class="offer-rank-badge">${o.rank === 1 ? '⭐ #1 Recommended' : '#' + o.rank}</span>
        <div class="offer-main">
          <div class="offer-carrier">${o.carrierCompanyName || 'Carrier'}</div>
          <div class="offer-price">${formatINR(o.finalShipperPrice)}</div>
          <div class="offer-meta-grid">
            <div class="info-cell"><div class="k">Truck Type</div><div class="v">${o.truckType || '—'}${o.bodyType ? ' · ' + o.bodyType : ''}</div></div>
            <div class="info-cell"><div class="k">Capacity</div><div class="v">${o.capacityTons != null ? o.capacityTons + ' tons' : '—'}</div></div>
            <div class="info-cell"><div class="k">Current Location</div><div class="v">${o.currentLocation || '—'}</div></div>
            <div class="info-cell"><div class="k">Submitted</div><div class="v">${o.submittedAt ? new Date(o.submittedAt).toLocaleString() : '—'}</div></div>
          </div>
          ${o.notes ? `<div class="offer-notes">📝 ${o.notes}</div>` : ''}
        </div>
        <div class="offer-scores">
          <div class="score-badge match"><span class="num">${o.aiMatchScore != null ? o.aiMatchScore + '%' : '—'}</span><span class="lbl">AI Match</span></div>
          <div class="score-badge trust"><span class="num">${o.trustScore != null ? o.trustScore : '—'}</span><span class="lbl">${trust}</span></div>
        </div>
        <button type="button" class="accept-offer-btn" data-accept="${tokenNo}|${o.bidId}">Accept This Offer</button>
      </div>
    `;
  }

  function renderOffersBlock(r) {
    const data = offersByToken[r.tokenNo];
    if (!data) {
      return '<div class="offers-wrap"><div class="offers-title">Offers</div><p class="load-token">Loading offers…</p></div>';
    }
    if (!data.offers || !data.offers.length) {
      return '<div class="offers-wrap"><div class="offers-title">Offers</div><p class="load-token">No offers yet — check back soon, carriers are being notified.</p></div>';
    }
    return `
      <div class="offers-wrap">
        <div class="offers-title">Offers (${data.offers.length})</div>
        ${data.offers.map((o) => renderOfferCard(r.tokenNo, o)).join('')}
      </div>
    `;
  }

  function renderLoadCard(r) {
    const isOpen = r.loadStage === 'BIDDING_OPEN';
    const pillClass = isOpen ? 'open' : (r.loadStage && r.loadStage !== 'POSTED' && r.loadStage !== 'MATCHED' ? 'assigned' : '');

    let bodyHtml = '';
    if (isOpen) {
      bodyHtml = renderOffersBlock(r);
    } else if (r.carrierCompanyName) {
      bodyHtml = `<div class="carrier-selected-box">✅ Carrier Selected: ${r.carrierCompanyName}</div>`;
    }

    return `
      <div class="load-card" data-token="${r.tokenNo}">
        <div class="load-head">
          <div>
            <div class="load-route">${r.pickup || '—'} → ${r.destination || '—'}</div>
            <div class="load-token">Token No. ${r.tokenNo || '—'} ${r.tokenNo ? LS.copyBtnHtml(r.tokenNo) : ''}</div>
          </div>
          <span class="status-pill ${pillClass}">${STAGE_LABELS[r.loadStage] || r.loadStage || '—'}</span>
        </div>

        <div class="info-grid">
          <div class="info-cell"><div class="k">Material</div><div class="v">${r.material || '—'}</div></div>
          <div class="info-cell"><div class="k">Load</div><div class="v">${r.weight != null ? r.weight + ' tons' : '—'}</div></div>
          <div class="info-cell"><div class="k">Distance</div><div class="v">${r.distanceKm != null ? r.distanceKm + ' km' : '—'}</div></div>
        </div>

        ${r.biddingDeadline ? `<div class="deadline-row">Bidding closes: <b>${new Date(r.biddingDeadline).toLocaleString()}</b></div>` : ''}
        ${bodyHtml}
      </div>
    `;
  }

  function renderList() {
    const wrap = document.getElementById('loadListWrap');
    if (!allLoads.length) {
      wrap.innerHTML = '<div class="empty-state">No loads posted for Carrier Bidding yet. Post a load from Estimate &amp; Booking and choose "Open for Carrier Bidding".</div>';
      return;
    }
    wrap.innerHTML = allLoads.map(renderLoadCard).join('');
    wrap.querySelectorAll('[data-accept]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [tokenNo, bidId] = btn.getAttribute('data-accept').split('|');
        acceptOffer(tokenNo, bidId, btn);
      });
    });
  }

  function acceptOffer(tokenNo, bidId, btn) {
    if (btn) btn.disabled = true;
    fetch('/api/shipper/loads/' + encodeURIComponent(tokenNo) + '/bids/' + encodeURIComponent(bidId) + '/accept', {
      method: 'POST',
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not accept that offer.');
        return data;
      })
      .then(() => {
        if (window.LS && LS.showSuccess) LS.showSuccess('Carrier selected!');
        delete offersByToken[tokenNo];
        loadList();
      })
      .catch((err) => {
        showError(err.message);
        // Someone else may have just accepted a different offer, or the
        // truck became unavailable — refresh so the card reflects reality.
        delete offersByToken[tokenNo];
        loadList();
      });
  }

  function fetchOffersFor(tokenNo) {
    return fetch('/api/shipper/loads/' + encodeURIComponent(tokenNo) + '/bids')
      .then((res) => res.json())
      .then((data) => { offersByToken[tokenNo] = (data && Array.isArray(data.offers)) ? data : { offers: [] }; })
      .catch(() => { offersByToken[tokenNo] = { offers: [] }; });
  }

  function loadList() {
    fetch('/api/my-bookings?_=' + Date.now())
      .then((res) => {
        if (res.status === 401) { window.location.href = '/login/shipper'; return null; }
        return res.json();
      })
      .then((records) => {
        if (!records) return;
        if (!Array.isArray(records)) throw new Error(records.error || 'Could not load your loads.');
        allLoads = records.filter(isBiddingRecord);
        const openTokens = allLoads.filter((r) => r.loadStage === 'BIDDING_OPEN').map((r) => r.tokenNo);
        Object.keys(offersByToken).forEach((t) => { if (openTokens.indexOf(t) === -1) delete offersByToken[t]; });
        renderList(); // render immediately (shows "Loading offers…" for open loads)
        if (openTokens.length) {
          Promise.all(openTokens.map(fetchOffersFor)).then(renderList);
        }
      })
      .catch((err) => {
        document.getElementById('loadListWrap').innerHTML = '<div class="empty-state">Could not load your loads.</div>';
        showError(err.message || 'Could not load your loads.');
      });
  }

  loadList();

  // Poll every 12s (same convention as requests.js) so a newly-submitted
  // bid or a stage change (another tab accepting an offer, etc.) shows up
  // without a manual refresh.
  setInterval(loadList, 12000);
