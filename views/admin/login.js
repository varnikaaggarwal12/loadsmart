  const errorBanner = document.getElementById('errorBanner');
  const loginForm = document.getElementById('adminLoginForm');
  const adminIdInput = document.getElementById('adminId');
  const passwordInput = document.getElementById('password');
  const submitBtn = loginForm.querySelector('.submit-btn');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBanner.style.display = 'none';
    if (!adminIdInput.value.trim() || !passwordInput.value) {
      errorBanner.textContent = 'Please enter both admin ID and password.';
      errorBanner.style.display = 'block';
      return;
    }
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    try {
      const res = await fetch(loginForm.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: adminIdInput.value.trim(), password: passwordInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      // The success popup is shown on the dashboard right after arrival
      // (this page navigates away immediately, so there's no time to show
      // it here).
      try { sessionStorage.setItem('ls_show_login_success', '1'); } catch (e) { /* ignore */ }
      // Store the token in THIS tab's sessionStorage — a new tab won't
      // have it and will need to log in again.
      LS.Auth.loginAdmin(data.token);
    } catch (err) {
      errorBanner.textContent = err.message;
      errorBanner.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
