  const role = window.location.pathname.split('/').filter(Boolean).pop();

  // Shows once, right after a successful login redirected here — the login
  // page itself navigates away immediately, so there's no time to show a
  // popup there.
  (function showLoginSuccessPopupOnce() {
    let flagged = false;
    try { flagged = sessionStorage.getItem('ls_show_login_success') === '1'; } catch (e) { /* ignore */ }
    if (flagged && window.LS && LS.showSuccess) {
      LS.showSuccess('Login successful!');
      try { sessionStorage.removeItem('ls_show_login_success'); } catch (e) { /* ignore */ }
    }
  })();

  document.getElementById('logoutBtn').addEventListener('click', () => {
    if (window.LS && LS.Track) LS.Track.log('SESSION_END', 'LOGOUT', { role: role });
    LS.Auth.logoutUser(role);
  });

  // ---- Dark / Light mode toggle (persisted in localStorage) ----
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

  document.getElementById('collapseToggle').addEventListener('click', function () {
    document.getElementById('tablesWrap').classList.toggle('side-by-side');
    this.classList.toggle('active');
  });

  // Field -> display label, grouped into the three profile sections.
  // Only fields present and non-empty on the record are rendered — nothing
  // here ever surfaces internal fields (id/_id/role/active/__v) or the
  // face/Aadhaar photos, since only these named fields are ever read.
  const SECTIONS = [
    {
      title: 'Contact Details',
      fields: [
        ['id', 'Reference ID'],
        ['companyName', 'Company'],
        ['contactPerson', 'Contact Person'],
        ['phoneNumber', 'Phone'],
        ['email', 'Email'],
      ],
    },
    {
      title: 'Address Details',
      fields: [
        ['state', 'State'],
        ['district', 'District'],
        ['area', 'Area'],
        ['pincode', 'Pincode'],
        ['pickupAddress', 'Pickup Address'],
      ],
    },
    {
      title: 'Business Details',
      fields: [
        ['panNumber', 'PAN Number'],
        ['aadharNumber', 'Aadhaar Number'],
        ['gstNumber', 'GST Number'],
        ['username', 'Username'],
      ],
    },
  ];
  // Shown to the account holder only in masked form — full values are never
  // sent to this page's UI, and there is no "Show" control here (that only
  // exists in the Admin panel, gated by admin login).
  const MASKED_FIELDS = new Set(['panNumber', 'aadharNumber', 'gstNumber']);

  function maskValue(value) {
    const str = String(value);
    if (str.length <= 4) return 'x'.repeat(str.length);
    return 'x'.repeat(str.length - 4) + str.slice(-4);
  }
  // Aadhaar is masked as a fixed "****1234" (4 literal stars + last 4
  // digits) regardless of the actual number's length, per the required
  // display format — distinct from the proportional x-masking used for
  // PAN/GST above.
  function maskAadhaar(value) {
    const digits = String(value).replace(/\s/g, '');
    if (digits.length <= 4) return '****' + digits;
    return '****' + digits.slice(-4);
  }

  function redirectToLogin() {
    window.location.href = '/login/' + role;
  }

  fetch('/api/me')
    .then(res => {
      if (res.status === 401) { redirectToLogin(); return null; }
      if (!res.ok) throw new Error('not-ok');
      return res.json();
    })
    .then(record => {
      if (!record) return; // already redirecting to login
      const subLine = document.getElementById('subLine');
      const wrap = document.getElementById('tablesWrap');

      // Welcome message with the company name, shown right after login.
      const displayName = record.companyName || record.contactPerson || '';
      document.getElementById('welcomeHeading').textContent = displayName
        ? 'Welcome, ' + displayName + '!'
        : 'Welcome!';
      subLine.textContent = 'Here is the information on file for your ' + role + ' account.';

      let html = '';
      SECTIONS.forEach(section => {
        const rows = section.fields.filter(([key]) => record[key] !== undefined && record[key] !== '' && record[key] !== null);
        if (!rows.length) return;
        html += '<div class="section-block"><h3 class="section-title">' + section.title + '</h3><div class="details-card">';
        rows.forEach(([key, label]) => {
          let val = record[key];
          if (key === 'aadharNumber') val = maskAadhaar(val);
          else if (MASKED_FIELDS.has(key)) val = maskValue(val);
          html += '<div class="row"><span class="k">' + label + '</span><span class="v">' + val + '</span></div>';
        });
        html += '</div></div>';
      });
      wrap.innerHTML = html || '<div class="empty-state">No details found for your account.</div>';

      // Account review status (accepted / rejected / pending), set by admin.
      const status = record.status || 'pending';
      // Estimate & Booking / Live Tracking are only available once the
      // admin has accepted the account.
      const showShipperTools = role === 'shipper' && status === 'accepted';
      document.getElementById('estimateBtn').style.display = showShipperTools ? 'inline-flex' : 'none';
      document.getElementById('liveTrackingBtn').style.display = showShipperTools ? 'inline-flex' : 'none';
      document.getElementById('requestsBtn').style.display = showShipperTools ? 'inline-flex' : 'none';
      document.getElementById('shipperBidsBtn').style.display = showShipperTools ? 'inline-flex' : 'none';
      // My Loads is available to a carrier once their account is accepted —
      // matches when the Estimate/Live Tracking/Request links appear for
      // a shipper above.
      document.getElementById('carrierLoadsBtn').style.display = (role === 'carrier' && status === 'accepted') ? 'inline-flex' : 'none';
      document.getElementById('carrierFleetBtn').style.display = (role === 'carrier' && status === 'accepted') ? 'inline-flex' : 'none';
      document.getElementById('carrierBiddingBtn').style.display = (role === 'carrier' && status === 'accepted') ? 'inline-flex' : 'none';
      const statusLabels = { pending: 'Pending review', accepted: 'Accepted', rejected: 'Rejected' };
      const statusBadge = document.getElementById('statusBadge');
      statusBadge.textContent = statusLabels[status];
      statusBadge.className = 'badge ' + (status === 'accepted' ? 'verified' : status === 'rejected' ? 'failed' : '');
      if (status === 'pending') {
        statusBadge.style.background = 'rgba(232,114,44,0.18)';
        statusBadge.style.color = '#8a4210';
      }
      document.getElementById('statusCard').style.display = 'flex';

      const rejectionNote = document.getElementById('rejectionNote');
      if (status === 'rejected' && record.rejectionReason) {
        rejectionNote.textContent = 'Reason: ' + record.rejectionReason;
        rejectionNote.style.display = 'block';
      } else {
        rejectionNote.style.display = 'none';
      }

      // ---- Edit button (only shown when this shipper's account is Rejected) ----
      const editBtn = document.getElementById('editRejectedBtn');
      const editCard = document.getElementById('editFormCard');
      if (role === 'shipper' && status === 'rejected') {
        editBtn.style.display = 'inline-flex';
        editBtn.onclick = () => openEditForm(record, 'resubmit');
      } else {
        editBtn.style.display = 'none';
      }

      // ---- Update button (shown whenever the account is NOT Rejected —
      // hidden if Rejected, and also hidden if Admin has locked updates
      // for this shipper via the Lock/Unlock Update control). ----
      const updateBtn = document.getElementById('updateProfileBtn');
      if (role === 'shipper' && status !== 'rejected' && !record.updateLocked) {
        updateBtn.style.display = 'inline-flex';
        updateBtn.onclick = () => openEditForm(record, 'update');
      } else {
        updateBtn.style.display = 'none';
      }

      if (role === 'shipper' && record.aadharNumber) {
        const badge = document.getElementById('kycBadge');
        if (record.aadharVerified) {
          badge.textContent = 'Valid format';
          badge.className = 'badge verified';
        } else {
          badge.textContent = 'Invalid format';
          badge.className = 'badge failed';
        }
        document.getElementById('kycCard').style.display = 'flex';
      }

      // ---- Carrier: Driver documents card (Aadhaar front/back, RC, DL) ----
      // Available regardless of KYC status — a carrier can complete or
      // replace these documents at any time, not just while pending.
      if (role === 'carrier') {
        renderDriverDocs(record);
      }
    })
    .catch(() => {
      document.getElementById('subLine').textContent = 'Could not load your details.';
    });

  // Field -> display label for each of the four driver-document uploads.
  const DRIVER_DOC_FIELDS = [
    ['driverAadharFrontPhotoPath', 'Driver Aadhaar — front photo', 'driverAadharFront'],
    ['driverAadharBackPhotoPath', 'Driver Aadhaar — back photo', 'driverAadharBack'],
    ['driverRcPhotoPath', 'Driver RC (vehicle registration certificate)', 'driverRcPhoto'],
    ['driverDlPhotoPath', 'Driver DL (driving licence)', 'driverDlPhoto'],
  ];

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  // Self-view link for a document this account owns — goes through
  // /api/my-documents/:filename (no admin session required), carrying this
  // tab's own user token the same way every other fetch() on this page does.
  function selfDocUrl(storedPath) {
    // Stored doc paths are either the new permanent GridFS format
    // (/api/files/<fileId>, already an ownership-checked route) or the
    // legacy on-disk format (/admin/kyc-photo/<filename>) served back
    // through /api/my-documents/<filename>. Both need this tab's own user
    // token attached, since a plain <a href> navigation can't send an
    // Authorization header the way fetch() does.
    if (!storedPath) return '';
    let token = '';
    try { token = sessionStorage.getItem('ls_user_token') || ''; } catch (e) { /* ignore */ }
    if (/^\/api\/files\//.test(storedPath)) {
      return storedPath + (token ? '?token=' + encodeURIComponent(token) : '');
    }
    const filename = String(storedPath).split('/').pop();
    return '/api/my-documents/' + encodeURIComponent(filename) + (token ? '?token=' + encodeURIComponent(token) : '');
  }

  function renderDriverDocs(record) {
    const grid = document.getElementById('driverDocsGrid');
    grid.innerHTML = DRIVER_DOC_FIELDS.map(([key, label]) => {
      const has = !!record[key];
      return `
        <div class="field">
          <label>${label}${key.indexOf('Aadhar') !== -1 ? ' *' : ''}</label>
          <div class="driver-doc-row" data-key="${key}">
            ${has ? `<a href="${selfDocUrl(record[key])}" target="_blank" rel="noopener" class="driver-doc-view">✓ Uploaded — View</a>` : '<span class="driver-doc-missing">Not uploaded yet</span>'}
            <label class="driver-doc-upload-btn">${has ? 'Replace' : 'Upload'}
              <input type="file" class="driver-doc-input" data-key="${key}" accept="image/png,image/jpeg,application/pdf" style="display:none;">
            </label>
          </div>
          <span class="hint driver-doc-hint" data-hint-for="${key}"></span>
        </div>`;
    }).join('');

    grid.querySelectorAll('.driver-doc-input').forEach((input) => {
      const key = input.getAttribute('data-key');
      const uploadType = (DRIVER_DOC_FIELDS.find((f) => f[0] === key) || [])[2];
      input.addEventListener('change', () => uploadDriverDoc(key, uploadType, input));
    });

    document.getElementById('driverDocsCard').style.display = 'flex';
  }

  function uploadDriverDoc(fieldKey, uploadType, input) {
    const file = input.files[0];
    if (!file) return;
    const hint = document.querySelector('.driver-doc-hint[data-hint-for="' + fieldKey + '"]');
    if (hint) { hint.textContent = 'Uploading…'; hint.style.color = ''; }
    readFileAsDataUrl(file)
      .then((dataUrl) => fetch('/api/kyc/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: uploadType, imageBase64: dataUrl }),
      }))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not upload that file.');
        return data;
      })
      .then((data) => fetch('/api/carrier/update-driver-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [fieldKey]: data.path }),
      }))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save that document.');
        return data;
      })
      .then((data) => {
        if (window.LS && LS.showSuccess) LS.showSuccess('Document uploaded successfully!');
        renderDriverDocs(data.record);
      })
      .catch((err) => {
        if (hint) { hint.textContent = err.message; hint.style.color = 'var(--danger, #c0392b)'; }
        else alert(err.message);
      });
  }

  // ---- Edit form — shared by two flows: ----
  //  'resubmit' — existing behavior: only while Rejected, posts to
  //               /api/shipper/update-registration, resets status to
  //               pending. Aadhaar is never asked for here (removed
  //               entirely from the Shipper flow) — PAN is the sole
  //               identity document, same as the original registration form.
  //  'update'   — while not Rejected and not update-locked, posts to
  //               /api/shipper/update-profile, leaves status untouched.
  const RESUBMIT_FIELDS = [
    ['companyName', 'Company name', 'text'],
    ['contactPerson', 'Contact person', 'text'],
    ['phoneNumber', 'Phone number', 'text'],
    ['pincode', 'PIN code', 'text'],
    ['district', 'District', 'text'],
    ['state', 'State', 'text'],
    ['area', 'Locality / post office', 'text'],
    ['pickupAddress', 'Pickup / registration address', 'textarea'],
    ['businessDetail', 'Business detail', 'text'],
    ['gstNumber', 'GST number', 'text'],
    ['panNumber', 'PAN number', 'text'],
  ];
  // Same field list for both modes now that Aadhaar has been removed.
  const UPDATE_FIELDS = RESUBMIT_FIELDS;

  let currentEditMode = 'resubmit';

  function openEditForm(record, mode) {
    currentEditMode = mode || 'resubmit';
    const fields = currentEditMode === 'update' ? UPDATE_FIELDS : RESUBMIT_FIELDS;
    const grid = document.getElementById('editFormGrid');
    grid.innerHTML = fields.map(([key, label, type]) => {
      const value = record[key] == null ? '' : String(record[key]).replace(/"/g, '&quot;');
      return type === 'textarea'
        ? `<div class="field"><label>${label}</label><textarea id="edit_${key}">${value}</textarea></div>`
        : `<div class="field"><label>${label}</label><input type="text" id="edit_${key}" value="${value}"></div>`;
    }).join('');

    const title = document.getElementById('editFormTitle');
    const subtitle = document.getElementById('editFormSubtitle');
    const saveBtn = document.getElementById('editFormSaveBtn');
    if (currentEditMode === 'update') {
      title.textContent = 'Update your details';
      subtitle.textContent = 'Update the information below — your account status stays the same.';
      saveBtn.textContent = 'Save Changes';
    } else {
      title.textContent = 'Edit your details';
      subtitle.textContent = 'Correct the information below and resubmit — Admin will review it again.';
      saveBtn.textContent = 'Save & Resubmit for Review';
    }

    document.getElementById('editFormError').style.display = 'none';
    document.getElementById('editFormSuccess').style.display = 'none';
    document.getElementById('editFormCard').style.display = 'flex';
    document.getElementById('editFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.getElementById('editFormCancelBtn').addEventListener('click', () => {
    document.getElementById('editFormCard').style.display = 'none';
  });

  document.getElementById('editFormSaveBtn').addEventListener('click', async () => {
    const btn = document.getElementById('editFormSaveBtn');
    const errorEl = document.getElementById('editFormError');
    const successEl = document.getElementById('editFormSuccess');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    const fields = currentEditMode === 'update' ? UPDATE_FIELDS : RESUBMIT_FIELDS;
    const payload = {};
    fields.forEach(([key]) => {
      const el = document.getElementById('edit_' + key);
      if (el) payload[key] = el.value.trim();
    });

    const endpoint = currentEditMode === 'update'
      ? '/api/shipper/update-profile'
      : '/api/shipper/update-registration';
    const savingLabel = 'Saving…';
    const defaultLabel = currentEditMode === 'update' ? 'Save Changes' : 'Save & Resubmit for Review';

    btn.disabled = true;
    btn.textContent = savingLabel;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save your changes.');

      if (currentEditMode === 'update') {
        successEl.textContent = 'Your details have been updated.';
        successEl.style.display = 'block';
        if (window.LS && LS.showSuccess) LS.showSuccess('Profile updated successfully!');
      } else {
        successEl.textContent = 'Your updated details have been resubmitted for Admin review.';
        successEl.style.display = 'block';
        if (window.LS && LS.showSuccess) LS.showSuccess('Details resubmitted for review successfully!');
        document.getElementById('editRejectedBtn').style.display = 'none';
        // Refresh the on-screen status to "Pending review" without a full
        // page reload.
        const statusBadge = document.getElementById('statusBadge');
        statusBadge.textContent = 'Pending review';
        statusBadge.className = 'badge';
        statusBadge.style.background = 'rgba(232,114,44,0.18)';
        statusBadge.style.color = '#8a4210';
        document.getElementById('rejectionNote').style.display = 'none';
      }
      setTimeout(() => { document.getElementById('editFormCard').style.display = 'none'; }, 2200);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = defaultLabel;
    }
  });

