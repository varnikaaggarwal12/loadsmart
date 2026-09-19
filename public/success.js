  const params = new URLSearchParams(window.location.search);
  const type = params.get('type') || 'Account';
  const id = params.get('id');
  const username = params.get('username');
  document.getElementById('title').textContent = type + ' registered successfully!';
  if (window.LS && LS.showSuccess) {
    LS.showSuccess(type + ' registration submitted successfully!', { sub: id ? 'Reference ID: ' + id : '' });
  }
  if (id) {
    document.getElementById('ref-id').innerHTML = 'Reference ID: <b>' + id + '</b> ' + LS.copyBtnHtml(id);
  }
  if (username) {
    document.getElementById('username-line').innerHTML = 'Your login username: <b>' + username + '</b> ' + LS.copyBtnHtml(username) + ' — save this, you\'ll need it to sign in.';
  }
  const roleForLogin = String(type || '').toLowerCase();
  if (['shipper', 'broker', 'carrier'].includes(roleForLogin)) {
    const loginLink = document.getElementById('loginLink');
    loginLink.href = '/login/' + roleForLogin;
    loginLink.style.display = 'inline-block';
  }
