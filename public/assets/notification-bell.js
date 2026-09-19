/**
 * public/assets/notification-bell.js
 *
 * Shared in-app Notification Center bell (spec section 18). Works for any
 * logged-in role — admin, shipper, broker, carrier, driver — since
 * GET/PUT /api/notifications already resolve identity from whichever
 * session token is sent (see resolveNotificationIdentity in server_load.js).
 *
 * Usage: include this script, put an empty container in the header
 * (e.g. `<span id="notifBellMount"></span>`), then call:
 *   LSNotifBell.init({ tokenKey: 'ls_driver_token', mountSelector: '#notifBellMount' });
 * `tokenKey` is the sessionStorage key that already holds this page's
 * bearer token (e.g. 'ls_admin_token', 'ls_user_token', 'ls_driver_token' —
 * same keys auth.js/the driver dashboard already use).
 *
 * Self-contained: builds its own DOM, fetches with the stored token,
 * polls every 20s, and degrades silently (no bell shown) if there's no
 * token yet or the request fails — never throws into the host page.
 */
(function (global) {
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function timeAgo(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function init(opts) {
    const tokenKey = opts && opts.tokenKey;
    const mountSelector = (opts && opts.mountSelector) || '#notifBellMount';
    const mount = document.querySelector(mountSelector);
    if (!mount || !tokenKey) return;

    const token = sessionStorage.getItem(tokenKey);
    if (!token) return; // not logged in on this page — nothing to show

    mount.innerHTML = `
      <div class="ls-notif-bell">
        <button type="button" class="ls-notif-bell-btn" id="lsNotifBtn" aria-label="Notifications">
          🔔<span class="ls-notif-badge" id="lsNotifBadge" style="display:none;">0</span>
        </button>
        <div class="ls-notif-panel" id="lsNotifPanel">
          <div class="ls-notif-panel-head">
            <b>Notifications</b>
            <button type="button" class="ls-notif-mark-all" id="lsNotifMarkAll">Mark all as read</button>
          </div>
          <div id="lsNotifList"><div class="ls-notif-empty">Loading…</div></div>
        </div>
      </div>`;

    const btn = document.getElementById('lsNotifBtn');
    const panel = document.getElementById('lsNotifPanel');
    const badge = document.getElementById('lsNotifBadge');
    const list = document.getElementById('lsNotifList');
    const markAllBtn = document.getElementById('lsNotifMarkAll');

    function authFetch(url, options) {
      const headers = Object.assign({}, options && options.headers, { Authorization: 'Bearer ' + sessionStorage.getItem(tokenKey) });
      return fetch(url, Object.assign({}, options, { headers }));
    }

    function render(data) {
      const items = (data && data.notifications) || [];
      const unread = (data && data.unreadCount) || 0;
      badge.style.display = unread > 0 ? 'flex' : 'none';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      if (!items.length) {
        list.innerHTML = '<div class="ls-notif-empty">No notifications yet.</div>';
        return;
      }
      list.innerHTML = items.map((n) => `
        <div class="ls-notif-item ${n.read ? '' : 'unread'}" data-id="${escapeHtml(n.id)}">
          <div class="ti">${escapeHtml(n.title)}</div>
          <div class="tm">${escapeHtml(n.message)}</div>
          <div class="tt">${escapeHtml(n.loadId || '')} ${n.loadId ? '·' : ''} ${timeAgo(n.createdAt)}</div>
        </div>`).join('');
      list.querySelectorAll('.ls-notif-item').forEach((el) => {
        el.addEventListener('click', () => {
          if (!el.classList.contains('unread')) return;
          const id = el.getAttribute('data-id');
          authFetch('/api/notifications/' + encodeURIComponent(id) + '/read', { method: 'PUT' })
            .then(() => { el.classList.remove('unread'); refresh(); })
            .catch(() => {});
        });
      });
    }

    function refresh() {
      authFetch('/api/notifications')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => { if (data) render(data); })
        .catch(() => {});
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) refresh();
    });
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && e.target !== btn) panel.classList.remove('open');
    });
    markAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      authFetch('/api/notifications/read-all', { method: 'PUT' }).then(refresh).catch(() => {});
    });

    refresh();
    setInterval(refresh, 20000);
  }

  global.LSNotifBell = { init };
})(window);
