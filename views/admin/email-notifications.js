(function () {
  const KNOWN_EVENTS = [
    'LOAD_POSTED', 'LOAD_POSTED_ADMIN_ALERT', 'LOAD_APPROVED', 'LOAD_REJECTED',
    'DRIVER_ASSIGNED', 'DRIVER_ASSIGNED_SHIPPER', 'DRIVER_ACCEPTED', 'DRIVER_REJECTED',
    'TRIP_STARTED', 'PICKUP_REACHED', 'DEPARTED_PICKUP', 'CHECKPOINT_UPDATE', 'DELAY_REPORTED',
    'DESTINATION_REACHED', 'UNLOADING_STARTED', 'UNLOADING_COMPLETED', 'DELIVERY_COMPLETED',
    'POD_UPLOADED', 'POD_APPROVED', 'POD_REJECTED',
    'LOAD_COMPLETED_SHIPPER', 'LOAD_COMPLETED_DRIVER',
    'LOAD_CREATED_CARRIER_ALERT', 'TRUCK_CREATED_SHIPPER_ALERT',
    'LOAD_TRUCK_MATCHED_SHIPPER', 'LOAD_TRUCK_MATCHED_CARRIER',
    'ASSIGNMENT_CONFIRMED_CARRIER',
  ];

  const eventSelect = document.getElementById('filterEvent');
  KNOWN_EVENTS.forEach((e) => {
    const opt = document.createElement('option');
    opt.value = e; opt.textContent = e;
    eventSelect.appendChild(opt);
  });

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString();
  }

  function buildQuery() {
    const params = new URLSearchParams();
    const status = document.getElementById('filterStatus').value;
    const eventType = document.getElementById('filterEvent').value;
    const email = document.getElementById('filterEmail').value.trim();
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;
    if (status) params.set('status', status);
    if (eventType) params.set('eventType', eventType);
    if (email) params.set('email', email);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }

  function renderSummary(summary) {
    const wrap = document.getElementById('summaryChips');
    const order = ['SENT', 'FAILED', 'PENDING', 'PROCESSING', 'RETRYING'];
    wrap.innerHTML = order.map((s) => `<div class="summary-chip"><span>${s}</span><b>${(summary && summary[s]) || 0}</b></div>`).join('');
  }

  function renderRows(rows) {
    const tbody = document.getElementById('logTableBody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-row">No emails match these filters.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.email || r.recipient || '—'}</td>
        <td>${r.eventType || r.event || '—'}</td>
        <td>${r.entityType || 'Load'} ${r.entityId || r.loadId || ''}</td>
        <td class="subject-cell">${r.subject || '—'}</td>
        <td><span class="status-pill status-${r.status}">${r.status}</span></td>
        <td>${fmtDate(r.sentAt || r.createdAt)}</td>
        <td class="reason-cell">${r.errorMessage || r.error || ''}</td>
        <td>${r.status === 'FAILED' ? `<button class="btn-retry" data-id="${r._id}">Retry</button>` : ''}</td>
      </tr>
    `).join('');
    tbody.querySelectorAll('.btn-retry').forEach((btn) => {
      btn.addEventListener('click', () => retryOne(btn));
    });
  }

  async function retryOne(btn) {
    const id = btn.getAttribute('data-id');
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    try {
      const res = await fetch(`/api/admin/email-logs/${id}/retry`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Retry failed.');
      if (window.LS && LS.showSuccess) LS.showSuccess('Email re-queued for delivery.');
      load();
    } catch (err) {
      if (window.LS && LS.showSuccess) LS.showSuccess(err.message, { error: true });
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  async function load() {
    document.getElementById('logTableBody').innerHTML = '<tr><td colspan="8" class="empty-row">Loading…</td></tr>';
    try {
      const res = await fetch('/api/admin/email-logs?' + buildQuery());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the email log.');
      renderSummary(data.summary);
      renderRows(data.rows || []);
    } catch (err) {
      document.getElementById('logTableBody').innerHTML = `<tr><td colspan="8" class="empty-row">${err.message}</td></tr>`;
    }
  }

  document.getElementById('applyFiltersBtn').addEventListener('click', load);
  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    document.getElementById('filterStatus').value = '';
    document.getElementById('filterEvent').value = '';
    document.getElementById('filterEmail').value = '';
    document.getElementById('filterFrom').value = '';
    document.getElementById('filterTo').value = '';
    load();
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    LS.Auth.logoutAdmin();
  });

  if (window.LSNotifBell) LSNotifBell.init({ tokenKey: 'ls_admin_token', mountSelector: '#notifBellMount' });

  load();
})();
