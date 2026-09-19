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

  // ---- Client-side field validation (red inline messages) ----
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const usernameError = document.getElementById('usernameError');
  const passwordError = document.getElementById('passwordError');

  function setFieldError(input, errorEl, message) {
    if (message) {
      input.classList.add('invalid');
      errorEl.textContent = message;
      errorEl.classList.add('show');
    } else {
      input.classList.remove('invalid');
      errorEl.classList.remove('show');
    }
  }

  function validateUsername() {
    const ok = usernameInput.value.trim().length > 0;
    setFieldError(usernameInput, usernameError, ok ? '' : 'Please enter your username.');
    return ok;
  }
  function validatePassword() {
    const ok = passwordInput.value.length > 0;
    setFieldError(passwordInput, passwordError, ok ? '' : 'Please enter your password.');
    return ok;
  }

  usernameInput.addEventListener('blur', validateUsername);
  passwordInput.addEventListener('blur', validatePassword);
  usernameInput.addEventListener('input', () => { if (usernameInput.classList.contains('invalid')) validateUsername(); });
  passwordInput.addEventListener('input', () => { if (passwordInput.classList.contains('invalid')) validatePassword(); });

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameOk = validateUsername();
    const passwordOk = validatePassword();
    if (!usernameOk || !passwordOk) {
      (usernameOk ? passwordInput : usernameInput).focus();
      return;
    }
    const errorBanner = document.getElementById('errorBanner');
    errorBanner.style.display = 'none';
    const submitBtn = document.querySelector('#loginForm .submit-btn');
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    try {
      const res = await fetch(document.getElementById('loginForm').action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput.value.trim(), password: passwordInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      if (window.LS && LS.Track) LS.Track.log('LOGIN_SUCCESS', 'LOGIN_SUCCESS', { role: data.role });
      // The success popup is shown on the portal page right after arrival
      // (see details.js) — this page navigates away immediately, so a
      // popup shown here would have no time to actually be seen.
      try { sessionStorage.setItem('ls_show_login_success', '1'); } catch (e) { /* ignore */ }
      // Store the token in THIS tab's sessionStorage and go to the portal —
      // a new tab won't have this token and will need to log in again.
      LS.Auth.loginUser(data.role, data.token);
    } catch (err) {
      if (window.LS && LS.Track) LS.Track.log('LOGIN_FAILURE', 'LOGIN_FAILURE', { role: role });
      errorBanner.textContent = err.message;
      errorBanner.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  // ---- Forgot Password (Shipper only) ----
  const role = window.location.pathname.split('/').filter(Boolean).pop();
  if (role === 'shipper') {
    document.getElementById('forgotPasswordRow').style.display = 'block';
  }

  const fpModalOverlay = document.getElementById('fpModalOverlay');
  const fpStepEmail = document.getElementById('fpStepEmail');
  const fpStepOtp = document.getElementById('fpStepOtp');
  const fpStepReset = document.getElementById('fpStepReset');
  const fpStepDone = document.getElementById('fpStepDone');

  const fpEmailInput = document.getElementById('fpEmailInput');
  const fpEmailError = document.getElementById('fpEmailError');
  const fpSendOtpBtn = document.getElementById('fpSendOtpBtn');

  const fpOtpEmailDisplay = document.getElementById('fpOtpEmailDisplay');
  const fpOtpInput = document.getElementById('fpOtpInput');
  const fpOtpError = document.getElementById('fpOtpError');
  const fpVerifyOtpBtn = document.getElementById('fpVerifyOtpBtn');
  const fpResendOtpBtn = document.getElementById('fpResendOtpBtn');
  const fpCountdown = document.getElementById('fpCountdown');
  const fpResendNote = document.getElementById('fpResendNote');

  const fpNewPassword = document.getElementById('fpNewPassword');
  const fpConfirmPassword = document.getElementById('fpConfirmPassword');
  const fpResetError = document.getElementById('fpResetError');
  const fpResetBtn = document.getElementById('fpResetBtn');
  const fpUsernameDisplay = document.getElementById('fpUsernameDisplay');
  const fpDoneUsername = document.getElementById('fpDoneUsername');

  let fpVerifyToken = '';
  let fpCountdownTimer = null;
  let fpResendCooldownTimer = null;
  let fpSecondsLeft = 0;

  function fpFormatMMSS(total) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function fpStopCountdown() { clearInterval(fpCountdownTimer); fpCountdownTimer = null; }
  function fpStartCountdown(seconds) {
    fpStopCountdown();
    fpSecondsLeft = seconds;
    fpCountdown.textContent = 'OTP expires in: ' + fpFormatMMSS(fpSecondsLeft);
    fpCountdown.classList.remove('expiring');
    fpVerifyOtpBtn.disabled = false;
    fpCountdownTimer = setInterval(() => {
      fpSecondsLeft -= 1;
      if (fpSecondsLeft <= 0) {
        fpCountdown.textContent = 'OTP expired. Please click Resend OTP.';
        fpCountdown.classList.add('expiring');
        fpVerifyOtpBtn.disabled = true;
        fpStopCountdown();
        return;
      }
      fpCountdown.textContent = 'OTP expires in: ' + fpFormatMMSS(fpSecondsLeft);
      if (fpSecondsLeft <= 30) fpCountdown.classList.add('expiring');
    }, 1000);
  }
  function fpStartResendCooldown(seconds) {
    clearInterval(fpResendCooldownTimer);
    let left = seconds;
    fpResendOtpBtn.disabled = true;
    fpResendNote.textContent = 'You can resend in ' + left + 's.';
    fpResendCooldownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(fpResendCooldownTimer);
        fpResendOtpBtn.disabled = false;
        fpResendNote.textContent = '';
        return;
      }
      fpResendNote.textContent = 'You can resend in ' + left + 's.';
    }, 1000);
  }

  function fpShowStep(step) {
    [fpStepEmail, fpStepOtp, fpStepReset, fpStepDone].forEach((el) => { el.style.display = 'none'; });
    step.style.display = 'block';
  }

  function fpOpenModal() {
    fpEmailInput.value = '';
    fpEmailError.classList.remove('show');
    fpShowStep(fpStepEmail);
    fpModalOverlay.classList.add('show');
    fpEmailInput.focus();
  }
  function fpCloseModal() {
    fpModalOverlay.classList.remove('show');
    fpStopCountdown();
    clearInterval(fpResendCooldownTimer);
  }

  document.getElementById('forgotPasswordLink').addEventListener('click', (e) => {
    e.preventDefault();
    fpOpenModal();
  });
  document.getElementById('fpModalCloseBtn').addEventListener('click', fpCloseModal);
  fpModalOverlay.addEventListener('click', (e) => { if (e.target === fpModalOverlay) fpCloseModal(); });

  async function fpSendOtp({ isResend } = {}) {
    const email = fpEmailInput.value.trim();
    try {
      const res = await fetch('/api/shipper/forgot-password/send-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send the OTP.');
      fpStartCountdown(data.expiresInSeconds || 120);
      fpStartResendCooldown(30);
      if (isResend) {
        fpOtpInput.value = '';
        fpOtpInput.focus();
        fpResendNote.textContent = 'New OTP sent successfully.';
        fpOtpError.classList.remove('show');
        setTimeout(() => { if (fpResendNote.textContent === 'New OTP sent successfully.') fpResendNote.textContent = ''; }, 4000);
      }
      return true;
    } catch (err) {
      if (isResend) {
        fpOtpError.textContent = err.message || 'Unable to resend OTP. Please try again.';
        fpOtpError.classList.add('show');
      } else {
        fpEmailError.textContent = err.message;
        fpEmailError.classList.add('show');
      }
      return false;
    }
  }

  fpSendOtpBtn.addEventListener('click', async () => {
    const email = fpEmailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fpEmailError.textContent = 'Enter a valid email address.';
      fpEmailError.classList.add('show');
      return;
    }
    fpEmailError.classList.remove('show');
    fpSendOtpBtn.disabled = true;
    fpSendOtpBtn.textContent = 'Sending…';
    const sent = await fpSendOtp({ isResend: false });
    fpSendOtpBtn.disabled = false;
    fpSendOtpBtn.textContent = 'Send OTP';
    if (sent) {
      fpOtpEmailDisplay.textContent = email;
      fpOtpInput.value = '';
      fpOtpError.classList.remove('show');
      fpShowStep(fpStepOtp);
      fpOtpInput.focus();
    }
  });

  fpResendOtpBtn.addEventListener('click', () => fpSendOtp({ isResend: true }));

  fpVerifyOtpBtn.addEventListener('click', async () => {
    const otp = fpOtpInput.value.trim();
    if (!otp) {
      fpOtpError.textContent = 'Please enter the OTP.';
      fpOtpError.classList.add('show');
      return;
    }
    fpVerifyOtpBtn.disabled = true;
    fpVerifyOtpBtn.textContent = 'Verifying…';
    try {
      const res = await fetch('/api/email-otp/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fpEmailInput.value.trim(), otp }),
      });
      const data = await res.json();
      if (!res.ok || !data.verified) throw new Error(data.error || 'Invalid OTP. Please try again.');
      fpVerifyToken = data.verifyToken;
      fpStopCountdown();
      clearInterval(fpResendCooldownTimer);
      fpNewPassword.value = '';
      fpConfirmPassword.value = '';
      fpResetError.classList.remove('show');
      fpUsernameDisplay.textContent = '';
      fpShowStep(fpStepReset);
    } catch (err) {
      fpOtpError.textContent = err.message;
      fpOtpError.classList.add('show');
    } finally {
      fpVerifyOtpBtn.disabled = false;
      fpVerifyOtpBtn.textContent = 'Verify OTP';
    }
  });

  fpResetBtn.addEventListener('click', async () => {
    const newPassword = fpNewPassword.value;
    const confirmNewPassword = fpConfirmPassword.value;
    fpResetError.classList.remove('show');
    if (newPassword !== confirmNewPassword) {
      fpResetError.textContent = 'Passwords do not match.';
      fpResetError.classList.add('show');
      return;
    }
    fpResetBtn.disabled = true;
    fpResetBtn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/shipper/forgot-password/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fpEmailInput.value.trim(), verifyToken: fpVerifyToken, newPassword, confirmNewPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not reset your password.');
      fpDoneUsername.textContent = data.username || '—';
      fpShowStep(fpStepDone);
    } catch (err) {
      fpResetError.textContent = err.message;
      fpResetError.classList.add('show');
    } finally {
      fpResetBtn.disabled = false;
      fpResetBtn.textContent = 'Reset Password';
    }
  });

  document.getElementById('fpDoneBtn').addEventListener('click', () => {
    fpCloseModal();
    if (usernameInput) usernameInput.focus();
  });
