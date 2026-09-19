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

  // ---- Track "registration started" — fires once, on the first time the
  // person interacts with any field in the form, not on every keystroke. ----
  (function trackRegistrationStarted() {
    if (!window.LS || !LS.Track) return;
    let fired = false;
    const formEl = document.querySelector('form');
    if (!formEl) return;
    formEl.addEventListener('input', function once() {
      if (fired) return;
      fired = true;
      LS.Track.log('REGISTRATION_STARTED', 'REGISTRATION_STARTED', { role: 'shipper' });
      formEl.removeEventListener('input', once);
    });
  })();

  // Shared error-code -> human message lookup, used both by the legacy
  // ?error= query-param path (kept as a fallback) and the main fetch-based
  // submission flow below.
  function registrationErrorMessage(err) {
    const messages = {
      invalid_phone: 'That phone number doesn\'t match the expected length for the selected country code.',
      invalid_pan: 'That PAN number is not in a valid format.',
      invalid_gst: 'That GST number is not valid (format/checksum check failed).',
      invalid_password: 'Password must be 1-10 characters and include an uppercase letter and an @ symbol.',
      email_not_verified: 'Please verify your email address with the OTP before submitting.',
      email_registered: 'An account already exists with this email address. Please log in instead.',
      invalid_username: 'Please choose a username that\'s 3-20 characters, starts with a letter, and contains only letters, numbers, or underscores.',
      username_taken: 'That username is already taken — please choose another.',
      kyc_photos_required: 'Please upload your Office Photo before submitting.',
      office_photo_required: 'Please upload a photo of your office / business location before submitting.',
      server_error: 'Something went wrong on our end — please try again in a moment.',
      missing: 'Please fill in all required fields.',
    };
    return messages[err] || 'Something didn\'t validate — please check your details and try again.';
  }

  // Surface any ?error=... the server redirected back with, in plain
  // language — kept only as a fallback for any old bookmarked/cached link;
  // the actual submission flow below no longer redirects on error at all.
  (function showServerError() {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (!err) return;
    const banner = document.getElementById('serverErrorBanner');
    banner.textContent = registrationErrorMessage(err);
    banner.style.display = 'block';
  })();

  // ---- PAN format check (5 letters, 4 digits, 1 letter) ----
  const panInput = document.getElementById('panNumber');
  const panHint = document.getElementById('panHint');
  function isValidPAN(v) { return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v); }
  panInput.addEventListener('input', () => { panInput.value = panInput.value.toUpperCase(); });
  panInput.addEventListener('blur', () => {
    if (!panInput.value) return;
    const ok = isValidPAN(panInput.value);
    panHint.textContent = ok ? 'Valid PAN format.' : 'Format should be like ABCDE1234F.';
    panHint.style.color = ok ? 'var(--green-deep)' : 'var(--danger)';
    panInput.setCustomValidity(ok ? '' : 'Enter a valid PAN (ABCDE1234F).');
  });

  // ---- GST format + checksum check ----
  // Normalizes (trim + uppercase) before checking, and also writes that
  // normalized value back into the field on blur — so what's shown, what's
  // validated, and what ultimately gets submitted are always the exact
  // same string. Mirrors isValidGST() on the server exactly, so a GSTIN
  // that passes here is guaranteed to pass there too.
  const gstInput = document.getElementById('gstNumber');
  const gstHint = document.getElementById('gstHint');
  const GST_CODES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function isValidGST(v) {
    v = String(v || '').trim().toUpperCase();
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return false;
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      const code = GST_CODES.indexOf(v[i]);
      const factor = (i % 2 === 0) ? 1 : 2;
      let val = code * factor;
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
    gstHint.style.color = ok ? 'var(--green-deep)' : 'var(--danger)';
    gstInput.setCustomValidity(ok ? '' : 'Enter a valid GSTIN.');
  });

  // ---- Password: 1-10 chars, must include an uppercase letter AND '@' ----
  const passwordInput = document.getElementById('password');
  const confirmPasswordInput = document.getElementById('confirmPassword');
  const passwordHint = document.getElementById('passwordHint');
  function checkPassword() {
    const v = passwordInput.value;
    const ok = v.length >= 1 && v.length <= 10 && /[A-Z]/.test(v) && v.includes('@');
    passwordInput.setCustomValidity(ok ? '' : 'Password must be 1-10 characters and include an uppercase letter and an @ symbol.');
    if (v) {
      passwordHint.style.color = ok ? 'var(--green-deep)' : 'var(--danger)';
    }
  }
  passwordInput.addEventListener('input', checkPassword);

  // ---- Email OTP verification modal ----
  // Opens automatically when "Create Shipper Account" is clicked (after all
  // other field validation passes) — there is no separate "Send OTP"
  // button anymore. Registration is only completed once the OTP is
  // verified inside the modal.
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
    emailHint.style.color = isError ? 'var(--danger)' : 'var(--green-deep)';
  }

  // Sends (or resends) the OTP. Returns true on success so callers can
  // chain UI updates (open modal / reset countdown) only when it worked.
  async function requestOtp({ isResend } = {}) {
    const email = emailInput.value.trim();
    try {
      const res = await fetch('/api/email-otp/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: 'shipper' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send the OTP.');
      startOtpCountdown(data.expiresInSeconds || 120);
      startResendCooldown(30);
      if (isResend) {
        // The previous code is invalidated server-side the moment a new
        // one is generated — clear the input so the shipper can't
        // accidentally re-submit the old (now-invalid) digits and think
        // Resend "didn't work".
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

  // ---- "Create Shipper Account" click: validate everything first, then
  // send the OTP and open the modal instead of submitting the form. ----
  createAccountBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const firstInvalidRequired = validateRequiredFields();
    if (firstInvalidRequired) {
      firstInvalidRequired.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (typeof firstInvalidRequired.focus === 'function') {
        setTimeout(() => firstInvalidRequired.focus(), 300);
      }
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value.trim())) {
      setFieldError(emailInput, emailError, 'Please enter a valid email address.');
      emailInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => emailInput.focus(), 300);
      return;
    }
    setFieldError(emailInput, emailError, '');
    const expected = selectedCountry.digits;
    const digits = normalizedDigits();
    const phoneOk = expected ? digits.length === expected : digits.length >= 7;
    if (!phoneOk) {
      phoneHint.textContent = expected
        ? `+${selectedCountry.cc} (${selectedCountry.name}) numbers must be exactly ${expected} digits.`
        : 'Enter a valid phone number.';
      phoneHint.style.color = 'var(--danger)';
      phoneInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => phoneInput.focus(), 300);
      return;
    }
    const officePhotoPath = document.getElementById('officePhotoPath');
    // Office Photo is the Shipper's one mandatory location photo — replaces
    // the old Selfie/face-photo requirement entirely.
    if (!officePhotoPath.value) {
      const hint = document.getElementById('officePhotoHint');
      hint.textContent = 'Please upload your Office Photo before submitting.';
      hint.style.color = 'var(--danger)';
      document.getElementById('officePhotoInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // Shippers are never asked for bank details — nothing to check here.

    // Every field checks out — now (and only now) generate + send the OTP
    // and pop the verification modal open. The page never navigates away
    // at this point.
    createAccountBtn.disabled = true;
    createAccountBtn.textContent = 'Sending OTP…';
    const sent = await requestOtp({ isResend: false });
    createAccountBtn.disabled = false;
    createAccountBtn.textContent = 'Create Shipper Account';
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

  // Registration is completed here via fetch (not a native form submit) —
  // so if the server finds a problem, we can show it as a popup and leave
  // every field exactly as the person left it, instead of a full-page
  // reload wiping the whole form for one bad field.
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
      const res = await fetch('/register/shipper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(registrationErrorMessage(data.error));
      if (window.LS && LS.Track) LS.Track.log('REGISTRATION_COMPLETED', 'REGISTRATION_COMPLETED', { role: 'shipper' });
      window.location.href = data.redirectTo;
    } catch (err) {
      if (window.LS && LS.showError) {
        LS.showError(err.message);
      } else {
        const banner = document.getElementById('serverErrorBanner');
        banner.textContent = err.message;
        banner.style.display = 'block';
      }
      otpContinueBtn.disabled = false;
      createAccountBtn.disabled = false;
      createAccountBtn.textContent = createBtnOriginalText;
    }
  });

  // If the email is changed after verifying, require re-verification.
  emailInput.addEventListener('input', () => { emailVerifyToken.value = ''; });

  // ---- PIN code -> district / state / area auto-fill (shared helper) ----
  const pincodeInput = document.getElementById('pincode');
  const districtInput = document.getElementById('district');
  const stateInput = document.getElementById('state');
  const areaInput = document.getElementById('area');
  const pincodeHint = document.getElementById('pincodeHint');
  LS.initPincodeAutofill({
    pincodeInput, districtInput, stateInput, areaInput, hintEl: pincodeHint,
  });

  // ---- Office Photo upload ----
  // A plain file upload (not a live camera capture) — this is a photo of a
  // location, not a selfie, so there's no liveness reason to require the
  // in-page camera. Image only (no PDF), matching the server's
  // PHOTO_ONLY_TYPES enforcement for the 'officePhoto' upload type.
  (function setupOfficePhotoUpload() {
    const input = document.getElementById('officePhotoInput');
    const hint = document.getElementById('officePhotoHint');
    const pathInput = document.getElementById('officePhotoPath');
    if (!input) return;
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      pathInput.value = '';
      if (!/^image\//.test(file.type)) {
        hint.textContent = 'Please upload an image file (JPG or PNG).';
        hint.style.color = 'var(--danger)';
        input.value = '';
        return;
      }
      hint.textContent = 'Uploading…';
      hint.style.color = '';
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const res = await fetch('/api/kyc/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'officePhoto', imageBase64: dataUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not upload that photo.');
        pathInput.value = data.path;
        hint.textContent = '✓ ' + file.name + ' uploaded.';
        hint.style.color = 'var(--green-deep)';
      } catch (err) {
        hint.textContent = err.message;
        hint.style.color = 'var(--danger)';
        input.value = '';
      }
    });
  })();

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  // ---- Business certificate — either/or between GST and MSME/Udyam ----
  // Optional: the shipper can skip this entirely, or upload whichever one
  // certificate they have. Switching the radio choice clears any file
  // already attached to the OTHER type, so only one is ever sent.
  (function setupBusinessDocUpload() {
    const docInput = document.getElementById('businessDocInput');
    const hint = document.getElementById('businessDocHint');
    const gstPathInput = document.getElementById('gstPhotoPath');
    const msmePathInput = document.getElementById('msmePhotoPath');
    const gstRadio = document.getElementById('docTypeGst');
    const msmeRadio = document.getElementById('docTypeMsme');
    if (!docInput) return; // page doesn't have this widget

    function currentType() { return msmeRadio.checked ? 'msmePhoto' : 'gstPhoto'; }

    [gstRadio, msmeRadio].forEach((radio) => {
      radio.addEventListener('change', () => {
        // Switching type clears any previously uploaded file/path — only
        // one of GST/MSME is ever submitted, matching the either/or choice.
        gstPathInput.value = '';
        msmePathInput.value = '';
        docInput.value = '';
        hint.textContent = 'Accepted: JPG, PNG, or PDF — max 8MB.';
        hint.style.color = '';
      });
    });

    docInput.addEventListener('change', async () => {
      const file = docInput.files[0];
      if (!file) return;
      gstPathInput.value = '';
      msmePathInput.value = '';
      hint.textContent = 'Uploading…';
      hint.style.color = '';
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const type = currentType();
        const res = await fetch('/api/kyc/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, imageBase64: dataUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not upload that file.');
        if (type === 'msmePhoto') msmePathInput.value = data.path;
        else gstPathInput.value = data.path;
        hint.textContent = '✓ ' + file.name + ' uploaded.';
        hint.style.color = 'var(--green-deep, #0e3a24)';
      } catch (err) {
        hint.textContent = err.message;
        hint.style.color = 'var(--danger)';
        docInput.value = '';
      }
    });
  })();

  // ---- Phone: custom flag dropdown + digit-count validation (no OTP) ----
  // Countries list mirrors the server's PHONE_LENGTH_BY_CC exactly, plus an
  // ISO-2 code so a real flag image can be shown (native <select><option>
  // can't render images, and flag emoji don't render on many Windows/Chrome
  // combinations — they fall back to plain "IN"-style letters).
  const COUNTRIES = [
    { cc: '91',  iso: 'in', name: 'India',         digits: 10 },
    { cc: '1',   iso: 'us', name: 'USA / Canada',  digits: 10 },
    { cc: '44',  iso: 'gb', name: 'UK',             digits: 10 },
    { cc: '61',  iso: 'au', name: 'Australia',      digits: 9 },
    { cc: '971', iso: 'ae', name: 'UAE',            digits: 9 },
    { cc: '65',  iso: 'sg', name: 'Singapore',      digits: 8 },
    { cc: '81',  iso: 'jp', name: 'Japan',          digits: 10 },
    { cc: '82',  iso: 'kr', name: 'South Korea',    digits: 10 },
    { cc: '49',  iso: 'de', name: 'Germany',        digits: 11 },
    { cc: '33',  iso: 'fr', name: 'France',         digits: 9 },
    { cc: '39',  iso: 'it', name: 'Italy',          digits: 10 },
    { cc: '34',  iso: 'es', name: 'Spain',          digits: 9 },
    { cc: '86',  iso: 'cn', name: 'China',          digits: 11 },
    { cc: '880', iso: 'bd', name: 'Bangladesh',     digits: 10 },
    { cc: '92',  iso: 'pk', name: 'Pakistan',       digits: 10 },
    { cc: '94',  iso: 'lk', name: 'Sri Lanka',      digits: 9 },
    { cc: '66',  iso: 'th', name: 'Thailand',       digits: 9 },
    { cc: '62',  iso: 'id', name: 'Indonesia',      digits: 10 },
    { cc: '27',  iso: 'za', name: 'South Africa',   digits: 9 },
    { cc: '55',  iso: 'br', name: 'Brazil',         digits: 11 },
  ];
  const PHONE_LENGTH_BY_CC = Object.fromEntries(COUNTRIES.map(c => [c.cc, c.digits]));

  const phoneInput = document.getElementById('phoneNumber');
  const countryCodeHidden = document.getElementById('countryCode');
  const phoneHint = document.getElementById('phoneHint');
  const ccTrigger = document.getElementById('ccTrigger');
  const ccList = document.getElementById('ccList');
  const ccFlagImg = document.getElementById('ccFlagImg');
  const ccCodeText = document.getElementById('ccCodeText');

  let selectedCountry = COUNTRIES[0];

  function renderCcList() {
    ccList.innerHTML = COUNTRIES.map(c => `
      <li role="option" data-cc="${c.cc}" data-iso="${c.iso}" data-name="${c.name}"
        style="display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; cursor:pointer; font-size:13.5px;">
        <img src="https://flagcdn.com/24x18/${c.iso}.png" width="24" height="18" alt="" style="display:block; border-radius:2px; flex:0 0 auto;">
        <span style="font-weight:600; flex:0 0 auto;">+${c.cc}</span>
        <span style="color:#5c6a61; flex:1 1 auto;">${c.name}</span>
      </li>`).join('');
  }
  renderCcList();

  function selectCountry(cc) {
    const country = COUNTRIES.find(c => c.cc === cc) || COUNTRIES[0];
    selectedCountry = country;
    ccFlagImg.src = `https://flagcdn.com/24x18/${country.iso}.png`;
    ccCodeText.textContent = '+' + country.cc;
    countryCodeHidden.value = '+' + country.cc;
    closeCcList();
    checkPhoneLength();
  }

  function openCcList() {
    ccList.style.display = 'block';
    ccTrigger.setAttribute('aria-expanded', 'true');
  }
  function closeCcList() {
    ccList.style.display = 'none';
    ccTrigger.setAttribute('aria-expanded', 'false');
  }

  ccTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    ccList.style.display === 'block' ? closeCcList() : openCcList();
  });
  ccList.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-cc]');
    if (li) selectCountry(li.getAttribute('data-cc'));
  });
  document.addEventListener('click', (e) => {
    if (!document.getElementById('ccDropdown').contains(e.target)) closeCcList();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCcList();
  });

  function normalizedDigits() {
    let digits = phoneInput.value.replace(/\D/g, '');
    const expected = selectedCountry.digits || 10;
    if (digits.length > expected && digits.startsWith(selectedCountry.cc)) digits = digits.slice(selectedCountry.cc.length);
    return digits;
  }

  function checkPhoneLength() {
    if (!phoneInput.value) { phoneInput.setCustomValidity(''); return; }
    const expected = selectedCountry.digits;
    const digits = normalizedDigits();
    const ok = expected ? digits.length === expected : digits.length >= 7;
    if (ok) {
      phoneInput.setCustomValidity('');
      phoneHint.textContent = 'Looks good.';
      phoneHint.style.color = 'var(--green-deep)';
    } else {
      phoneInput.setCustomValidity(`Enter exactly ${expected || 7}+ digits for +${selectedCountry.cc}.`);
      phoneHint.textContent = expected
        ? `+${selectedCountry.cc} (${selectedCountry.name}) numbers must be exactly ${expected} digits — you entered ${digits.length}.`
        : 'Enter a valid phone number.';
      phoneHint.style.color = 'var(--danger)';
    }
  }
  phoneInput.addEventListener('input', checkPhoneLength);
  phoneInput.addEventListener('blur', checkPhoneLength);

  // ---------------------------------------------------------------------
  // Full client-side validation — shows a red message under any field
  // that's empty or invalid, and blocks submission until every field
  // passes. Mirrors the server-side checks in server_load.js so the
  // person sees the same rule before the round trip, not after it.
  // ---------------------------------------------------------------------
  function setFieldError(input, errorEl, message) {
    if (message) {
      input.classList.add('invalid');
      errorEl.textContent = message;
      errorEl.classList.add('show');
    } else {
      input.classList.remove('invalid');
      errorEl.classList.remove('show');
    }
    return !message;
  }

  const companyNameInput = document.getElementById('companyName');
  const contactPersonInput = document.getElementById('contactPerson');
  const pickupAddressInput = document.getElementById('pickupAddress');
  const gstNumberInput = document.getElementById('gstNumber');
  const businessDetailInput = document.getElementById('businessDetail');
  const panNumberInput = document.getElementById('panNumber');
  const usernameInput = document.getElementById('username');
  const termsCheckbox = document.getElementById('termsCheckbox');

  // ---- Username format check (letters/digits/underscore, starts with a
  // letter, 3-20 chars) — mirrors isValidUsername() on the server exactly. ----
  const usernameHint = document.getElementById('usernameHint');
  function isValidUsername(v) { return /^[a-zA-Z][a-zA-Z0-9_]{2,19}$/.test(v); }
  usernameInput.addEventListener('blur', () => {
    if (!usernameInput.value) return;
    const ok = isValidUsername(usernameInput.value.trim());
    usernameHint.textContent = ok
      ? 'Looks good.'
      : '3–20 characters, letters/numbers/underscore, must start with a letter.';
    usernameHint.style.color = ok ? 'var(--green-deep)' : 'var(--danger)';
    usernameInput.setCustomValidity(ok ? '' : 'Choose a valid username.');
  });

  function validateRequiredFields() {
    let firstInvalid = null;
    const checks = [
      [companyNameInput, document.getElementById('companyNameError'),
        companyNameInput.value.trim() ? '' : 'Please enter your company name.'],
      [contactPersonInput, document.getElementById('contactPersonError'),
        contactPersonInput.value.trim() ? '' : "Please enter the contact person's name."],
      [pincodeInput, document.getElementById('pincodeError'),
        /^[0-9]{6}$/.test(pincodeInput.value.trim()) ? '' : 'Please enter a valid 6-digit PIN code.'],
      [pickupAddressInput, document.getElementById('pickupAddressError'),
        pickupAddressInput.value.trim() ? '' : 'Please enter your pickup / registration address.'],
      // Same isValidGST() (format + checksum) used for the live blur hint
      // above and by the server — one set of GST rules everywhere, not a
      // separate looser regex here that could disagree with the backend.
      [gstNumberInput, document.getElementById('gstNumberError'),
        isValidGST(gstNumberInput.value) ? '' : 'Please enter a valid 15-character GST number.'],
      [businessDetailInput, document.getElementById('businessDetailError'),
        businessDetailInput.value.trim() ? '' : 'Please enter your business detail.'],
      [panNumberInput, document.getElementById('panNumberError'),
        /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(panNumberInput.value.trim()) ? '' : 'Please enter a valid PAN number (e.g. ABCDE1234F).'],
      [usernameInput, document.getElementById('usernameError'),
        isValidUsername(usernameInput.value.trim()) ? '' : 'Choose a username: 3–20 characters, letters/numbers/underscore, starting with a letter.'],
      [passwordInput, document.getElementById('passwordError'),
        (passwordInput.value.length >= 1 && passwordInput.value.length <= 10 && /[A-Z]/.test(passwordInput.value) && passwordInput.value.includes('@'))
          ? '' : 'Password must be 1–10 characters with an uppercase letter and an @ symbol.'],
      [confirmPasswordInput, document.getElementById('confirmPasswordError'),
        (confirmPasswordInput.value && confirmPasswordInput.value === passwordInput.value) ? '' : 'Passwords do not match.'],
    ];
    checks.forEach(([input, errorEl, message]) => {
      const ok = setFieldError(input, errorEl, message);
      if (!ok && !firstInvalid) firstInvalid = input;
    });

    const termsError = document.getElementById('termsError');
    if (!termsCheckbox.checked) {
      termsError.classList.add('show');
      if (!firstInvalid) firstInvalid = termsCheckbox;
    } else {
      termsError.classList.remove('show');
    }

    return firstInvalid;
  }

  // Re-validate a field the moment it loses focus / changes, so the red
  // message clears as soon as it's fixed (not just on next submit).
  [companyNameInput, contactPersonInput, pincodeInput, pickupAddressInput,
   gstNumberInput, businessDetailInput, panNumberInput, usernameInput,
   passwordInput, confirmPasswordInput].forEach((input) => {
    input.addEventListener('blur', validateRequiredFields);
    input.addEventListener('input', () => { if (input.classList.contains('invalid')) validateRequiredFields(); });
  });
  termsCheckbox.addEventListener('change', validateRequiredFields);

  // Any native form submission (e.g. pressing Enter in a text field) is
  // routed through the exact same validate -> send OTP -> open modal flow
  // as clicking "Create Shipper Account" — single source of truth, and the
  // actual registration POST only ever happens via otpContinueBtn's
  // form.submit() after OTP verification succeeds.
  document.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    createAccountBtn.click();
  });
