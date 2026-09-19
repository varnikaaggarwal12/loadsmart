  const stepMobile = document.getElementById('stepMobile');
  const stepOtp = document.getElementById('stepOtp');
  const mobileInput = document.getElementById('mobileInput');
  const mobileError = document.getElementById('mobileError');
  const otpInput = document.getElementById('otpInput');
  const otpError = document.getElementById('otpError');
  const otpCountdown = document.getElementById('otpCountdown');
  const sendOtpBtn = document.getElementById('sendOtpBtn');
  const verifyOtpBtn = document.getElementById('verifyOtpBtn');

  let countdownTimer = null;
  function startCountdown(seconds) {
    clearInterval(countdownTimer);
    let left = seconds;
    otpCountdown.textContent = 'OTP expires in ' + left + 's';
    countdownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(countdownTimer); otpCountdown.textContent = 'OTP expired — tap Resend OTP.'; return; }
      otpCountdown.textContent = 'OTP expires in ' + left + 's';
    }, 1000);
  }

  async function sendOtp() {
    const mobile = mobileInput.value.replace(/\D/g, '');
    mobileError.textContent = '';
    if (!/^[0-9]{7,15}$/.test(mobile)) { mobileError.textContent = 'Enter a valid mobile number.'; return; }
    sendOtpBtn.disabled = true;
    sendOtpBtn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/driver/login/send-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send OTP.');
      document.getElementById('otpMobileDisplay').textContent = mobile;
      stepMobile.style.display = 'none';
      stepOtp.style.display = 'block';
      startCountdown(data.expiresInSeconds || 120);
      otpInput.focus();
    } catch (err) {
      mobileError.textContent = err.message;
    } finally {
      sendOtpBtn.disabled = false;
      sendOtpBtn.textContent = 'Send OTP';
    }
  }

  sendOtpBtn.addEventListener('click', sendOtp);
  document.getElementById('resendOtpBtn').addEventListener('click', sendOtp);

  verifyOtpBtn.addEventListener('click', async () => {
    const mobile = mobileInput.value.replace(/\D/g, '');
    const otp = otpInput.value.trim();
    otpError.textContent = '';
    if (!otp) { otpError.textContent = 'Enter the OTP.'; return; }
    verifyOtpBtn.disabled = true;
    verifyOtpBtn.textContent = 'Verifying…';
    try {
      const res = await fetch('/api/driver/login/verify-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, otp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid OTP.');
      sessionStorage.setItem('ls_driver_token', data.token);
      sessionStorage.setItem('ls_driver_name', data.driver.name);
      window.location.href = '/driver/dashboard';
    } catch (err) {
      otpError.textContent = err.message;
    } finally {
      verifyOtpBtn.disabled = false;
      verifyOtpBtn.textContent = 'Verify & Login';
    }
  });
