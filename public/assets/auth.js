/**
 * auth.js
 * Load Smart — tab-scoped session handling.
 *
 * Session tokens live in sessionStorage, NOT a cookie. sessionStorage is
 * isolated per browser tab: a brand-new tab (including one opened by
 * pasting a copied link, or opening a link in a new tab) starts with an
 * empty sessionStorage, so it has no token and must log in again — even
 * though it's the same browser and the person is still "logged in" in
 * their original tab. A cookie would have been sent automatically to
 * every tab, which is exactly the behavior this avoids.
 *
 * Include this on every protected page BEFORE any other script, as early
 * in <head> as possible:
 *   <script src="/assets/auth.js"></script>
 *
 * It does three things automatically, based on the current URL:
 *   1. If this is a protected page (/admin/... or /portal/...) and this
 *      tab has no token, redirect to the right login page immediately.
 *   2. Patches window.fetch so every request from this page automatically
 *      carries "Authorization: Bearer <token>" — no need to touch any of
 *      the existing fetch(...) calls in each page's own script.
 *   3. If any fetch gets back a 401, clears the token and redirects to
 *      login (covers a token that's expired / been logged out elsewhere).
 *
 * Exposes window.LS.Auth for login/logout pages to store or clear a token.
 */
(function () {
  const LS = window.LS || {};
  const path = window.location.pathname;

  const TOKEN_KEYS = { user: 'ls_user_token', admin: 'ls_admin_token' };

  function getToken(kind) {
    try { return sessionStorage.getItem(TOKEN_KEYS[kind]); } catch (e) { return null; }
  }
  function setToken(kind, token) {
    try { sessionStorage.setItem(TOKEN_KEYS[kind], token); } catch (e) { /* ignore */ }
  }
  function clearToken(kind) {
    try { sessionStorage.removeItem(TOKEN_KEYS[kind]); } catch (e) { /* ignore */ }
  }

  // /portal/shipper, /portal/shipper/estimate, /portal/broker, ... → 'shipper' / 'broker' / 'carrier'
  // /broker-dashboard is a special case: it's the Broker role's dedicated
  // dashboard page, served outside the generic /portal/:role tree (see
  // server_load.js), so it needs its own role mapping here too.
  function roleFromPath() {
    if (path.startsWith('/broker-dashboard')) return 'broker';
    const parts = path.split('/').filter(Boolean);
    return parts[1] || 'shipper';
  }

  function isAdminPage() {
    return path === '/admin' || (path.startsWith('/admin/') && path !== '/admin/login');
  }
  function isUserPage() {
    return path.startsWith('/portal/') || path.startsWith('/broker-dashboard');
  }

  function redirectToLogin(kind) {
    window.location.href = kind === 'admin' ? '/admin/login' : '/login/' + roleFromPath();
  }

  // Which kind of session (if any) this page is guarded by.
  let guardKind = null;
  if (isAdminPage()) guardKind = 'admin';
  else if (isUserPage()) guardKind = 'user';

  // ---- Immediate guard — runs before the rest of the page's own scripts,
  // since this file is included first. A tab with no token bounces to
  // login right away instead of ever rendering protected content. ----
  if (guardKind && !getToken(guardKind)) {
    redirectToLogin(guardKind);
  }

  // ---- Patch window.fetch: attach the Authorization header automatically
  // on every request made from a guarded page, and bounce to login on a
  // 401 response (token invalid/expired/logged out elsewhere). ----
  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = function (input, init) {
      const opts = init ? Object.assign({}, init) : {};
      const token = guardKind ? getToken(guardKind) : null;
      if (token) {
        const headers = new Headers(opts.headers || {});
        if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
        opts.headers = headers;
      }
      return originalFetch(input, opts).then((res) => {
        if (res.status === 401 && guardKind) {
          clearToken(guardKind);
          redirectToLogin(guardKind);
        }
        return res;
      });
    };
  }

  LS.Auth = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,

    // Called by the login pages right after a successful login response.
    loginUser: function (role, token) {
      setToken('user', token);
      // Broker has its own dedicated dashboard (richer than the generic
      // /portal/:role account page other roles land on).
      window.location.href = role === 'broker' ? '/broker-dashboard' : '/portal/' + role;
    },
    loginAdmin: function (token) {
      setToken('admin', token);
      window.location.href = '/admin/dashboard';
    },

    // Called by the "Log out" button — invalidates the token server-side,
    // then clears it from this tab and sends the person back to login.
    logoutUser: function (role) {
      const token = getToken('user');
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      (originalFetch || window.fetch)('/logout/' + role, { method: 'POST', headers: headers })
        .catch(() => {})
        .then(() => {
          clearToken('user');
          window.location.href = '/login/' + role;
        });
    },
    logoutAdmin: function () {
      const token = getToken('admin');
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      (originalFetch || window.fetch)('/admin/logout', { method: 'POST', headers: headers })
        .catch(() => {})
        .then(() => {
          clearToken('admin');
          window.location.href = '/admin/login';
        });
    },
  };

  window.LS = LS;
})();