// ---------- Email notification preferences (spec section 17) ----------
// Same card/endpoint for shipper, broker, and carrier — the backend
// resolves "who is this" from the bearer token, so nothing role-specific
// is needed here.
(function initNotificationPreferences() {
  const PREF_LABELS = {
    loadMatches: 'Load Matches — a truck was found for your load',
    truckMatches: 'Truck Matches — a load was found for your truck',
    assignmentUpdates: 'Assignment Updates — driver/carrier assignment confirmations',
    driverAssignment: 'Driver Assignment — new loads assigned to a driver',
    loadStatusUpdates: 'Load Status Updates — pickup, transit, delay, delivery',
    importantNotifications: 'Important Platform Notifications',
  };
  const card = document.getElementById('notifPrefsCard');
  const grid = document.getElementById('notifPrefsGrid');
  if (!card || !grid) return;

  function renderToggles(prefs) {
    grid.innerHTML = Object.keys(PREF_LABELS).map((key) => `
      <label style="display:flex; align-items:center; gap:8px; font-size:13.5px; cursor:pointer;">
        <input type="checkbox" data-pref="${key}" ${prefs[key] !== false ? 'checked' : ''}>
        ${PREF_LABELS[key]}
      </label>
    `).join('');
  }

  fetch('/api/notification-preferences')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not available'))))
    .then((data) => {
      card.style.display = 'flex';
      renderToggles(data.prefs || {});
    })
    .catch(() => { /* not logged in yet, or route not reachable — leave card hidden */ });

  document.getElementById('saveNotifPrefsBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveNotifPrefsBtn');
    const prefs = {};
    grid.querySelectorAll('input[data-pref]').forEach((el) => { prefs[el.getAttribute('data-pref')] = el.checked; });
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/notification-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save preferences.');
      if (window.LS && LS.showSuccess) LS.showSuccess('Notification preferences saved.');
    } catch (err) {
      if (window.LS && LS.showSuccess) LS.showSuccess(err.message, { error: true });
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
})();
