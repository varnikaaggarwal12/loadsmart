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

  function registrationErrorMessage(err) {
    const messages = {
      invalid_gst: 'That GST number is not valid (format/checksum check failed).',
      invalid_msme: 'Please enter a valid MSME / Udyam registration number.',
      business_doc_type_required: 'Please choose GST or MSME and provide its details.',
      gst_doc_required: 'Please upload your GST certificate/document.',
      msme_doc_required: 'Please upload your MSME/Udyam certificate/document.',
      loading_slip_required: 'Please upload your loading slip.',
      invalid_password: 'Password must be 1-10 characters and include an uppercase letter and an @ symbol.',
      email_not_verified: 'Please verify your email address with the OTP before submitting.',
      email_registered: 'An account already exists with this email address. Please log in instead.',
      invalid_username: 'Please choose a username that\'s 3-20 characters, starts with a letter, and contains only letters, numbers, or underscores.',
      username_taken: 'That username is already taken — please choose another.',
      invalid_driver_aadhaar: 'Please enter a valid 12-digit Aadhaar number for the driver.',
      driver_aadhaar_doc_required: 'Please upload both the front and back photo of the driver\'s Aadhaar card.',
      bank_account_holder_required: 'Please enter the bank account holder name.',
      invalid_bank_account_number: 'Please enter a valid bank account number (9-18 digits).',
      invalid_ifsc: 'That IFSC code is not in a valid format.',
      bank_name_required: 'Please enter your bank name.',
      bank_account_type_required: 'Please select an account type (Savings or Current).',
      bank_proof_required: 'Please upload your bank proof document (cancelled cheque or passbook photo).',
      server_error: 'Something went wrong on our end — please try again in a moment.',
      missing: 'Please fill in all required fields.',
    };
    return messages[err] || 'Something didn\'t validate — please check your details and try again.';
  }

  (function showServerError() {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (!err) return;
    const banner = document.getElementById('serverErrorBanner');
    banner.textContent = registrationErrorMessage(err);
    banner.style.display = 'block';
  })();

  const passwordInput = document.getElementById('password');
  passwordInput.addEventListener('input', () => {
    const v = passwordInput.value;
    const ok = v.length >= 1 && v.length <= 10 && /[A-Z]/.test(v) && v.includes('@');
    passwordInput.setCustomValidity(ok ? '' : 'Password must be 1-10 characters and include an uppercase letter and an @ symbol.');
  });

  // ---- Username format check (letters/digits/underscore, starts with a
  // letter, 3-20 chars) — mirrors isValidUsername() on the server exactly. ----
  const usernameInput = document.getElementById('username');
  const usernameHint = document.getElementById('usernameHint');
  function isValidUsername(v) { return /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(v); }
  usernameInput.addEventListener('blur', () => {
    if (!usernameInput.value) return;
    const ok = isValidUsername(usernameInput.value.trim());
    usernameHint.textContent = ok
      ? 'Looks good.'
      : '3–20 characters, letters/numbers/underscore, must start with a letter.';
    usernameHint.style.color = ok ? 'var(--green-deep, #0e3a24)' : 'var(--danger, #c0392b)';
    usernameInput.setCustomValidity(ok ? '' : 'Choose a valid username.');
  });

  // ---- IFSC format check ----
  const ifscInput = document.getElementById('bankIfsc');
  const ifscHint = document.getElementById('bankIfscHint');
  ifscInput.addEventListener('input', () => { ifscInput.value = ifscInput.value.toUpperCase(); });
  ifscInput.addEventListener('blur', () => {
    if (!ifscInput.value) return;
    const ok = /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscInput.value);
    ifscHint.textContent = ok ? 'Valid IFSC format.' : 'Format should be like HDFC0001234.';
    ifscHint.style.color = ok ? 'var(--green-deep, #0e3a24)' : 'var(--danger, #c0392b)';
    ifscInput.setCustomValidity(ok ? '' : 'Enter a valid IFSC code.');
  });

  // ---- GST format check ----
  // Normalizes (trim + uppercase) before checking, and also writes that
  // normalized value back into the field on blur — so what's shown, what's
  // validated, and what ultimately gets submitted are always the exact
  // same string. Mirrors isValidGST() on the server exactly.
  const gstInput = document.getElementById('gstNumber');
  const gstHint = document.getElementById('gstHint');
  function isValidGST(v) {
    const GST_CODES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    v = String(v || '').trim().toUpperCase();
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return false;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      const code = GST_CODES.indexOf(v[i]);
      const factor = (i % 2 === 0) ? 1 : 2;
      const val = code * factor;
      sum += Math.floor(val / 36) + (val % 36);
    }
    const checkDigit = GST_CODES[(36 - (sum % 36)) % 36];
    return checkDigit === v[14];
  }
  gstInput.addEventListener('input', () => { gstInput.value = gstInput.value.toUpperCase(); });
  gstInput.addEventListener('blur', () => {
    gstInput.value = gstInput.value.trim();
    if (!gstInput.value) return;
    const ok = isValidGST(gstInput.value);
    gstHint.textContent = ok ? 'Valid GSTIN.' : 'Not a valid GSTIN (check format/checksum).';
    gstHint.style.color = ok ? 'var(--green-deep, #0e3a24)' : 'var(--danger, #c0392b)';
    gstInput.setCustomValidity(ok ? '' : 'Enter a valid GSTIN.');
  });

  // ---- GST vs MSME — either/or, at least one required ----
  // Mirrors isValidMsme() on the server: a lenient presence/length check
  // rather than a strict pattern, since MSME/Udyam number formats vary.
  function isValidMsme(v) { return String(v || '').trim().length >= 8; }
  const msmeInput = document.getElementById('msmeNumber');
  const msmeError = document.getElementById('msmeNumberError');
  const gstNumberError = document.getElementById('gstNumberError');
  const businessDocInput = document.getElementById('businessDocInput');
  const businessDocHint = document.getElementById('businessDocHint');
  const businessDocUploadLabel = document.getElementById('businessDocUploadLabel');
  const gstPhotoPathInput = document.getElementById('gstPhotoPath');
  const msmePhotoPathInput = document.getElementById('msmePhotoPath');

  function currentBusinessDocType() {
    return document.getElementById('docTypeMsme').checked ? 'msme' : 'gst';
  }
  function applyBusinessDocTypeVisibility() {
    const type = currentBusinessDocType();
    const isGst = type === 'gst';
    document.getElementById('gstFieldRow').style.display = isGst ? '' : 'none';
    document.getElementById('msmeFieldRow').style.display = isGst ? 'none' : '';
    document.getElementById('gstReqMark').style.display = isGst ? '' : 'none';
    document.getElementById('msmeReqMark').style.display = isGst ? 'none' : '';
    businessDocUploadLabel.textContent = '';
    businessDocUploadLabel.appendChild(document.createTextNode(isGst ? 'GST Certificate ' : 'MSME / Udyam Certificate '));
    const req = document.createElement('span');
    req.className = 'req';
    req.textContent = '*';
    businessDocUploadLabel.appendChild(req);
    // Switching type clears whichever field/document is no longer the
    // active choice, so a value typed before switching doesn't get
    // silently submitted anyway (server enforces the same either/or too).
    if (isGst) {
      msmeInput.value = '';
      msmeError.classList.remove('show');
      msmePhotoPathInput.value = '';
    } else {
      gstInput.value = '';
      gstNumberError.classList.remove('show');
      gstPhotoPathInput.value = '';
    }
    businessDocInput.value = '';
    businessDocHint.textContent = 'Accepted: JPG, PNG, or PDF — max 8MB.';
    businessDocHint.style.color = '';
  }
  document.getElementById('docTypeGst').addEventListener('change', applyBusinessDocTypeVisibility);
  document.getElementById('docTypeMsme').addEventListener('change', applyBusinessDocTypeVisibility);
  applyBusinessDocTypeVisibility(); // set correct initial state on page load

  businessDocInput.addEventListener('change', async () => {
    const file = businessDocInput.files[0];
    if (!file) return;
    gstPhotoPathInput.value = '';
    msmePhotoPathInput.value = '';
    businessDocHint.textContent = 'Uploading…';
    businessDocHint.style.color = '';
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const type = currentBusinessDocType() === 'gst' ? 'gstPhoto' : 'msmePhoto';
      const res = await fetch('/api/kyc/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, imageBase64: dataUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not upload that file.');
      if (type === 'msmePhoto') msmePhotoPathInput.value = data.path;
      else gstPhotoPathInput.value = data.path;
      businessDocHint.textContent = '✓ ' + file.name + ' uploaded.';
      businessDocHint.style.color = 'var(--green-deep, #0e3a24)';
    } catch (err) {
      businessDocHint.textContent = err.message;
      businessDocHint.style.color = 'var(--danger, #c0392b)';
      businessDocInput.value = '';
    }
  });

  // ---- Bank proof (cancelled cheque / passbook) upload ----
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }
  const bankProofInput = document.getElementById('bankProofInput');
  const bankProofHint = document.getElementById('bankProofHint');
  const bankProofPathInput = document.getElementById('bankProofPhotoPath');
  bankProofInput.addEventListener('change', async () => {
    const file = bankProofInput.files[0];
    if (!file) return;
    bankProofPathInput.value = '';
    bankProofHint.textContent = 'Uploading…';
    bankProofHint.style.color = '';
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await fetch('/api/kyc/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bankProof', imageBase64: dataUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not upload that file.');
      bankProofPathInput.value = data.path;
      bankProofHint.textContent = '✓ ' + file.name + ' uploaded.';
      bankProofHint.style.color = 'var(--green-deep, #0e3a24)';
    } catch (err) {
      bankProofHint.textContent = err.message;
      bankProofHint.style.color = 'var(--danger, #c0392b)';
      bankProofInput.value = '';
    }
  });

  // ---- Generic document upload helper — same pattern as the Bank Proof
  // upload above, reused for Driver Aadhaar front/back, RC photo, and DL
  // photo so each one isn't hand-wired separately. ----
  function wireDocUpload({ fileInputId, hintId, hiddenInputId, type }) {
    const fileInput = document.getElementById(fileInputId);
    const hint = document.getElementById(hintId);
    const hiddenInput = document.getElementById(hiddenInputId);
    if (!fileInput) return;
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      hiddenInput.value = '';
      hint.textContent = 'Uploading…';
      hint.style.color = '';
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const res = await fetch('/api/kyc/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, imageBase64: dataUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not upload that file.');
        hiddenInput.value = data.path;
        hint.textContent = '✓ ' + file.name + ' uploaded.';
        hint.style.color = 'var(--green-deep, #0e3a24)';
      } catch (err) {
        hint.textContent = err.message;
        hint.style.color = 'var(--danger, #c0392b)';
        fileInput.value = '';
      }
    });
  }
  const driverAadharFrontPathInput = document.getElementById('driverAadharFrontPhotoPath');
  const driverAadharBackPathInput = document.getElementById('driverAadharBackPhotoPath');
  wireDocUpload({ fileInputId: 'driverAadharFrontInput', hintId: 'driverAadharFrontHint', hiddenInputId: 'driverAadharFrontPhotoPath', type: 'driverAadharFront' });
  wireDocUpload({ fileInputId: 'driverAadharBackInput', hintId: 'driverAadharBackHint', hiddenInputId: 'driverAadharBackPhotoPath', type: 'driverAadharBack' });
  wireDocUpload({ fileInputId: 'driverRcInput', hintId: 'driverRcHint', hiddenInputId: 'driverRcPhotoPath', type: 'driverRcPhoto' });
  wireDocUpload({ fileInputId: 'driverDlInput', hintId: 'driverDlHint', hiddenInputId: 'driverDlPhotoPath', type: 'driverDlPhoto' });
  const loadingSlipPathInput = document.getElementById('loadingSlipPath');
  wireDocUpload({ fileInputId: 'loadingSlipInput', hintId: 'loadingSlipHint', hiddenInputId: 'loadingSlipPath', type: 'loadingSlip' });

  // ---- Driver Aadhaar format check (basic 12-digit check, client-side) ----
  const driverAadharInput = document.getElementById('driverAadharNumber');
  const driverAadharHint = document.getElementById('driverAadharHint');
  if (driverAadharInput) {
    driverAadharInput.addEventListener('input', () => {
      const digits = driverAadharInput.value.replace(/\D/g, '').slice(0, 12);
      driverAadharInput.value = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
    });
    driverAadharInput.addEventListener('blur', () => {
      if (!driverAadharInput.value) return;
      const ok = /^[0-9]{12}$/.test(driverAadharInput.value.replace(/\s/g, ''));
      driverAadharHint.textContent = ok
        ? 'Valid Aadhaar number format.'
        : 'Required for the driver specifically — the driver is an individual, unlike the company/business account itself.';
      driverAadharHint.style.color = ok ? 'var(--green-deep, #0e3a24)' : 'var(--danger, #c0392b)';
      driverAadharInput.setCustomValidity(ok ? '' : 'Enter a valid 12-digit Aadhaar number for the driver.');
    });
  }

  // ---- Email OTP verification modal ----
  // Opens automatically when "Create carrier account" is clicked (after all
  // other field validation passes) — there is no separate "Send OTP"
  // button. Registration is only completed once the OTP is verified inside
  // the modal (same pattern, and the same generic /api/email-otp/* backend,
  // as the Shipper registration flow).
  const termsCheckboxInput = document.getElementById('termsCheckbox');
  const emailInput = document.getElementById('email');
  const emailVerifyToken = document.getElementById('emailVerifyToken');
  const emailHint = document.getElementById('emailHint');
  const emailError = document.getElementById('emailError');

  const otpModalOverlay = document.getElementById('otpModalOverlay');
  const otpStepVerify = document.getElementById('otpStepVerify');
  const otpStepSuccess = document.getElementById('otpStepSuccess');
  const otpEmailDisplay = document.getElementById('otpEmailDisplay');
  const otpCodeInput = document.getElementById('otpCodeInput');
  const otpError = document.getElementById('otpError');
  const otpVerifyBtn = document.getElementById('otpVerifyBtn');
  const otpResendBtn = document.getElementById('otpResendBtn');
  const otpCountdown = document.getElementById('otpCountdown');
  const otpResendNote = document.getElementById('otpResendNote');
  const otpModalCloseBtn = document.getElementById('otpModalCloseBtn');
  const otpContinueBtn = document.getElementById('otpContinueBtn');
  const createAccountBtn = document.getElementById('createAccountBtn');

  let otpCountdownTimer = null;
  let otpResendCooldownTimer = null;
  let otpSecondsLeft = 0;

  function formatMMSS(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function stopOtpCountdown() {
    clearInterval(otpCountdownTimer);
    otpCountdownTimer = null;
  }

  function startOtpCountdown(seconds) {
    stopOtpCountdown();
    otpSecondsLeft = seconds;
    otpCountdown.textContent = 'OTP expires in: ' + formatMMSS(otpSecondsLeft);
    otpCountdown.classList.remove('expiring');
    otpVerifyBtn.disabled = false;
    otpCountdownTimer = setInterval(() => {
      otpSecondsLeft -= 1;
      if (otpSecondsLeft <= 0) {
        otpCountdown.textContent = 'OTP expired. Please click Resend OTP.';
        otpCountdown.classList.add('expiring');
        otpVerifyBtn.disabled = true;
        stopOtpCountdown();
        return;
      }
      otpCountdown.textContent = 'OTP expires in: ' + formatMMSS(otpSecondsLeft);
      if (otpSecondsLeft <= 30) otpCountdown.classList.add('expiring');
    }, 1000);
  }

  // Client-side mirror of the server's resend cooldown, purely so the
  // Resend button visibly disables itself — the backend enforces the real
  // limit regardless of what the frontend does.
  function startResendCooldown(seconds) {
    clearInterval(otpResendCooldownTimer);
    let left = seconds;
    otpResendBtn.disabled = true;
    otpResendNote.textContent = 'You can resend in ' + left + 's.';
    otpResendCooldownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(otpResendCooldownTimer);
        otpResendBtn.disabled = false;
        otpResendNote.textContent = '';
        return;
      }
      otpResendNote.textContent = 'You can resend in ' + left + 's.';
    }, 1000);
  }

  function openOtpModal() {
    otpStepVerify.style.display = 'block';
    otpStepSuccess.style.display = 'none';
    otpEmailDisplay.textContent = emailInput.value.trim();
    otpCodeInput.value = '';
    otpError.classList.remove('show');
    otpModalOverlay.classList.add('show');
    otpCodeInput.focus();
  }

  function closeOtpModal() {
    otpModalOverlay.classList.remove('show');
    stopOtpCountdown();
    clearInterval(otpResendCooldownTimer);
  }

  function setEmailStatus(message, isError) {
    emailHint.textContent = message;
    emailHint.style.color = isError ? 'var(--danger, #c0392b)' : 'var(--green-deep, #0e3a24)';
  }

  // Sends (or resends) the OTP — always to the exact email the carrier
  // typed into this form. Returns true on success so callers can chain UI
  // updates (open modal / reset countdown) only when it worked.
  async function requestOtp({ isResend } = {}) {
    const email = emailInput.value.trim();
    try {
      const res = await fetch('/api/email-otp/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: 'carrier' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send the OTP.');
      startOtpCountdown(data.expiresInSeconds || 120);
      startResendCooldown(30);
      if (isResend) {
        // The previous code is invalidated server-side the moment a new
        // one is generated — clear the input so the carrier can't
        // accidentally re-submit the old (now-invalid) digits.
        otpCodeInput.value = '';
        otpCodeInput.focus();
        otpResendNote.textContent = 'New OTP sent successfully.';
        otpError.classList.remove('show');
        setTimeout(() => { if (otpResendNote.textContent === 'New OTP sent successfully.') otpResendNote.textContent = ''; }, 4000);
      }
      return true;
    } catch (err) {
      if (isResend) {
        otpError.textContent = err.message || 'Unable to resend OTP. Please try again.';
        otpError.classList.add('show');
      } else {
        setEmailStatus(err.message, true);
      }
      return false;
    }
  }

  // ---- "Create carrier account" click: validate everything first, then
  // send the OTP and open the modal instead of submitting the form. ----
  createAccountBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!termsCheckboxInput.checked) {
      termsCheckboxInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      alert('Please accept the Terms of Service and Privacy Policy to continue.');
      return;
    }
    if (!usernameInput.value.trim() || !isValidUsername(usernameInput.value.trim())) {
      usernameHint.textContent = '3–20 characters, letters/numbers/underscore, must start with a letter.';
      usernameHint.style.color = 'var(--danger, #c0392b)';
      usernameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => usernameInput.focus(), 300);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value.trim())) {
      setFieldError(emailInput, emailError, 'Please enter a valid email address.');
      emailInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => emailInput.focus(), 300);
      return;
    }
    setFieldError(emailInput, emailError, '');
    // GST or MSME — at least one required, with its number AND document.
    const bizType = currentBusinessDocType();
    if (bizType === 'gst') {
      if (!isValidGST(gstInput.value.trim())) {
        setFieldError(gstInput, gstNumberError, 'Please enter a valid 15-character GST number.');
        gstInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => gstInput.focus(), 300);
        return;
      }
      setFieldError(gstInput, gstNumberError, '');
      if (!gstPhotoPathInput.value) {
        businessDocHint.textContent = 'Please upload your GST certificate/document before submitting.';
        businessDocHint.style.color = 'var(--danger, #c0392b)';
        businessDocInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    } else {
      if (!isValidMsme(msmeInput.value.trim())) {
        setFieldError(msmeInput, msmeError, 'Please enter your MSME / Udyam registration number.');
        msmeInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => msmeInput.focus(), 300);
        return;
      }
      setFieldError(msmeInput, msmeError, '');
      if (!msmePhotoPathInput.value) {
        businessDocHint.textContent = 'Please upload your MSME/Udyam certificate/document before submitting.';
        businessDocHint.style.color = 'var(--danger, #c0392b)';
        businessDocInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    if (!driverAadharFrontPathInput.value || !driverAadharBackPathInput.value) {
      const hint = !driverAadharFrontPathInput.value
        ? document.getElementById('driverAadharFrontHint')
        : document.getElementById('driverAadharBackHint');
      hint.textContent = 'Please upload this photo before submitting.';
      hint.style.color = 'var(--danger, #c0392b)';
      hint.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!loadingSlipPathInput.value) {
      const hint = document.getElementById('loadingSlipHint');
      hint.textContent = 'Please upload your loading slip before submitting.';
      hint.style.color = 'var(--danger, #c0392b)';
      document.getElementById('loadingSlipInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!bankProofPathInput.value) {
      bankProofHint.textContent = 'Please upload your bank proof document before submitting.';
      bankProofHint.style.color = 'var(--danger, #c0392b)';
      bankProofInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!document.querySelector('input[name="bankAccountType"]:checked')) {
      const firstRadio = document.querySelector('input[name="bankAccountType"]');
      firstRadio.scrollIntoView({ behavior: 'smooth', block: 'center' });
      alert('Please select an account type (Savings or Current).');
      return;
    }
    if (!document.querySelector('form').reportValidity()) return;

    // Every field checks out — now (and only now) generate + send the OTP
    // and pop the verification modal open. The page never navigates away
    // at this point.
    const originalText = createAccountBtn.textContent;
    createAccountBtn.disabled = true;
    createAccountBtn.textContent = 'Sending OTP…';
    const sent = await requestOtp({ isResend: false });
    createAccountBtn.disabled = false;
    createAccountBtn.textContent = originalText;
    if (sent) openOtpModal();
  });

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

  otpVerifyBtn.addEventListener('click', async () => {
    const otp = otpCodeInput.value.trim();
    if (!otp) {
      otpError.textContent = 'Please enter the OTP.';
      otpError.classList.add('show');
      return;
    }
    otpVerifyBtn.disabled = true;
    otpVerifyBtn.textContent = 'Verifying…';
    try {
      const res = await fetch('/api/email-otp/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.value.trim(), otp }),
      });
      const data = await res.json();
      if (!res.ok || !data.verified) throw new Error(data.error || 'Invalid OTP. Please try again.');
      emailVerifyToken.value = data.verifyToken;
      setEmailStatus('Email verified.', false);
      stopOtpCountdown();
      clearInterval(otpResendCooldownTimer);
      otpStepVerify.style.display = 'none';
      otpStepSuccess.style.display = 'block';
    } catch (err) {
      otpError.textContent = err.message;
      otpError.classList.add('show');
    } finally {
      otpVerifyBtn.disabled = false;
      otpVerifyBtn.textContent = 'Verify OTP';
    }
  });

  otpResendBtn.addEventListener('click', () => requestOtp({ isResend: true }));

  otpModalCloseBtn.addEventListener('click', closeOtpModal);
  otpModalOverlay.addEventListener('click', (e) => { if (e.target === otpModalOverlay) closeOtpModal(); });

  // Registration is completed here via fetch, only once the OTP has been
  // verified — this is the one and only place /register/carrier is called.
  otpContinueBtn.addEventListener('click', async () => {
    closeOtpModal();
    const form = document.querySelector('form');
    const formData = new FormData(form);
    const payload = {};
    formData.forEach((value, key) => { payload[key] = value; });

    otpContinueBtn.disabled = true;
    const createBtnOriginalText = createAccountBtn.textContent;
    createAccountBtn.disabled = true;
    createAccountBtn.textContent = 'Creating your account…';

    try {
      const res = await fetch('/register/carrier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(registrationErrorMessage(data.error));
      window.location.href = data.redirectTo;
    } catch (err) {
      if (window.LS && LS.showError) LS.showError(err.message);
      else alert(err.message);
      otpContinueBtn.disabled = false;
      createAccountBtn.disabled = false;
      createAccountBtn.textContent = createBtnOriginalText;
    }
  });

  // If the email is changed after verifying, require re-verification.
  emailInput.addEventListener('input', () => { emailVerifyToken.value = ''; });

  // Any native form submission (e.g. pressing Enter in a text field) is
  // routed through the exact same validate -> send OTP -> open modal flow
  // as clicking "Create carrier account" — the actual registration POST
  // only ever happens via otpContinueBtn's handler after OTP verification.
  document.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    createAccountBtn.click();
  });
