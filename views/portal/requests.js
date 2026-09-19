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

  // Distinct named event for clicking through to Live Tracking from here —
  // in addition to the automatic PAGE_VIEW that fires once that page loads.
  const liveTrackingLink = document.getElementById('liveTrackingLink');
  if (liveTrackingLink) {
    liveTrackingLink.addEventListener('click', () => {
      if (window.LS && LS.Track) LS.Track.log('LIVE_TRACKING_OPENED', 'LIVE_TRACKING_OPENED');
    });
  }

  const errorBanner = document.getElementById('errorBanner');
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
    setTimeout(() => { errorBanner.style.display = 'none'; }, 5000);
  }
  function formatINR(n) { return n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN'); }

  // A plain <a href> can't carry a fetch() Authorization header, so private
  // document links (the auto-generated Load Invoice) need the token
  // appended as a query param — the server's getBearerToken() already
  // supports that fallback.
  function userDocUrl(url) {
    let token = '';
    try { token = sessionStorage.getItem('ls_user_token') || ''; } catch (e) { /* ignore */ }
    if (!token) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
  }

  const listWrap = document.getElementById('requestListWrap');
  let allRequests = [];

  // Internal status → display label / pill color, per the statuses called
  // for in the spec (Pending, Accepted, Rejected, Admin Counter Rate /
  // Awaiting Shipper Response).
  const STATUS_META = {
    pending:   { label: 'Pending',                  bg: 'rgba(232,114,44,0.16)', fg: '#8a4210' },
    countered: { label: 'Awaiting Shipper Response', bg: 'rgba(52,120,246,0.14)', fg: '#1c4f9c' },
    accepted:  { label: 'Accepted',                  bg: 'rgba(154,223,143,0.32)', fg: '#0e3a24' },
    rejected:  { label: 'Rejected',                  bg: 'rgba(192,57,43,0.16)',  fg: '#c0392b' },
  };

  function renderCard(r) {
    const meta = STATUS_META[r.status || 'pending'] || STATUS_META.pending;
    const providerLabel = r.carrierCompanyName
      ? r.carrierCompanyName + ' (Carrier)'
      : (r.brokerCompanyName ? r.brokerCompanyName + ' (Broker)' : 'Not selected — any provider');

    let rateBlockHtml = `
      <div class="rate-line"><span class="k">Your Requested Rate</span><span class="v">${formatINR(r.requestedRate)}</span></div>
    `;
    if (r.status === 'countered') {
      rateBlockHtml += `
        <div class="rate-line highlight"><span class="k">Admin Counter Rate</span><span class="v">${formatINR(r.adminOfferedRate)}</span></div>
        <div class="counter-actions">
          <button type="button" class="accept-counter-btn" data-id="${r.id}">Accept</button>
          <button type="button" class="reject-counter-btn" data-id="${r.id}">Reject</button>
        </div>
      `;
    } else if (r.adminOfferedRate != null) {
      rateBlockHtml += `<div class="rate-line"><span class="k">Admin Counter Rate</span><span class="v">${formatINR(r.adminOfferedRate)}</span></div>`;
    }
    if (r.finalRate != null) {
      rateBlockHtml += `<div class="rate-line final"><span class="k">Final Agreed Rate</span><span class="v">${formatINR(r.finalRate)}</span></div>`;
    }
    if (r.status === 'rejected' && r.rejectionReason) {
      rateBlockHtml += `<div class="rejection-reason">📝 ${r.rejectionReason}</div>`;
    }

    // Invoice — only relevant once the rate is finalized (accepted). Admin
    // requires this on file before the truck can be marked as loaded.
    let invoiceHtml = '';
    if (r.status === 'accepted') {
      const loadInvoiceHtml = r.loadInvoicePath
        ? `<div class="invoice-row"><span class="k">Load Invoice</span><a href="${userDocUrl('/api/orders/' + encodeURIComponent(r.tokenNo) + '/document/load-invoice')}" target="_blank" rel="noopener" class="invoice-link">📄 View (auto-generated)</a></div>`
        : '';
      if (r.invoicePath) {
        const verifiedChip = r.invoiceVerified
          ? '<span class="invoice-chip verified">✓ Verified by Admin</span>'
          : '<span class="invoice-chip pending">Awaiting Admin review</span>';
        invoiceHtml = `
          <div class="invoice-block">
            ${loadInvoiceHtml}
            <div class="invoice-row">
              <span class="k">Invoice</span>
              <a href="${r.invoicePath}" target="_blank" rel="noopener" class="invoice-link">📄 View uploaded invoice</a>
              ${verifiedChip}
            </div>
            <label class="invoice-reupload-label">Re-upload invoice
              <input type="file" class="invoice-file-input" data-id="${r.id}" accept="image/png,image/jpeg,application/pdf" style="display:none;">
            </label>
          </div>`;
      } else {
        invoiceHtml = `
          <div class="invoice-block">
            ${loadInvoiceHtml}
            <div class="invoice-row"><span class="k">Invoice</span><span class="invoice-chip missing">Not uploaded yet</span></div>
            <p class="invoice-note">Upload the invoice before the truck can be marked as loaded.</p>
            <label class="upload-invoice-btn">📎 Upload Invoice
              <input type="file" class="invoice-file-input" data-id="${r.id}" accept="image/png,image/jpeg,application/pdf" style="display:none;">
            </label>
            <span class="invoice-upload-hint" data-hint-for="${r.id}"></span>
          </div>`;
      }
    }

    return `
      <div class="request-card" data-id="${r.id}">
        <div class="request-head">
          <div>
            <div class="request-route">${r.pickup || '—'} → ${r.destination || '—'}</div>
            <div class="request-token">Token No. ${r.tokenNo || '—'} ${r.tokenNo ? LS.copyBtnHtml(r.tokenNo) : ''}</div>
          </div>
          <span class="status-pill" style="background:${meta.bg}; color:${meta.fg};">${meta.label}</span>
        </div>

        ${(r.pickupAddress || r.destAddress) ? `
        <div class="address-block">
          ${r.pickupAddress ? `<div class="addr-line"><b>Pickup Address:</b> ${r.pickupAddress}</div>` : ''}
          ${r.destAddress ? `<div class="addr-line"><b>Delivery Address:</b> ${r.destAddress}</div>` : ''}
        </div>` : ''}

        <div class="info-grid">
          <div class="info-cell"><div class="k">Material</div><div class="v">${r.material || '—'}</div></div>
          <div class="info-cell"><div class="k">Load</div><div class="v">${r.weight != null ? r.weight + ' tons' : '—'}</div></div>
          <div class="info-cell"><div class="k">Distance</div><div class="v">${r.distanceKm != null ? r.distanceKm + ' km' : '—'}</div></div>
          <div class="info-cell"><div class="k">Provider</div><div class="v">${providerLabel}</div></div>
          <div class="info-cell"><div class="k">Date / Time</div><div class="v">${r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'}</div></div>
        </div>

        <div class="rate-block">${rateBlockHtml}</div>
        ${invoiceHtml}
      </div>
    `;
  }

  function renderList(requests, query) {
    if (!allRequests.length) {
      listWrap.innerHTML = '<div class="empty-state">No rate requests yet. Send one from Estimate &amp; Booking → Send Rate Request, and it will appear here.</div>';
      return;
    }
    if (!requests.length) {
      listWrap.innerHTML = LS.noResultsHtml('No rate requests match "' + String(query || '').replace(/</g, '&lt;') + '".');
      return;
    }
    listWrap.innerHTML = requests.map(renderCard).join('');
    wireCardActions();
  }

  function wireCardActions() {
    listWrap.querySelectorAll('.accept-counter-btn').forEach((btn) => {
      btn.addEventListener('click', () => respondToCounter(btn.getAttribute('data-id'), 'accept'));
    });
    listWrap.querySelectorAll('.reject-counter-btn').forEach((btn) => {
      btn.addEventListener('click', () => respondToCounter(btn.getAttribute('data-id'), 'reject'));
    });
    listWrap.querySelectorAll('.invoice-file-input').forEach((input) => {
      input.addEventListener('change', () => uploadInvoice(input.getAttribute('data-id'), input));
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  function uploadInvoice(id, input) {
    const file = input.files[0];
    if (!file) return;
    const hint = listWrap.querySelector(`.invoice-upload-hint[data-hint-for="${id}"]`);
    if (hint) { hint.textContent = 'Uploading…'; hint.style.color = ''; }
    readFileAsDataUrl(file)
      .then((dataUrl) => fetch('/api/kyc/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'invoice', imageBase64: dataUrl }),
      }))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not upload that file.');
        return data;
      })
      .then((data) => fetch('/api/my-bookings/' + encodeURIComponent(id) + '/upload-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoicePath: data.path }),
      }))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save the invoice.');
        return data;
      })
      .then((data) => {
        const idx = allRequests.findIndex((r) => r.id === id);
        if (idx !== -1) allRequests[idx] = { ...allRequests[idx], invoicePath: data.invoicePath, invoiceUploadedAt: data.invoiceUploadedAt, invoiceVerified: false };
        refreshList();
        if (window.LS && LS.showSuccess) LS.showSuccess('Invoice uploaded successfully!');
      })
      .catch((err) => {
        if (hint) { hint.textContent = err.message; hint.style.color = 'var(--danger, #c0392b)'; }
        else alert(err.message);
      });
  }

  function respondToCounter(id, action) {
    const btns = listWrap.querySelectorAll(`.request-card[data-id="${id}"] .accept-counter-btn, .request-card[data-id="${id}"] .reject-counter-btn`);
    btns.forEach((b) => (b.disabled = true));
    fetch('/api/my-bookings/' + encodeURIComponent(id) + '/counter-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not submit your response.');
        return d;
      })
      .then((d) => {
        const idx = allRequests.findIndex((r) => r.id === id);
        if (idx !== -1) allRequests[idx] = { ...allRequests[idx], status: d.status, finalRate: d.finalRate, rejectionReason: d.rejectionReason };
        refreshList();
        if (window.LS && LS.showSuccess) {
          LS.showSuccess(action === 'accept' ? 'Counter rate accepted successfully!' : 'Counter rate rejected successfully!');
        }
      })
      .catch((err) => {
        showError(err.message);
        btns.forEach((b) => (b.disabled = false));
      });
  }

  function currentQuery() {
    return document.getElementById('reqSearchInput').value.trim();
  }

  function refreshList() {
    const query = currentQuery();
    const filtered = query
      ? allRequests.filter((r) => LS.matchAny(r, query, ['tokenNo', 'pickup', 'destination', 'material']))
      : allRequests;
    renderList(filtered, query);
  }

  function loadRequests() {
    fetch('/api/my-bookings?_=' + Date.now())
      .then((res) => {
        if (res.status === 401) { window.location.href = '/login/shipper'; return null; }
        return res.json();
      })
      .then((records) => {
        if (!records) return;
        // The Request page is specifically for the rate-negotiation
        // workflow — show rate_request records (booking records have their
        // own "Book Now" flow with no negotiation to track).
        allRequests = records.filter((r) => r.kind === 'rate_request');
        refreshList();
      })
      .catch(() => {
        listWrap.innerHTML = '<div class="empty-state">Could not load your rate requests.</div>';
      });
  }

  LS.wireLocalSearch({
    inputEl: document.getElementById('reqSearchInput'),
    getRecords: () => allRequests,
    fields: ['tokenNo', 'pickup', 'destination', 'material'],
    onResults: (filtered, query) => renderList(filtered, query),
  });

  loadRequests();

  // Poll every 12s so admin actions (accept / counter-offer) show up here
  // without the shipper needing to refresh — same pattern as Live Tracking.
  setInterval(loadRequests, 12000);
