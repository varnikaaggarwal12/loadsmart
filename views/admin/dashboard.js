  const params = new URLSearchParams(window.location.search);
  if (params.get('added')) {
    document.getElementById('addedBanner').style.display = 'inline-block';
  }

  (function showLoginSuccessPopupOnce() {
    let flagged = false;
    try { flagged = sessionStorage.getItem('ls_show_login_success') === '1'; } catch (e) { /* ignore */ }
    if (flagged && window.LS && LS.showSuccess) {
      LS.showSuccess('Login successful!');
      try { sessionStorage.removeItem('ls_show_login_success'); } catch (e) { /* ignore */ }
    }
  })();

  document.getElementById('logoutBtn').addEventListener('click', () => {
    LS.Auth.logoutAdmin();
  });

  if (window.LSNotifBell) LSNotifBell.init({ tokenKey: 'ls_admin_token', mountSelector: '#notifBellMount' });

  // ---------- Load-lifecycle statistics (spec section 20) ----------
  const STAT_CARDS = [
    { key: 'totalLoads', label: 'Total Loads', color: '#0e3a24' },
    { key: 'pendingApproval', label: 'Pending Approval', color: '#e8722c' },
    { key: 'approved', label: 'Approved', color: '#2c5c8a' },
    { key: 'driverAssigned', label: 'Driver Assigned', color: '#7a5fc9' },
    { key: 'inTransit', label: 'In Transit', color: '#1c8a6e' },
    { key: 'delayed', label: 'Delayed', color: '#c0392b' },
    { key: 'delivered', label: 'Delivered', color: '#12492e' },
    { key: 'podPending', label: 'POD Pending', color: '#a3781f' },
    { key: 'completed', label: 'Completed', color: '#0e3a24' },
  ];
  function escapeHtml(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function loadStats() {
    // auth.js already patches window.fetch to attach this page's admin
    // bearer token to every request — no manual header needed here, same
    // as every other fetch() call on this page.
    fetch('/api/admin/dashboard/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((stats) => {
        if (!stats) return;
        const grid = document.getElementById('loadStatsGrid');
        if (!grid) return;
        grid.innerHTML = STAT_CARDS.map((c) => `
          <div style="background:#fff; border-radius:14px; padding:14px 16px; box-shadow:0 10px 26px -18px rgba(0,0,0,0.18); border-left:4px solid ${c.color};">
            <div style="font-size:22px; font-weight:800; font-family:'Baloo 2', sans-serif; color:${c.color};">${stats[c.key] != null ? stats[c.key] : '—'}</div>
            <div style="font-size:12px; color:#5c6a61; margin-top:2px;">${c.label}</div>
          </div>`).join('');
      })
      .catch(() => {});

    fetch('/api/admin/activity?limit=12')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        const list = document.getElementById('recentActivityList');
        if (!list) return;
        if (!rows || !rows.length) { list.innerHTML = '<div style="padding:14px 0; color:#9aa39d; font-size:13px;">No activity yet.</div>'; return; }
        list.innerHTML = rows.map((r) => `
          <div style="padding:10px 0; border-bottom:1px solid rgba(23,37,29,0.08); font-size:13px;">
            <b>${new Date(r.createdAt).toLocaleTimeString()}</b> — ${escapeHtml((r.action || '').replace(/_/g, ' '))}
            ${r.loadId ? ` · <span style="color:#5c6a61;">${escapeHtml(r.loadId)}</span>` : ''}
          </div>`).join('');
      })
      .catch(() => {});
  }
  loadStats();
  setInterval(loadStats, 20000);
