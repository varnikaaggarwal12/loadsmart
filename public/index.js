  var roleLabels = { shipper: 'Shipper', broker: 'Broker', carrier: 'Carrier' };
  var currentRole = null;

  function openRoleModal(evt, role){
    if (evt) evt.preventDefault();
    currentRole = role;
    document.getElementById('roleModalEyebrow').textContent = roleLabels[role] + ' Portal';
    document.getElementById('roleModalTitle').textContent = 'Continue as ' + roleLabels[role];
    document.getElementById('roleModal').classList.add('open');
    return false;
  }

  function closeRoleModal(){
    document.getElementById('roleModal').classList.remove('open');
    currentRole = null;
  }

  document.getElementById('roleModalLogin').addEventListener('click', function(){
    if (currentRole) window.location.href = '/login/' + currentRole;
  });
  document.getElementById('roleModalRegister').addEventListener('click', function(){
    if (currentRole) window.location.href = '/register/' + currentRole;
  });
  document.getElementById('roleModal').addEventListener('click', function(e){
    if (e.target === this) closeRoleModal();
  });

  // The Broker nav link and the "I am a Broker" hero card are always shown
  // and always functional — Broker is a first-class role exactly like
  // Shipper and Carrier, so it is never hidden behind a settings toggle.

  // ---- Services dropdown (Home / About / Contact / Complaint) ----
  var servicesDropdown = document.getElementById('servicesDropdown');
  document.getElementById('servicesTrigger').addEventListener('click', function(e){
    e.preventDefault();
    e.stopPropagation();
    servicesDropdown.classList.toggle('open');
    if (servicesDropdown.classList.contains('open') && window.LS && LS.Track) LS.Track.log('SERVICES_OPENED', 'SERVICES_OPENED');
  });
  document.addEventListener('click', function(e){
    if (!servicesDropdown.contains(e.target)) servicesDropdown.classList.remove('open');
  });

  function openSimpleModal(id){ document.getElementById(id).classList.add('open'); }
  function closeSimpleModal(id){ document.getElementById(id).classList.remove('open'); }
  [['aboutModal','aboutCloseBtn'], ['contactModal','contactCloseBtn'], ['complaintModal','complaintCloseBtn']].forEach(function(pair){
    var overlay = document.getElementById(pair[0]);
    document.getElementById(pair[1]).addEventListener('click', function(){ closeSimpleModal(pair[0]); });
    overlay.addEventListener('click', function(e){ if (e.target === overlay) closeSimpleModal(pair[0]); });
  });

  document.getElementById('menuHomeLink').addEventListener('click', function(){
    servicesDropdown.classList.remove('open');
    // Already the Home page — no duplicate page, just closes the menu and
    // (if scrolled down) brings the person back to the top.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.getElementById('menuAboutLink').addEventListener('click', function(e){
    e.preventDefault();
    servicesDropdown.classList.remove('open');
    openSimpleModal('aboutModal');
    if (window.LS && LS.Track) LS.Track.log('ABOUT_OPENED', 'ABOUT_OPENED');
  });
  document.getElementById('menuContactLink').addEventListener('click', function(e){
    e.preventDefault();
    servicesDropdown.classList.remove('open');
    openSimpleModal('contactModal');
    if (window.LS && LS.Track) LS.Track.log('CONTACT_OPENED', 'CONTACT_OPENED');
  });
  document.getElementById('menuComplaintLink').addEventListener('click', function(e){
    e.preventDefault();
    servicesDropdown.classList.remove('open');
    openComplaintModal();
    if (window.LS && LS.Track) LS.Track.log('COMPLAINT_OPENED', 'COMPLAINT_OPENED');
  });

  // ---- Complaint form ----
  // If the person is logged in (shipper/broker/carrier — token left in this
  // tab's sessionStorage by /assets/auth.js on the portal pages), identify
  // them automatically instead of asking for info the system already has.
  function loggedInUserToken(){
    try { return sessionStorage.getItem('ls_user_token'); } catch (e) { return null; }
  }

  function openComplaintModal(){
    var token = loggedInUserToken();
    var typeRow = document.getElementById('complaintUserTypeRow');
    var loggedInNote = document.getElementById('complaintLoggedInNote');
    document.getElementById('complaintError').style.display = 'none';
    document.getElementById('complaintSuccess').style.display = 'none';
    document.getElementById('complaintEmail').value = '';
    document.getElementById('complaintMessage').value = '';
    if (token) {
      typeRow.style.display = 'none';
      loggedInNote.style.display = 'block';
      loggedInNote.textContent = "You're logged in — your account will be attached to this complaint automatically.";
    } else {
      typeRow.style.display = 'flex';
      loggedInNote.style.display = 'none';
      document.getElementById('complaintNewRadio').checked = true;
    }
    openSimpleModal('complaintModal');
  }

  document.getElementById('complaintSubmitBtn').addEventListener('click', function(){
    var btn = this;
    var errorEl = document.getElementById('complaintError');
    var successEl = document.getElementById('complaintSuccess');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    var email = document.getElementById('complaintEmail').value.trim();
    var message = document.getElementById('complaintMessage').value.trim();
    if (!message) { errorEl.textContent = 'Please describe the problem you\'re facing.'; errorEl.style.display = 'block'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errorEl.textContent = 'Enter a valid email address.'; errorEl.style.display = 'block'; return; }

    var token = loggedInUserToken();
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    btn.disabled = true;
    btn.textContent = 'Submitting…';
    fetch('/api/complaints', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ email: email, message: message }),
    })
      .then(function(res){ return res.json().then(function(data){ return { ok: res.ok, data: data }; }); })
      .then(function(result){
        if (!result.ok) throw new Error(result.data.error || 'Could not submit your complaint.');
        successEl.textContent = 'Thank you — your complaint has been submitted (Reference: ' + result.data.id + ').';
        successEl.style.display = 'block';
        document.getElementById('complaintMessage').value = '';
        if (window.LS && LS.showSuccess) LS.showSuccess('Complaint submitted successfully!', { sub: 'Reference: ' + result.data.id });
        if (window.LS && LS.Track) LS.Track.log('COMPLAINT_SUBMITTED', 'COMPLAINT_SUBMITTED');
        // Auto-close the complaint box on success — the person already saw
        // the confirmation (success banner + green-tick popup) by the time
        // this fires, so they don't need to click X themselves. Never runs
        // on a failed submission (see .catch below, which leaves the form
        // open with the error message and whatever they typed intact).
        setTimeout(function () { closeSimpleModal('complaintModal'); }, 1200);
      })
      .catch(function(err){
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      })
      .finally(function(){
        btn.disabled = false;
        btn.textContent = 'Submit Complaint';
      });
  });
