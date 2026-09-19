  const role = window.location.pathname.split('/').filter(Boolean).pop();
  let allRecords = [];
  let tableCols = null;
  // Shipper-only card/detail view state (broker/carrier keep the existing
  // dynamic table below, completely unchanged).
  let shipperView = 'list'; // 'list' | 'detail'
  let shipperDetailId = null;
  // Broker card/detail view state — same "Tracking-style" pattern as
  // Shipper above, but backed by the richer /api/admin/brokers endpoints
  // (KYC workflow, GST/MSME detail, AI document review, activity timeline)
  // rather than the generic /api/registrations/broker list.
  let brokerView = 'list'; // 'list' | 'detail'
  let brokerDetailId = null;
  let brokerDetailData = null; // full GET /api/admin/brokers/:id payload (incl. dashboard.timeline)

  const labels = {
    id: 'Ref ID', companyName: 'Company', contactPerson: 'Contact', phoneNumber: 'Phone',
    mobileNumber: 'Mobile', email: 'Email', username: 'Username', submittedAt: 'Submitted', active: 'Visible',
    status: 'KYC review', facePhotoPath: 'Face photo', officePhotoPath: 'Office Photo',
    aadharFrontPhotoPath: 'Aadhaar front', aadharBackPhotoPath: 'Aadhaar back',
    panNumber: 'PAN', aadharNumber: 'Aadhaar', gstNumber: 'GST', msmeNumber: 'MSME / Udyam Number',
    gstPhotoPath: 'GST Certificate', msmePhotoPath: 'MSME Certificate', loadingSlipPath: 'Loading Slip',
    bankAccountHolder: 'Account Holder', bankAccountNumber: 'Account Number', bankIfsc: 'IFSC Code',
    bankName: 'Bank Name', bankBranch: 'Branch', bankAccountType: 'Account Type',
    bankProofPhotoPath: 'Bank Proof', bankVerificationStatus: 'Bank Verification',
    driverAadharNumber: 'Driver Aadhaar', driverAadharFrontPhotoPath: 'Driver Aadhaar (front)',
    driverAadharBackPhotoPath: 'Driver Aadhaar (back)', driverRcPhotoPath: 'Driver RC Photo', driverDlPhotoPath: 'Driver DL Photo',
  };
  const photoCols = new Set([
    'facePhotoPath', 'officePhotoPath', 'aadharFrontPhotoPath', 'aadharBackPhotoPath', 'bankProofPhotoPath',
    'driverAadharFrontPhotoPath', 'driverAadharBackPhotoPath', 'driverRcPhotoPath', 'driverDlPhotoPath',
    'gstPhotoPath', 'msmePhotoPath', 'loadingSlipPath',
  ]);
  // Admin-only sensitive fields — masked by default, revealed with an
  // explicit per-row "Show" click (never auto-shown, never logged).
  const maskedCols = new Set(['panNumber', 'aadharNumber', 'gstNumber', 'bankAccountNumber', 'driverAadharNumber']);

  function maskValue(value) {
    const str = String(value);
    if (str.length <= 4) return 'x'.repeat(str.length);
    return 'x'.repeat(str.length - 4) + str.slice(-4);
  }
  function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // ROOT CAUSE FIX (KYC photo not visible): /admin/kyc-photo/:filename is
  // protected by requireAdmin, which reads the session token from the
  // Authorization header. A plain <img src="..."> or <a href="..."> request
  // can't attach a custom header the way fetch() can — so the browser was
  // silently getting back a 401 JSON error instead of the actual image,
  // making every KYC photo appear broken/blank. The server already
  // supports a `?token=` query-string fallback for exactly this situation
  // (see getBearerToken in server_load.js); this just uses it.
  function withAdminToken(url) {
    if (!url) return url;
    let token = '';
    try { token = sessionStorage.getItem('ls_admin_token') || ''; } catch (e) { /* ignore */ }
    if (!token) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
  }

  function buildColumns(records) {
    const priority = ['id','companyName','contactPerson','phoneNumber','mobileNumber','email','username','submittedAt'];
    const allKeys = new Set();
    records.forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));
    const skip = new Set(['password','confirmPassword','status']);
    const cols = priority.filter(k => allKeys.has(k) && !skip.has(k));
    allKeys.forEach(k => { if (!cols.includes(k) && !skip.has(k)) cols.push(k); });
    cols.push('active');
    cols.push('status');
    return cols;
  }

  function renderTable(records, query) {
    if (role === 'shipper') { renderShipperView(records, query); return; }
    if (role === 'broker') { renderBrokerView(records, query); return; }
    const wrap = document.getElementById('tableWrap');
    const countLine = document.getElementById('countLine');

    if (!allRecords.length) {
      countLine.textContent = 'No registrations yet.';
      wrap.innerHTML = '<div class="empty-state">Nobody has registered as a ' + role + ' yet. New sign-ups will appear here automatically.</div>';
      return;
    }
    if (!records.length) {
      countLine.textContent = '0 of ' + allRecords.length + ' ' + (allRecords.length === 1 ? role : role + 's') + ' match your search.';
      wrap.innerHTML = LS.noResultsHtml('No ' + role + 's match "' + String(query || '').replace(/</g, '&lt;') + '".');
      return;
    }
    countLine.textContent = query
      ? records.length + ' of ' + allRecords.length + ' ' + (allRecords.length === 1 ? role : role + 's') + ' match your search.'
      : records.length + ' registered ' + (records.length === 1 ? role : role + 's') + '.';

    const cols = tableCols || (tableCols = buildColumns(allRecords));

    let html = '<table><thead><tr>';
    cols.forEach(c => { html += '<th>' + (labels[c] || c) + '</th>'; });
    html += '</tr></thead><tbody>';

    records.slice().reverse().forEach(r => {
      html += '<tr>';
      cols.forEach(c => {
        let val = r[c] === undefined || r[c] === '' ? '—' : r[c];
        if (c === 'id') {
          val = '<span class="id-badge">' + val + '</span> '
            + '<button type="button" onclick="openKycDocumentsModal(\'' + r.id + '\',\'' + role + '\')" style="margin-left:4px;padding:3px 8px;border-radius:6px;border:1px solid var(--line);background:#f3f1e9;cursor:pointer;font-size:11px;">KYC Docs</button>';
        }
        if (c === 'submittedAt' && r[c]) val = new Date(r[c]).toLocaleString();
        if (photoCols.has(c) && !r[c]) {
          val = '<span class="kyc-photo-missing">Document not uploaded</span>';
        }
        if (photoCols.has(c) && r[c]) {
          const photoUrl = withAdminToken(r[c]);
          const isPdf = /\.pdf($|\?)/i.test(r[c]);
          val = isPdf
            ? '<a href="' + photoUrl + '" target="_blank" rel="noopener" class="doc-pdf-link">📄 View PDF</a>'
            // onerror: a broken/expired/missing file must never render as a
            // dead image icon — swap it for a clear, honest message instead
            // (same rule the shipper/broker detail views already follow).
            : '<a href="' + photoUrl + '" target="_blank" rel="noopener"><img src="' + photoUrl + '" alt="' + (labels[c] || c) + '" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--line);" onerror="this.closest(\'a\').outerHTML=\'<div class=&quot;kyc-photo-missing&quot;>Photo unavailable</div>\'"></a>';
        }
        if (maskedCols.has(c) && r[c]) {
          val = '<span class="masked-val" data-full="' + escapeAttr(r[c]) + '" data-masked="' + escapeAttr(maskValue(r[c])) + '" data-shown="0" style="font-family:monospace;">' + maskValue(r[c]) + '</span>'
            + ' <button type="button" onclick="toggleMask(this)" style="padding:2px 8px;border-radius:6px;border:1px solid var(--line);background:#f3f1e9;cursor:pointer;font-size:11px;">Show</button>';
        }
        if (c === 'username' && r[c]) {
          val = '<span style="font-family:monospace;">' + r[c] + '</span> ' + LS.copyBtnHtml(r[c]);
        }
        if (c === 'active') val = '<button onclick="toggleActive(\'' + r.id + '\',this)" style="padding:4px 10px;border-radius:6px;border:none;cursor:pointer;background:' + (r.active !== false ? '#9adf8f' : '#e8722c') + '">' + (r.active !== false ? 'Active' : 'Inactive') + '</button>';
        if (c === 'status') {
          const st = r.status || 'pending';
          const colorMap = { pending: '#e8722c', accepted: '#9adf8f', rejected: '#c0392b' };
          const textColorMap = { pending: '#3d2a12', accepted: '#0e3a24', rejected: '#fff' };
          val = '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">'
            + '<span style="font-size:11px; font-weight:700; text-transform:uppercase; padding:3px 9px; border-radius:999px; background:' + colorMap[st] + '; color:' + textColorMap[st] + ';">' + st + '</span>'
            + '<button onclick="setStatus(\'' + r.id + '\',\'accepted\',this)" style="padding:4px 8px;border-radius:6px;border:none;cursor:pointer;background:#9adf8f;font-size:11.5px;">Accept</button>'
            + '<button onclick="openRejectModal(\'' + r.id + '\',this)" style="padding:4px 8px;border-radius:6px;border:none;cursor:pointer;background:#e57368;color:#fff;font-size:11.5px;">Reject</button>'
            + '</div>';
        }
        html += '<td>' + val + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  // Broker uses the richer, KYC-workflow-aware /api/admin/brokers listing
  // (search/kycStatus filter already server-side); every other role keeps
  // the original generic /api/registrations/:role listing unchanged.
  fetch(role === 'broker' ? '/api/admin/brokers' : '/api/registrations/' + role)
    .then(res => res.json())
    .then(records => {
      allRecords = records;
      renderTable(allRecords, '');
    })
    .catch(() => {
      document.getElementById('countLine').textContent = 'Could not load data.';
    });

  // ---- Search (instant, local — the full list is already on the page) ----
  // Matches the query against every plain text/number field on the record
  // (username, company, contact person, email, phone, GST/PAN, etc.) so it
  // works consistently regardless of which fields a given role's form has.
  function recordMatchesQuery(record, query) {
    const q = query.toLowerCase();
    return Object.keys(record).some((key) => {
      if (key === 'password' || key === 'confirmPassword') return false;
      const v = record[key];
      if (v == null || typeof v === 'object') return false;
      return String(v).toLowerCase().includes(q);
    });
  }
  LS.wireLocalSearch({
    inputEl: document.getElementById('recordSearchInput'),
    getRecords: () => allRecords,
    fields: [], // custom matcher used instead — see onResults below
    onResults: (_ignored, query) => {
      const filtered = query ? allRecords.filter((r) => recordMatchesQuery(r, query)) : allRecords;
      renderTable(filtered, query);
    },
  });

  function toggleActive(id, btn){
    fetch('/api/registrations/' + role + '/' + id + '/toggle', {method:'POST'})
      .then(r => r.json())
      .then(d => {
        btn.textContent = d.active ? 'Active' : 'Inactive';
        btn.style.background = d.active ? '#9adf8f' : '#e8722c';
      });
  }

  // Reveal/mask a single Aadhaar/PAN/GST cell in place — no extra network
  // request (the admin already fetched the full record), and nothing is
  // ever written to the console.
  function toggleMask(btn){
    const span = btn.previousElementSibling;
    const shown = span.getAttribute('data-shown') === '1';
    if (shown) {
      span.textContent = span.getAttribute('data-masked');
      span.setAttribute('data-shown', '0');
      btn.textContent = 'Show';
    } else {
      span.textContent = span.getAttribute('data-full');
      span.setAttribute('data-shown', '1');
      btn.textContent = 'Hide';
    }
  }

  function setStatus(id, status, btn, reason){
    fetch('/api/registrations/' + role + '/' + id + '/status', {
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
        const badge = btn.closest('div').querySelector('span');
        const colorMap = { pending: '#e8722c', accepted: '#9adf8f', rejected: '#c0392b' };
        const textColorMap = { pending: '#3d2a12', accepted: '#0e3a24', rejected: '#fff' };
        badge.textContent = d.status;
        badge.style.background = colorMap[d.status];
        badge.style.color = textColorMap[d.status];
      })
      .catch(err => alert(err.message));
  }

  // ---- Reject reason modal (reason is mandatory) ----
  // Shared by the broker/carrier table AND the shipper card/detail view
  // below — pass a callback for the new shipper flow, or omit it to use
  // the original btn-based table flow unchanged.
  let pendingRejectId = null;
  let pendingRejectBtn = null;
  let pendingRejectCallback = null;
  const rejectModal = document.getElementById('rejectModal');
  const rejectReasonSelect = document.getElementById('rejectReasonSelect');
  const rejectOtherText = document.getElementById('rejectOtherText');
  const rejectError = document.getElementById('rejectError');

  function openRejectModal(id, btn, callback, titleOverride){
    pendingRejectId = id;
    pendingRejectBtn = btn;
    pendingRejectCallback = callback || null;
    rejectReasonSelect.value = '';
    rejectOtherText.value = '';
    rejectOtherText.style.display = 'none';
    rejectError.style.display = 'none';
    const titleEl = rejectModal.querySelector('h3');
    const descEl = rejectModal.querySelector('p');
    if (titleOverride) {
      titleEl.textContent = titleOverride.title;
      descEl.textContent = titleOverride.desc;
    } else {
      titleEl.textContent = 'Reject this account';
      descEl.textContent = 'Select a reason. This will be shown to the account holder on their portal page.';
    }
    rejectModal.style.display = 'flex';
  }
  function closeRejectModal(){
    rejectModal.style.display = 'none';
    pendingRejectId = null;
    pendingRejectBtn = null;
    pendingRejectCallback = null;
  }

  rejectReasonSelect.addEventListener('change', () => {
    rejectOtherText.style.display = rejectReasonSelect.value === 'Other' ? 'block' : 'none';
  });
  document.getElementById('rejectCancelBtn').addEventListener('click', closeRejectModal);
  document.getElementById('rejectConfirmBtn').addEventListener('click', () => {
    const selected = rejectReasonSelect.value;
    const reason = selected === 'Other' ? rejectOtherText.value.trim() : selected;
    if (!reason) {
      rejectError.style.display = 'block';
      return;
    }
    if (pendingRejectCallback) {
      pendingRejectCallback(reason);
    } else {
      setStatus(pendingRejectId, 'rejected', pendingRejectBtn, reason);
    }
    closeRejectModal();
  });

  // =====================================================================
  // ---- Shipper-only: card list + detail view (Tracking-style pattern) ----
  // Broker/Carrier are untouched above; this is purely additive and only
  // ever runs when role === 'shipper'.
  // =====================================================================
  function escapeHtml(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function shipperStatusBadgeHtml(st){
    const colorMap = { pending: '#e8722c', accepted: '#9adf8f', rejected: '#c0392b' };
    const textColorMap = { pending: '#3d2a12', accepted: '#0e3a24', rejected: '#fff' };
    return '<span class="status-pill" style="background:' + colorMap[st || 'pending'] + '; color:' + textColorMap[st || 'pending'] + ';">' + (st || 'pending') + '</span>';
  }

  function renderShipperView(records, query){
    const wrap = document.getElementById('tableWrap');
    const countLine = document.getElementById('countLine');

    if (shipperView === 'detail' && shipperDetailId) {
      const rec = allRecords.find(r => r.id === shipperDetailId);
      if (!rec) { shipperView = 'list'; shipperDetailId = null; }
      else { countLine.textContent = ''; renderShipperDetail(wrap, rec); return; }
    }

    if (!allRecords.length) {
      countLine.textContent = 'No registrations yet.';
      wrap.innerHTML = '<div class="empty-state">Nobody has registered as a shipper yet. New sign-ups will appear here automatically.</div>';
      return;
    }
    if (!records.length) {
      countLine.textContent = '0 of ' + allRecords.length + ' shippers match your search.';
      wrap.innerHTML = LS.noResultsHtml('No shippers match "' + escapeHtml(query || '') + '".');
      return;
    }
    countLine.textContent = query
      ? records.length + ' of ' + allRecords.length + ' shippers match your search.'
      : records.length + ' registered ' + (records.length === 1 ? 'shipper' : 'shippers') + '.';

    wrap.innerHTML = '<div class="shipper-card-grid">' + records.slice().reverse().map(r => `
      <div class="shipper-card" data-id="${escapeHtml(r.id)}">
        <div class="sc-top">
          <div class="sc-name">${escapeHtml(r.companyName || r.contactPerson || r.username || '—')}</div>
          ${shipperStatusBadgeHtml(r.status)}
        </div>
        <div class="sc-username">Username: <b>${escapeHtml(r.username || '—')}</b></div>
        <div class="sc-meta-row">
          <span class="sc-chip ${r.active !== false ? 'on' : 'off'}">${r.active !== false ? 'Active' : 'Inactive'}</span>
          ${r.updateLocked ? '<span class="sc-chip lock">Update Locked</span>' : ''}
        </div>
      </div>
    `).join('') + '</div>';

    wrap.querySelectorAll('.shipper-card').forEach(card => {
      card.addEventListener('click', () => {
        shipperView = 'detail';
        shipperDetailId = card.getAttribute('data-id');
        renderShipperView(allRecords, '');
      });
    });
  }

  function renderShipperDetail(wrap, r){
    const sections = [
      { title: 'Contact Details', fields: [['companyName','Company'],['contactPerson','Contact Person'],['phoneNumber','Phone'],['email','Email']] },
      { title: 'Address Details', fields: [['state','State'],['district','District'],['area','Area'],['pincode','Pincode'],['pickupAddress','Pickup Address']] },
      { title: 'Business / GST Details', fields: [['businessDetail','Business Detail'],['gstNumber','GST Number'],['panNumber','PAN Number'],['aadharNumber','Aadhaar Number (legacy)']] },
      { title: 'Registration Info', fields: [['id','Reference ID'],['username','Username'],['submittedAt','Submitted']] },
    ];
    const maskedInDetail = new Set(['panNumber','aadharNumber','gstNumber']);

    let sectionsHtml = sections.map(sec => {
      const rows = sec.fields.filter(([k]) => r[k] !== undefined && r[k] !== '' && r[k] !== null);
      if (!rows.length) return '';
      return '<div class="detail-section"><h3>' + sec.title + '</h3><div class="detail-grid">' + rows.map(([k,label]) => {
        let val = r[k];
        if (k === 'submittedAt') val = new Date(val).toLocaleString();
        if (k === 'submittedAt') {
          return '<div class="drow"><span class="k">' + label + '</span><span class="v">' + escapeHtml(val) + '</span></div>';
        }
        if (maskedInDetail.has(k)) {
          return '<div class="drow"><span class="k">' + label + '</span><span class="v">'
            + '<span class="masked-val" data-full="' + escapeAttr(r[k]) + '" data-masked="' + escapeAttr(maskValue(r[k])) + '" data-shown="0" style="font-family:monospace;">' + escapeHtml(maskValue(r[k])) + '</span>'
            + ' <button type="button" onclick="toggleMask(this)" style="padding:2px 8px;border-radius:6px;border:1px solid var(--line);background:#f3f1e9;cursor:pointer;font-size:11px;">Show</button>'
            + '</span></div>';
        }
        return '<div class="drow"><span class="k">' + label + '</span><span class="v">' + escapeHtml(val) + '</span></div>';
      }).join('') + '</div></div>';
    }).join('');

    // officePhotoPath is the current, mandatory Shipper photo. face/Aadhaar
    // photo paths are only ever present on older records from before the
    // Selfie->Office Photo switch — shown here too so that legacy KYC data
    // isn't hidden from Admin, but no new registration ever produces them.
    const kycPhotos = ['officePhotoPath', 'facePhotoPath', 'aadharFrontPhotoPath', 'aadharBackPhotoPath'].filter(k => r[k]);
    if (kycPhotos.length) {
      sectionsHtml += '<div class="detail-section"><h3>KYC Photos</h3><div class="kyc-photo-row">' + kycPhotos.map(k => {
        const photoUrl = withAdminToken(r[k]);
        return `<a href="${photoUrl}" target="_blank" rel="noopener"><img src="${photoUrl}" alt="${labels[k] || k}" onerror="this.closest('a').outerHTML='<div class=&quot;kyc-photo-missing&quot;>Photo unavailable</div>'"></a>`;
      }).join('') + '</div></div>';
    } else if (r.status) {
      // Shipper record exists but no KYC photo paths on file — show this
      // explicitly rather than silently omitting the whole section, so
      // "no photo uploaded" isn't confused with "photo failed to load".
      sectionsHtml += '<div class="detail-section"><h3>KYC Photos</h3><div class="kyc-photo-missing">No KYC photos on file for this shipper.</div></div>';
    }

    // Business certificate — either GST or MSME, whichever the shipper
    // chose to upload (never both). PDFs can't render in an <img>, so this
    // shows a clickable file link, with an inline preview only for images.
    const bizDocPath = r.gstPhotoPath || r.msmePhotoPath || '';
    const bizDocLabel = r.gstPhotoPath ? 'GST Certificate' : 'MSME / Udyam Certificate';
    if (bizDocPath) {
      const docUrl = withAdminToken(bizDocPath);
      const isPdf = /\.pdf($|\?)/i.test(bizDocPath);
      const preview = isPdf
        ? `<a href="${docUrl}" target="_blank" rel="noopener" class="doc-pdf-link">📄 View ${bizDocLabel} (PDF)</a>`
        : `<a href="${docUrl}" target="_blank" rel="noopener"><img src="${docUrl}" alt="${bizDocLabel}" onerror="this.closest('a').outerHTML='<div class=&quot;kyc-photo-missing&quot;>Photo unavailable</div>'"></a>`;
      sectionsHtml += `<div class="detail-section"><h3>Business Certificate</h3><div class="kyc-photo-row"><div><div style="font-size:11.5px;color:#7a867e;margin-bottom:6px;">${bizDocLabel}</div>${preview}</div></div></div>`;
    }

    // Bank Details + Bank KYC — collected at registration, reviewed here so
    // Admin can confirm the details actually match the uploaded proof
    // (cancelled cheque / passbook) before payouts rely on them.
    if (r.bankAccountNumber || r.bankProofPhotoPath) {
      const bankRows = [
        ['bankAccountHolder', 'Account Holder'],
        ['bankAccountNumber', 'Account Number'],
        ['bankIfsc', 'IFSC Code'],
        ['bankName', 'Bank Name'],
        ['bankBranch', 'Branch'],
        ['bankAccountType', 'Account Type'],
      ].filter(([k]) => r[k]);
      const bankGrid = bankRows.map(([k, label]) => {
        let val = r[k];
        if (k === 'bankAccountNumber') val = maskValue(val);
        if (k === 'bankAccountType') val = val.charAt(0).toUpperCase() + val.slice(1);
        return `<div class="drow"><span class="k">${label}</span><span class="v">${escapeHtml(val)}</span></div>`;
      }).join('');
      let proofHtml = '<div class="kyc-photo-missing">No bank proof document on file.</div>';
      if (r.bankProofPhotoPath) {
        const proofUrl = withAdminToken(r.bankProofPhotoPath);
        const isPdf = /\.pdf($|\?)/i.test(r.bankProofPhotoPath);
        proofHtml = isPdf
          ? `<a href="${proofUrl}" target="_blank" rel="noopener" class="doc-pdf-link">📄 View bank proof (PDF)</a>`
          : `<a href="${proofUrl}" target="_blank" rel="noopener"><img src="${proofUrl}" alt="Bank proof" onerror="this.closest('a').outerHTML='<div class=&quot;kyc-photo-missing&quot;>Photo unavailable</div>'"></a>`;
      }
      const bankStatus = r.bankVerificationStatus || 'pending';
      const bankStatusMeta = {
        pending: { label: 'Pending Verification', bg: '#e8722c', fg: '#3d2a12' },
        verified: { label: 'Verified', bg: '#9adf8f', fg: '#0e3a24' },
        rejected: { label: 'Rejected', bg: '#c0392b', fg: '#fff' },
      }[bankStatus];
      const bankActionsDisabled = !r.bankProofPhotoPath;
      sectionsHtml += `
        <div class="detail-section">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
            <h3 style="margin-bottom:0;">Bank Details &amp; Bank KYC</h3>
            <span class="status-pill" style="background:${bankStatusMeta.bg}; color:${bankStatusMeta.fg};">${bankStatusMeta.label}</span>
          </div>
          <div class="detail-grid" style="margin-bottom:14px;">${bankGrid}</div>
          <div style="font-size:11.5px;color:#7a867e;margin-bottom:6px;">Bank Proof Document</div>
          <div class="kyc-photo-row" style="margin-bottom:14px;"><div>${proofHtml}</div></div>
          ${bankStatus === 'rejected' && r.bankRejectionReason ? `<div class="rejection-note" style="margin-bottom:14px;">📝 ${escapeHtml(r.bankRejectionReason)}</div>` : ''}
          <div class="accept-reject-group">
            <button type="button" class="accept-btn" id="sdBankVerifyBtn" ${bankActionsDisabled || bankStatus === 'verified' ? 'disabled' : ''}>Mark Bank Details Verified</button>
            <button type="button" class="reject-btn" id="sdBankRejectBtn" ${bankActionsDisabled || bankStatus === 'rejected' ? 'disabled' : ''}>Reject Bank Details</button>
          </div>
        </div>`;
    }

    const st = r.status || 'pending';
    const isFinal = false; // admin can always change a shipper's KYC status, unlike finalized rate requests
    wrap.innerHTML = `
      <button type="button" class="back-to-list-btn" id="shipperBackBtn">← Back to all shippers</button>
      <div class="shipper-detail-head">
        <div>
          <h2>${escapeHtml(r.companyName || r.contactPerson || r.username || '—')}</h2>
          <div class="sub">Username <b>${escapeHtml(r.username || '—')}</b></div>
        </div>
        <div class="shipper-detail-actions">
          ${shipperStatusBadgeHtml(st)}
          <button class="sd-btn accept" id="sdAcceptBtn">Accept</button>
          <button class="sd-btn reject" id="sdRejectBtn">Reject</button>
          <button type="button" onclick="openKycDocumentsModal('${r.id}','shipper')" style="padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:#f3f1e9;cursor:pointer;font-size:12.5px;">KYC Document Review</button>
        </div>
      </div>

      <div class="detail-section">
        <h3>Account Status</h3>
        <div class="detail-grid">
          <div class="drow"><span class="k">Visibility</span><span class="v">
            <button class="sd-toggle ${r.active !== false ? 'on' : 'off'}" id="sdActiveBtn">${r.active !== false ? 'Active' : 'Inactive'}</button>
          </span></div>
          <div class="drow"><span class="k">Update Lock</span><span class="v">
            <button class="sd-toggle ${r.updateLocked ? 'off' : 'on'}" id="sdLockBtn">${r.updateLocked ? 'Locked (shipper cannot update)' : 'Unlocked (shipper can update)'}</button>
          </span></div>
          ${r.rejectionReason ? '<div class="drow"><span class="k">Rejection Reason</span><span class="v">' + escapeHtml(r.rejectionReason) + '</span></div>' : ''}
        </div>
      </div>

      ${sectionsHtml}
    `;

    document.getElementById('shipperBackBtn').addEventListener('click', () => {
      shipperView = 'list'; shipperDetailId = null; renderShipperView(allRecords, '');
    });
    document.getElementById('sdAcceptBtn').addEventListener('click', () => {
      shipperSetStatus(r.id, 'accepted');
    });
    document.getElementById('sdRejectBtn').addEventListener('click', () => {
      openRejectModal(r.id, null, (reason) => shipperSetStatus(r.id, 'rejected', reason));
    });
    document.getElementById('sdActiveBtn').addEventListener('click', () => {
      fetch('/api/registrations/shipper/' + r.id + '/toggle', { method: 'POST' })
        .then(res => res.json())
        .then(d => {
          const idx = allRecords.findIndex(x => x.id === r.id);
          if (idx !== -1) allRecords[idx].active = d.active;
          renderShipperView(allRecords, '');
        })
        .catch(() => alert('Could not update visibility.'));
    });
    document.getElementById('sdLockBtn').addEventListener('click', () => {
      const nextLocked = !r.updateLocked;
      fetch('/api/registrations/shipper/' + r.id + '/update-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: nextLocked }),
      })
        .then(res => res.json())
        .then(d => {
          const idx = allRecords.findIndex(x => x.id === r.id);
          if (idx !== -1) allRecords[idx].updateLocked = d.updateLocked;
          renderShipperView(allRecords, '');
        })
        .catch(() => alert('Could not update the lock setting.'));
    });
    if (document.getElementById('sdBankVerifyBtn')) {
      document.getElementById('sdBankVerifyBtn').addEventListener('click', () => {
        bankVerifyAction(r.id, 'verified');
      });
    }
    if (document.getElementById('sdBankRejectBtn')) {
      document.getElementById('sdBankRejectBtn').addEventListener('click', () => {
        openRejectModal(r.id, null, (reason) => bankVerifyAction(r.id, 'rejected', reason), {
          title: 'Reject bank details',
          desc: 'Select a reason. This will be shown to the account holder so they can correct and re-upload their bank proof.',
        });
      });
    }
  }

  function bankVerifyAction(id, status, reason) {
    fetch('/api/registrations/shipper/' + id + '/bank-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    })
      .then(async res => {
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Could not update bank verification.');
        return d;
      })
      .then(d => {
        const idx = allRecords.findIndex(x => x.id === id);
        if (idx !== -1) {
          allRecords[idx].bankVerificationStatus = d.bankVerificationStatus;
          allRecords[idx].bankRejectionReason = d.bankRejectionReason;
        }
        renderShipperView(allRecords, '');
        if (window.LS && LS.showSuccess) {
          LS.showSuccess(status === 'verified' ? 'Bank details marked verified!' : 'Bank details rejected.');
        }
      })
      .catch(err => alert(err.message));
  }

  function shipperSetStatus(id, status, reason){
    fetch('/api/registrations/shipper/' + id + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    })
      .then(async res => {
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Could not update status.');
        return d;
      })
      .then(d => {
        const idx = allRecords.findIndex(x => x.id === id);
        if (idx !== -1) {
          allRecords[idx].status = d.status;
          allRecords[idx].rejectionReason = d.rejectionReason;
        }
        renderShipperView(allRecords, '');
        if (window.LS && LS.showSuccess) {
          LS.showSuccess(status === 'accepted' ? 'Shipper accepted successfully!' : 'Shipper rejected successfully!');
        }
      })
      .catch(err => alert(err.message));
  }

  // =====================================================================
  // ---- Broker-only: card list + detail view ----
  // Mirrors the Shipper card/detail pattern above, but reads/writes through
  // the broker-specific admin endpoints (server_load.js "Admin: Broker
  // management" section) so the full KYC workflow, GST/MSME detail, AI
  // document review results and activity timeline are all available —
  // none of this touches the Shipper/Carrier code paths above.
  // =====================================================================
  function brokerKycBadgeHtml(status){
    const st = status || 'DRAFT';
    const colorMap = { DRAFT: '#dfd9c6', SUBMITTED: '#e8722c', PENDING_REVIEW: '#e8722c', APPROVED: '#9adf8f', REJECTED: '#c0392b' };
    const textColorMap = { DRAFT: '#3d2a12', SUBMITTED: '#3d2a12', PENDING_REVIEW: '#3d2a12', APPROVED: '#0e3a24', REJECTED: '#fff' };
    return '<span class="status-pill" style="background:' + (colorMap[st] || '#dfd9c6') + '; color:' + (textColorMap[st] || '#3d2a12') + ';">' + st.replace('_', ' ') + '</span>';
  }

  function renderBrokerView(records, query){
    const wrap = document.getElementById('tableWrap');
    const countLine = document.getElementById('countLine');

    if (brokerView === 'detail' && brokerDetailId) {
      const rec = allRecords.find(r => r.id === brokerDetailId);
      if (!rec) { brokerView = 'list'; brokerDetailId = null; brokerDetailData = null; }
      else { countLine.textContent = ''; renderBrokerDetail(wrap, rec); return; }
    }

    if (!allRecords.length) {
      countLine.textContent = 'No registrations yet.';
      wrap.innerHTML = '<div class="empty-state">Nobody has registered as a broker yet. New sign-ups will appear here automatically.</div>';
      return;
    }
    if (!records.length) {
      countLine.textContent = '0 of ' + allRecords.length + ' brokers match your search.';
      wrap.innerHTML = LS.noResultsHtml('No brokers match "' + escapeHtml(query || '') + '".');
      return;
    }
    countLine.textContent = query
      ? records.length + ' of ' + allRecords.length + ' brokers match your search.'
      : records.length + ' registered ' + (records.length === 1 ? 'broker' : 'brokers') + '.';

    wrap.innerHTML = '<div class="shipper-card-grid">' + records.slice().reverse().map(r => `
      <div class="shipper-card" data-id="${escapeHtml(r.id)}">
        <div class="sc-top">
          <div class="sc-name">${escapeHtml(r.companyName || r.contactPerson || r.username || '—')}</div>
          ${brokerKycBadgeHtml(r.kycStatus)}
        </div>
        <div class="sc-username">Username: <b>${escapeHtml(r.username || '—')}</b></div>
        <div class="sc-meta-row">
          <span class="sc-chip ${r.active !== false ? 'on' : 'off'}">${r.active !== false ? 'Active' : 'Inactive'}</span>
          <span class="sc-chip">${escapeHtml((r.brokerType || '—').replace(/^./, c => c.toUpperCase()))}</span>
          ${r.hasGST ? '<span class="sc-chip">GST</span>' : ''}
          ${r.hasMSME ? '<span class="sc-chip">MSME</span>' : ''}
        </div>
      </div>
    `).join('') + '</div>';

    wrap.querySelectorAll('.shipper-card').forEach(card => {
      card.addEventListener('click', () => {
        brokerView = 'detail';
        brokerDetailId = card.getAttribute('data-id');
        brokerDetailData = null;
        renderBrokerView(allRecords, '');
      });
    });
  }

  function brokerDocRowHtml(label, path, aiReview, optional){
    if (!path) {
      return `<div class="kyc-photo-missing">${escapeHtml(label)}${optional ? ' (optional) ' : ' '}— not uploaded.</div>`;
    }
    const docUrl = withAdminToken(path);
    const isPdf = /\.pdf($|\?)/i.test(path);
    const preview = isPdf
      ? `<a href="${docUrl}" target="_blank" rel="noopener" class="doc-pdf-link">📄 View ${escapeHtml(label)} (PDF)</a>`
      : `<a href="${docUrl}" target="_blank" rel="noopener"><img src="${docUrl}" alt="${escapeHtml(label)}" onerror="this.closest('a').outerHTML='<div class=&quot;kyc-photo-missing&quot;>Photo unavailable</div>'"></a>`;
    const aiHtml = aiReview
      ? `<div style="font-size:11.5px; margin-top:6px; padding:6px 8px; border-radius:8px; background:rgba(154,223,143,0.15);">
          AI review (advisory only): ${aiReview.looksReadable ? 'Readable' : 'Unclear'} · ${aiReview.looksLikeExpectedDocument ? 'Matches expected type' : 'May not match expected type'} · Confidence ${Math.round((aiReview.confidence || 0) * 100)}%
          ${aiReview.concerns && aiReview.concerns.length ? '<br>Concerns: ' + escapeHtml(aiReview.concerns.join('; ')) : ''}
          ${aiReview.summary ? '<br>' + escapeHtml(aiReview.summary) : ''}
        </div>`
      : '';
    return `<div><div style="font-size:11.5px;color:#7a867e;margin-bottom:6px;">${escapeHtml(label)}${optional ? ' (optional)' : ''}</div><div class="kyc-photo-row">${preview}</div>${aiHtml}</div>`;
  }

  function renderBrokerDetail(wrap, r){
    if (!brokerDetailData || brokerDetailData.id !== r.id) {
      wrap.innerHTML = '<div class="empty-state">Loading broker details…</div>';
      fetch('/api/admin/brokers/' + r.id)
        .then(res => res.json())
        .then(data => {
          if (data.error) { wrap.innerHTML = '<div class="empty-state">' + escapeHtml(data.error) + '</div>'; return; }
          brokerDetailData = data;
          renderBrokerDetail(wrap, r);
        })
        .catch(() => { wrap.innerHTML = '<div class="empty-state">Could not load this broker right now.</div>'; });
      return;
    }
    const d = brokerDetailData;
    const maskedInDetail = new Set(['panNumber', 'gstNumber', 'msmeNumber', 'bankAccountNumber']);
    function fieldRow(label, key, val){
      if (val === undefined || val === '' || val === null) return '';
      if (maskedInDetail.has(key)) {
        return `<div class="drow"><span class="k">${label}</span><span class="v">
          <span class="masked-val" data-full="${escapeAttr(val)}" data-masked="${escapeAttr(maskValue(val))}" data-shown="0" style="font-family:monospace;">${escapeHtml(maskValue(val))}</span>
          <button type="button" onclick="toggleMask(this)" style="padding:2px 8px;border-radius:6px;border:1px solid var(--line);background:#f3f1e9;cursor:pointer;font-size:11px;">Show</button>
        </span></div>`;
      }
      return `<div class="drow"><span class="k">${label}</span><span class="v">${escapeHtml(val)}</span></div>`;
    }

    const contactRows = [
      fieldRow('Contact person', 'contactPerson', d.contactPerson),
      fieldRow('Company / agency', 'companyName', d.companyName),
      fieldRow('Broker type', 'brokerType', d.brokerType),
      fieldRow('Mobile', 'mobileNumber', d.mobileNumber),
      fieldRow('Email', 'email', d.email),
      fieldRow('Username', 'username', d.username),
      fieldRow('Submitted', 'submittedAt', d.submittedAt ? new Date(d.submittedAt).toLocaleString() : ''),
    ].filter(Boolean).join('');
    const addr = d.address || {};
    const addressRows = [
      fieldRow('Address line', 'addressLine', addr.addressLine),
      fieldRow('City', 'city', addr.city),
      fieldRow('State', 'state', addr.state),
      fieldRow('Pincode', 'pincode', addr.pincode),
    ].filter(Boolean).join('');
    const gstRows = [
      fieldRow('Has GST', 'hasGSTLabel', d.hasGST ? 'Yes' : 'No'),
      d.hasGST ? fieldRow('GST number', 'gstNumber', d.gstNumber) : '',
      d.hasGST ? fieldRow('GST format valid', 'gstVerified', d.gstVerified ? 'Yes' : 'No') : '',
    ].filter(Boolean).join('');
    const msmeRows = [
      fieldRow('Has MSME/Udyam', 'hasMSMELabel', d.hasMSME ? 'Yes' : 'No'),
      d.hasMSME ? fieldRow('MSME number', 'msmeNumber', d.msmeNumber) : '',
    ].filter(Boolean).join('');
    const bankRows = [
      fieldRow('Account holder', 'bankAccountHolder', d.bankAccountHolder),
      fieldRow('Account number', 'bankAccountNumber', d.bankAccountNumber),
      fieldRow('IFSC', 'bankIfsc', d.bankIfsc),
      fieldRow('Bank name', 'bankName', d.bankName),
      fieldRow('Branch', 'bankBranch', d.bankBranch),
      fieldRow('Account type', 'bankAccountType', d.bankAccountType),
    ].filter(Boolean).join('');

    const aiReviewByType = {};
    (d.aiDocumentReviews || []).forEach(rv => { aiReviewByType[rv.documentType] = rv; });

    const timeline = (d.dashboard && d.dashboard.timeline) || [];
    const timelineHtml = timeline.length
      ? timeline.slice(0, 40).map(t => `
          <div class="drow" style="margin-bottom:6px;">
            <span class="k">${escapeHtml(t.at ? new Date(t.at).toLocaleString() : '')}</span>
            <span class="v" style="font-weight:600;">${escapeHtml(t.label || '')}${t.detail ? ' — ' + escapeHtml(t.detail) : ''}</span>
          </div>`).join('')
      : '<div class="kyc-photo-missing">No activity recorded yet.</div>';

    const st = d.kycStatus || 'DRAFT';
    wrap.innerHTML = `
      <button type="button" class="back-to-list-btn" id="brokerBackBtn">← Back to all brokers</button>
      <div class="shipper-detail-head">
        <div>
          <h2>${escapeHtml(d.companyName || d.contactPerson || d.username || '—')}</h2>
          <div class="sub">Username <b>${escapeHtml(d.username || '—')}</b></div>
        </div>
        <div class="shipper-detail-actions">
          ${brokerKycBadgeHtml(st)}
          <button class="sd-btn accept" id="brokerApproveBtn" ${st === 'APPROVED' ? 'disabled' : ''}>Approve KYC</button>
          <button class="sd-btn" style="background:#f3d99a;color:#3d2a12;" id="brokerPendingBtn" ${st === 'PENDING_REVIEW' ? 'disabled' : ''}>Mark Pending Review</button>
          <button class="sd-btn reject" id="brokerRejectBtn" ${st === 'REJECTED' ? 'disabled' : ''}>Reject KYC</button>
          <button type="button" onclick="openKycDocumentsModal('${d.id}','broker')" style="padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:#f3f1e9;cursor:pointer;font-size:12.5px;">KYC Document Review</button>
        </div>
      </div>

      <div class="detail-section">
        <h3>Account status</h3>
        <div class="detail-grid">
          <div class="drow"><span class="k">Visibility</span><span class="v">
            <button class="sd-toggle ${d.active !== false ? 'on' : 'off'}" id="brokerActiveBtn">${d.active !== false ? 'Active' : 'Inactive'}</button>
          </span></div>
        </div>
        ${d.kycRejectionReason ? `<div class="rejection-note" style="margin-top:10px;">📝 Rejected: ${escapeHtml(d.kycRejectionReason)}</div>` : ''}
        ${d.kycDocumentsRequested ? `<div class="rejection-note" style="margin-top:10px;">📎 Requested documents: ${escapeHtml(d.kycDocumentsRequested)}</div>` : ''}
        <div class="accept-reject-group" style="margin-top:12px;">
          <button type="button" class="sd-btn" style="background:#0e3a24;color:#fff;" id="brokerRequestDocsBtn">Request additional documents</button>
        </div>
      </div>

      <div class="detail-section"><h3>Contact details</h3><div class="detail-grid">${contactRows}</div></div>
      <div class="detail-section"><h3>Business address</h3><div class="detail-grid">${addressRows}</div></div>
      <div class="detail-section"><h3>GST details</h3><div class="detail-grid">${gstRows}</div></div>
      <div class="detail-section"><h3>MSME / Udyam details</h3><div class="detail-grid">${msmeRows}</div></div>

      <div class="detail-section">
        <h3>Identity &amp; KYC documents</h3>
        <div class="detail-grid" style="grid-template-columns:repeat(auto-fill, minmax(240px,1fr));">
          ${brokerDocRowHtml('PAN card', d.panDocumentPath, aiReviewByType.PAN, false)}
          ${d.hasGST ? brokerDocRowHtml('GST certificate', d.gstPhotoPath, aiReviewByType.GST, false) : ''}
          ${d.hasMSME ? brokerDocRowHtml('MSME certificate', d.msmePhotoPath, aiReviewByType.MSME, false) : ''}
          ${brokerDocRowHtml('Address proof', d.addressProofPath, null, true)}
          ${brokerDocRowHtml('Profile photo', d.profilePhotoPath, null, true)}
        </div>
      </div>

      <div class="detail-section">
        <h3>Bank details &amp; bank proof</h3>
        <div class="detail-grid" style="margin-bottom:14px;">${bankRows}</div>
        ${brokerDocRowHtml('Bank proof document', d.bankProofPhotoPath, null, false)}
      </div>

      <div class="detail-section">
        <h3>Activity timeline</h3>
        ${timelineHtml}
      </div>
    `;

    document.getElementById('brokerBackBtn').addEventListener('click', () => {
      brokerView = 'list'; brokerDetailId = null; brokerDetailData = null; renderBrokerView(allRecords, '');
    });
    document.getElementById('brokerApproveBtn').addEventListener('click', () => brokerSetKycStatus(d.id, 'APPROVED'));
    document.getElementById('brokerPendingBtn').addEventListener('click', () => brokerSetKycStatus(d.id, 'PENDING_REVIEW'));
    document.getElementById('brokerRejectBtn').addEventListener('click', () => {
      openRejectModal(d.id, null, (reason) => brokerSetKycStatus(d.id, 'REJECTED', reason), {
        title: 'Reject broker KYC',
        desc: 'Select a reason. This will be shown to the broker on their dashboard.',
      });
    });
    document.getElementById('brokerActiveBtn').addEventListener('click', () => {
      fetch('/api/registrations/broker/' + d.id + '/toggle', { method: 'POST' })
        .then(res => res.json())
        .then(res => {
          d.active = res.active;
          const idx = allRecords.findIndex(x => x.id === d.id);
          if (idx !== -1) allRecords[idx].active = res.active;
          renderBrokerDetail(wrap, r);
        })
        .catch(() => alert('Could not update visibility.'));
    });
    document.getElementById('brokerRequestDocsBtn').addEventListener('click', () => {
      openRequestDocsModal(d.id);
    });
  }

  function brokerSetKycStatus(id, status, reason){
    fetch('/api/admin/brokers/' + id + '/kyc-status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not update KYC status.');
        return data;
      })
      .then(data => {
        if (brokerDetailData && brokerDetailData.id === id) {
          brokerDetailData.kycStatus = data.kycStatus;
          brokerDetailData.kycRejectionReason = status === 'REJECTED' ? reason : '';
        }
        const idx = allRecords.findIndex(x => x.id === id);
        if (idx !== -1) allRecords[idx].kycStatus = data.kycStatus;
        const wrap = document.getElementById('tableWrap');
        const rec = allRecords.find(x => x.id === id);
        if (rec) renderBrokerDetail(wrap, rec);
        if (window.LS && LS.showSuccess) LS.showSuccess('Broker KYC status updated to ' + data.kycStatus + '.');
      })
      .catch(err => alert(err.message));
  }

  function brokerRequestDocuments(id, message){
    fetch('/api/admin/brokers/' + id + '/request-documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not send that request.');
        return data;
      })
      .then(data => {
        if (brokerDetailData && brokerDetailData.id === id) {
          brokerDetailData.kycDocumentsRequested = message;
          brokerDetailData.kycStatus = data.kycStatus || brokerDetailData.kycStatus;
        }
        const wrap = document.getElementById('tableWrap');
        const rec = allRecords.find(x => x.id === id);
        if (rec) renderBrokerDetail(wrap, rec);
        if (window.LS && LS.showSuccess) LS.showSuccess('Document request sent to the broker.');
      })
      .catch(err => alert(err.message));
  }

  // ---- Request-documents modal wiring (broker only) ----
  let pendingRequestDocsId = null;
  const requestDocsModal = document.getElementById('requestDocsModal');
  const requestDocsText = document.getElementById('requestDocsText');
  const requestDocsError = document.getElementById('requestDocsError');
  function openRequestDocsModal(id){
    pendingRequestDocsId = id;
    requestDocsText.value = '';
    requestDocsError.style.display = 'none';
    requestDocsModal.style.display = 'flex';
  }
  function closeRequestDocsModal(){
    requestDocsModal.style.display = 'none';
    pendingRequestDocsId = null;
  }
  if (document.getElementById('requestDocsCancelBtn')) {
    document.getElementById('requestDocsCancelBtn').addEventListener('click', closeRequestDocsModal);
    document.getElementById('requestDocsConfirmBtn').addEventListener('click', () => {
      const msg = requestDocsText.value.trim();
      if (!msg) { requestDocsError.style.display = 'block'; return; }
      brokerRequestDocuments(pendingRequestDocsId, msg);
      closeRequestDocsModal();
    });
  }

  // ---------- KYC Document Review modal (spec: "User Registration & KYC
  // Review" Admin Portal section) ----------
  // Self-contained overlay, built dynamically (no changes to list.html
  // needed) and shared by every role — this is what closes the Carrier gap
  // (Carrier had no dedicated document-review UI at all before this; it
  // also adds per-document Approve/Reject/Request re-upload to Shipper and
  // Broker, additive alongside their existing account-level status
  // fields). Backed by GET/PATCH /api/admin/users/:userId/documents and
  // /api/admin/documents/:fileId/verify in server_load.js.
  let kycModalEl = null;
  function ensureKycDocumentsModal() {
    if (kycModalEl) return kycModalEl;
    const el = document.createElement('div');
    el.id = 'kycDocumentsModal';
    el.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(20,20,15,0.55);z-index:9999;align-items:flex-start;justify-content:center;overflow:auto;padding:32px 16px;';
    el.innerHTML = '<div style="background:#fffdf7;border-radius:14px;max-width:820px;width:100%;padding:24px;position:relative;">'
      + '<button type="button" id="kycModalCloseBtn" style="position:absolute;top:14px;right:14px;border:none;background:none;font-size:20px;cursor:pointer;">✕</button>'
      + '<div id="kycModalBody"><div class="empty-state">Loading…</div></div>'
      + '</div>';
    document.body.appendChild(el);
    el.querySelector('#kycModalCloseBtn').addEventListener('click', () => { el.style.display = 'none'; });
    el.addEventListener('click', (e) => { if (e.target === el) el.style.display = 'none'; });
    kycModalEl = el;
    return el;
  }

  function kycVerificationBadge(status) {
    const map = {
      NOT_REVIEWED: ['#f3d99a', '#3d2a12', 'Not reviewed'],
      APPROVED: ['#9adf8f', '#0e3a24', 'Approved'],
      REJECTED: ['#e57368', '#fff', 'Rejected'],
      REUPLOAD_REQUESTED: ['#f0b25e', '#3d2a12', 'Re-upload requested'],
    };
    const chosen = map[status] || map.NOT_REVIEWED;
    return '<span style="font-size:10.5px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:999px;background:' + chosen[0] + ';color:' + chosen[1] + ';">' + chosen[2] + '</span>';
  }

  function renderKycDocumentsModalBody(userId, data) {
    const u = data.user;
    const docsHtml = data.documents.length ? data.documents.map((doc) => {
      const previewUrl = withAdminToken(doc.previewUrl);
      const downloadUrl = withAdminToken(doc.downloadUrl);
      const isPdf = /pdf/i.test(doc.mimeType);
      const preview = isPdf
        ? `<a href="${previewUrl}" target="_blank" rel="noopener" class="doc-pdf-link">📄 View PDF</a>`
        : `<a href="${previewUrl}" target="_blank" rel="noopener"><img src="${previewUrl}" alt="${escapeHtml(doc.label)}" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line);" onerror="this.closest('a').outerHTML='<div class=&quot;kyc-photo-missing&quot;>Preview unavailable</div>'"></a>`;
      return `<div class="detail-section" style="display:flex;gap:14px;align-items:flex-start;">
        <div style="flex-shrink:0;">${preview}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${escapeHtml(doc.label)}</div>
          <div style="font-size:11.5px;color:#7a867e;">Uploaded ${new Date(doc.uploadedAt).toLocaleString()} · ${(doc.size / 1024).toFixed(0)} KB</div>
          <div style="margin-top:4px;">${kycVerificationBadge(doc.verificationStatus)}${doc.verificationReason ? ' <span style="font-size:11.5px;color:#7a867e;">— ' + escapeHtml(doc.verificationReason) + '</span>' : ''}</div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
            <a href="${downloadUrl}" target="_blank" rel="noopener" style="padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:#fff;font-size:11.5px;text-decoration:none;color:inherit;">Download</a>
            <button type="button" onclick="setDocVerification('${userId}','${doc.fileId}','APPROVED')" style="padding:4px 10px;border-radius:6px;border:none;cursor:pointer;background:#9adf8f;font-size:11.5px;">Approve</button>
            <button type="button" onclick="promptDocVerification('${userId}','${doc.fileId}','REJECTED')" style="padding:4px 10px;border-radius:6px;border:none;cursor:pointer;background:#e57368;color:#fff;font-size:11.5px;">Reject</button>
            <button type="button" onclick="promptDocVerification('${userId}','${doc.fileId}','REUPLOAD_REQUESTED')" style="padding:4px 10px;border-radius:6px;border:1px solid var(--line);cursor:pointer;background:#fff;font-size:11.5px;">Request re-upload</button>
          </div>
        </div>
      </div>`;
    }).join('') : '<div class="kyc-photo-missing">No documents uploaded yet.</div>';

    const missingHtml = data.missingDocumentTypes.length
      ? '<div class="detail-section"><h3>Missing Documents</h3>' + data.missingDocumentTypes.map((m) => `<div class="kyc-photo-missing">${escapeHtml(m.label)} — Document not uploaded</div>`).join('') + '</div>'
      : '';

    document.getElementById('kycModalBody').innerHTML = `
      <h2 style="margin-top:0;">${escapeHtml(u.name || '—')}</h2>
      <div class="detail-grid" style="margin-bottom:16px;">
        <div class="drow"><span class="k">Phone</span><span class="v">${escapeHtml(u.phone || '—')}</span></div>
        <div class="drow"><span class="k">Email</span><span class="v">${escapeHtml(u.email || '—')}</span></div>
        <div class="drow"><span class="k">Role</span><span class="v">${escapeHtml(u.role || '—')}</span></div>
        <div class="drow"><span class="k">Registered</span><span class="v">${u.registrationDate ? new Date(u.registrationDate).toLocaleString() : '—'}</span></div>
        <div class="drow"><span class="k">Account Status</span><span class="v">${escapeHtml(u.accountStatus || '—')}</span></div>
        <div class="drow"><span class="k">KYC Status</span><span class="v">${escapeHtml(u.kycStatus || '—')}</span></div>
      </div>
      <h3>Uploaded Documents</h3>
      ${docsHtml}
      ${missingHtml}
    `;
  }

  function loadKycDocumentsModal(userId) {
    document.getElementById('kycModalBody').innerHTML = '<div class="empty-state">Loading…</div>';
    fetch('/api/admin/users/' + encodeURIComponent(userId) + '/documents')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not load documents.');
        return d;
      })
      .then((data) => renderKycDocumentsModalBody(userId, data))
      .catch((err) => {
        document.getElementById('kycModalBody').innerHTML = '<div class="empty-state">' + escapeHtml(err.message || 'Could not load documents right now.') + '</div>';
      });
  }

  function openKycDocumentsModal(userId) {
    const el = ensureKycDocumentsModal();
    el.style.display = 'flex';
    loadKycDocumentsModal(userId);
  }

  function setDocVerification(userId, fileId, status, reason) {
    fetch('/api/admin/documents/' + encodeURIComponent(fileId) + '/verify', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason: reason || '' }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not update this document.');
        return d;
      })
      .then(() => loadKycDocumentsModal(userId))
      .catch((err) => alert(err.message || 'Could not update this document right now.'));
  }

  function promptDocVerification(userId, fileId, status) {
    const label = status === 'REJECTED' ? 'rejecting' : 'requesting a re-upload for';
    const reason = window.prompt('Reason for ' + label + ' this document (shown to the account holder):', '');
    if (reason === null) return; // cancelled
    if (!reason.trim()) { alert('Please provide a reason.'); return; }
    setDocVerification(userId, fileId, status, reason.trim());
  }
