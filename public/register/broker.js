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
      full_name_required: 'Please enter your full name.',
      broker_type_required: 'Please choose Individual or Company/Agency.',
      company_name_required: 'Please enter your company/agency name.',
      address_required: 'Please enter your business address.',
      city_required: 'Please enter your city.',
      state_required: 'Please enter your state.',
      invalid_pincode: 'Please enter a valid 6-digit pincode.',
      invalid_gst: 'That GST number is not valid (format/checksum check failed).',
      gst_document_required: 'Please upload your GST certificate.',
      invalid_msme: 'Please enter a valid MSME/Udyam number (at least 8 characters).',
      msme_document_required: 'Please upload your MSME/Udyam certificate.',
      invalid_pan: 'Please enter a valid PAN number.',
      pan_document_required: 'Please upload your PAN card.',
      bank_account_holder_required: 'Please enter the bank account holder name.',
      invalid_bank_account_number: 'Please enter a valid bank account number (9-18 digits).',
      invalid_ifsc: 'That IFSC code is not in a valid format.',
      bank_name_required: 'Please enter your bank name.',
      bank_account_type_required: 'Please select an account type (Savings or Current).',
      bank_proof_required: 'Please upload your bank proof document (cancelled cheque or passbook photo).',
      invalid_password: 'Password must be 1-10 characters and include an uppercase letter and an @ symbol.',
      email_not_verified: 'Please verify your email address with the OTP before submitting.',
      email_registered: 'An account already exists with this email address. Please log in instead.',
      invalid_username: 'Please choose a username that\'s 3-20 characters, starts with a letter, and contains only letters, numbers, or underscores.',
      username_taken: 'That username is already taken — please choose another.',
      broker_registration_closed: 'Broker registration is currently closed. Please check back later.',
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

  const usernameInput = document.getElementById('username');
  const usernameHint = document.getElementById('usernameHint');
  function isValidUsername(v) { return /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(v); }
  usernameInput.addEventListener('blur', () => {
    if (!usernameInput.value) return;
    const ok = isValidUsername(usernameInput.value.trim());
    usernameHint.textContent = ok ? 'Looks good.' : '3–20 characters, letters/numbers/underscore, must start with a letter.';
    usernameHint.style.color = ok ? 'var(--green-deep, #0e3a24)' : 'var(--danger, #c0392b)';
    usernameInput.setCustomValidity(ok ? '' : 'Choose a valid username.');
  });

  // ---- Broker type cards (Individual / Company-Agency) ----
  const brokerTypeGroup = document.getElementById('brokerTypeGroup');
  const brokerTypeInput = document.getElementById('brokerType');
  const companyNameField = document.getElementById('companyNameField');
  const companyNameInput = document.getElementById('companyName');
  brokerTypeGroup.querySelectorAll('.type-card').forEach((card) => {
    card.addEventListener('click', () => {
      brokerTypeGroup.querySelectorAll('.type-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      const value = card.getAttribute('data-value');
      brokerTypeInput.value = value;
      const isCompany = value === 'company';
      companyNameField.hidden = !isCompany;
      companyNameInput.required = isCompany;
      if (!isCompany) companyNameInput.value = '';
    });
  });

  // ---- Generic Yes/No toggle wiring for a conditional section ----
  function wireYesNoToggle({ groupId, hiddenInputId, sectionId, requiredFieldIds }) {
    const group = document.getElementById(groupId);
    const hiddenInput = document.getElementById(hiddenInputId);
    const section = document.getElementById(sectionId);
    group.querySelectorAll('.yn-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.yn-toggle').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const isYes = btn.getAttribute('data-value') === 'yes';
        hiddenInput.value = isYes ? 'true' : 'false';
        section.hidden = !isYes;
        (requiredFieldIds || []).forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.required = isYes;
        });
        if (!isYes) {
          (requiredFieldIds || []).forEach((id) => {
            const el = document.getElementById(id);
            if (el && el.tagName !== 'INPUT') return;
            if (el && el.type !== 'file') el.value = '';
          });
        }
      });
    });
  }
  wireYesNoToggle({ groupId: 'hasGSTGroup', hiddenInputId: 'hasGST', sectionId: 'gstSection', requiredFieldIds: ['gstNumber'] });
  wireYesNoToggle({ groupId: 'hasMSMEGroup', hiddenInputId: 'hasMSME', sectionId: 'msmeSection', requiredFieldIds: ['msmeNumber'] });

  // ---- Pincode auto-fill (city/state) ----
  if (window.LS && LS.initPincodeAutofill) {
    LS.initPincodeAutofill({
      pincodeInput: document.getElementById('pincode'),
      districtInput: document.getElementById('city'),
      stateInput: document.getElementById('state'),
      areaInput: null,
      hintEl: document.getElementById('pincodeHint'),
    });
  }

  // ---- GST / PAN format checks (mirror server-side validators) ----
  const gstInput = document.getElementById('gstNumber');
  const gstHint = document.getElementById('gstHint');
  const gstNumberError = document.getElementById('gstNumberError');
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
  });

  const panInput = document.getElementById('panNumber');
  panInput.addEventListener('input', () => { panInput.value = panInput.value.toUpperCase(); });

  const ifscInput = document.getElementById('bankIfsc');
  const ifscHint = document.getElementById('bankIfscHint');
  ifscInput.addEventListener('input', () => { ifscInput.value = ifscInput.value.toUpperCase(); });
  ifscInput.addEventListener('blur', () => {
    if (!ifscInput.value) return;
    const ok = /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscInput.value);
    ifscHint.textContent = ok ? 'Valid IFSC format.' : 'Format should be like HDFC0001234.';
    ifscHint.style.color = ok ? 'var(--green-deep, #0e3a24)' : 'var(--danger, #c0392b)';
  });

  // ---- Generic file-upload wiring, shared by every document field ----
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }
  function wireUpload({ inputId, hintId, pathInputId, uploadType, label }) {
    const input = document.getElementById(inputId);
    const hint = document.getElementById(hintId);
    const pathInput = document.getElementById(pathInputId);
    if (!input) return;
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      pathInput.value = '';
      hint.textContent = 'Uploading…';
      hint.style.color = '';
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const res = await fetch('/api/kyc/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: uploadType, imageBase64: dataUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not upload that file.');
        pathInput.value = data.path;
        hint.textContent = '✓ ' + file.name + ' uploaded.';
        hint.style.color = 'var(--green-deep, #0e3a24)';
      } catch (err) {
        hint.textContent = err.message;
        hint.style.color = 'var(--danger, #c0392b)';
        input.value = '';
      }
    });
  }
  wireUpload({ inputId: 'gstDocInput', hintId: 'gstDocHint', pathInputId: 'gstDocumentPath', uploadType: 'gstPhoto' });
  wireUpload({ inputId: 'msmeDocInput', hintId: 'msmeDocHint', pathInputId: 'msmeDocumentPath', uploadType: 'msmePhoto' });
  wireUpload({ inputId: 'panDocInput', hintId: 'panDocHint', pathInputId: 'panDocumentPath', uploadType: 'panDocument' });
  wireUpload({ inputId: 'addressProofInput', hintId: 'addressProofHint', pathInputId: 'addressProofPath', uploadType: 'addressProof' });
  wireUpload({ inputId: 'profilePhotoInput', hintId: 'profilePhotoHint', pathInputId: 'profilePhotoPath', uploadType: 'profilePhoto' });
  wireUpload({ inputId: 'bankProofInput', hintId: 'bankProofHint', pathInputId: 'bankProofPhotoPath', uploadType: 'bankProof' });

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

  // ---- Email OTP verification modal ----
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
  function stopOtpCountdown() { clearInterval(otpCountdownTimer); otpCountdownTimer = null; }
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

  async function requestOtp({ isResend } = {}) {
    const email = emailInput.value.trim();
    try {
      const res = await fetch('/api/email-otp/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: 'broker' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send the OTP.');
      startOtpCountdown(data.expiresInSeconds || 120);
      startResendCooldown(30);
      if (isResend) {
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

  function firstInvalidRequiredField() {
    const form = document.querySelector('form');
    return form.querySelector(':invalid');
  }

  createAccountBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!termsCheckboxInput.checked) {
      termsCheckboxInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      alert('Please accept the Terms of Service and Privacy Policy to continue.');
      return;
    }
    if (!brokerTypeInput.value) {
      document.getElementById('brokerTypeError').classList.add('show');
      brokerTypeGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    document.getElementById('brokerTypeError').classList.remove('show');
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
    if (document.getElementById('hasGST').value === 'true') {
      if (!isValidGST(gstInput.value.trim())) {
        setFieldError(gstInput, gstNumberError, 'Please enter a valid 15-character GST number.');
        gstInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (!document.getElementById('gstDocumentPath').value) {
        gstHint.textContent = 'Please upload your GST certificate before submitting.';
        gstHint.style.color = 'var(--danger, #c0392b)';
        document.getElementById('gstDocInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    setFieldError(gstInput, gstNumberError, '');
    if (document.getElementById('hasMSME').value === 'true') {
      const msmeInput = document.getElementById('msmeNumber');
      if (msmeInput.value.trim().length < 8) {
        setFieldError(msmeInput, document.getElementById('msmeNumberError'), 'Please enter a valid MSME/Udyam number.');
        msmeInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (!document.getElementById('msmeDocumentPath').value) {
        document.getElementById('msmeDocHint').textContent = 'Please upload your MSME/Udyam certificate before submitting.';
        document.getElementById('msmeDocHint').style.color = 'var(--danger, #c0392b)';
        document.getElementById('msmeDocInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panInput.value.trim().toUpperCase())) {
      setFieldError(panInput, document.getElementById('panNumberError'), 'Please enter a valid PAN number.');
      panInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setFieldError(panInput, document.getElementById('panNumberError'), '');
    if (!document.getElementById('panDocumentPath').value) {
      document.getElementById('panDocHint').textContent = 'Please upload your PAN card before submitting.';
      document.getElementById('panDocHint').style.color = 'var(--danger, #c0392b)';
      document.getElementById('panDocInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!document.getElementById('bankProofPhotoPath').value) {
      document.getElementById('bankProofHint').textContent = 'Please upload your bank proof document before submitting.';
      document.getElementById('bankProofHint').style.color = 'var(--danger, #c0392b)';
      document.getElementById('bankProofInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!document.querySelector('input[name="bankAccountType"]:checked')) {
      const firstRadio = document.querySelector('input[name="bankAccountType"]');
      firstRadio.scrollIntoView({ behavior: 'smooth', block: 'center' });
      alert('Please select an account type (Savings or Current).');
      return;
    }
    if (!document.querySelector('form').reportValidity()) return;

    const originalText = createAccountBtn.textContent;
    createAccountBtn.disabled = true;
    createAccountBtn.textContent = 'Sending OTP…';
    const sent = await requestOtp({ isResend: false });
    createAccountBtn.disabled = false;
    createAccountBtn.textContent = originalText;
    if (sent) openOtpModal();
  });

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

  otpContinueBtn.addEventListener('click', async () => {
    closeOtpModal();
    const form = document.querySelector('form');
    const formData = new FormData(form);
    const payload = { address: {} };
    formData.forEach((value, key) => {
      if (['addressLine', 'city', 'state', 'pincode'].includes(key)) payload.address[key] = value;
      else payload[key] = value;
    });
    payload.hasGST = document.getElementById('hasGST').value === 'true';
    payload.hasMSME = document.getElementById('hasMSME').value === 'true';

    otpContinueBtn.disabled = true;
    const createBtnOriginalText = createAccountBtn.textContent;
    createAccountBtn.disabled = true;
    createAccountBtn.textContent = 'Creating your account…';

    try {
      const res = await fetch('/register/broker', {
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

  emailInput.addEventListener('input', () => { emailVerifyToken.value = ''; });

  document.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    createAccountBtn.click();
  });
