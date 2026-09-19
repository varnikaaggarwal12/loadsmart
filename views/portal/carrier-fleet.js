  (function initTheme() {
    const KEY = 'ls_theme';
    function apply(theme) {
      document.body.classList.toggle('dark-mode', theme === 'dark');
      document.getElementById('themeIcon').textContent = theme === 'dark' ? '☀️' : '🌙';
      document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Light' : 'Dark';
    }
    apply(localStorage.getItem(KEY) || 'light');
    document.getElementById('themeToggle').addEventListener('click', () => {
      const next = document.body.classList.contains('dark-mode') ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
      apply(next);
    });
  })();

  const errorBanner = document.getElementById('errorBanner');
  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
    setTimeout(() => { errorBanner.style.display = 'none'; }, 5000);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  // ---- Tabs ----
  document.querySelectorAll('.fleet-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fleet-tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      document.getElementById('trucksPanel').style.display = tab === 'trucks' ? 'block' : 'none';
      document.getElementById('driversPanel').style.display = tab === 'drivers' ? 'block' : 'none';
    });
  });

  // ==================== TRUCKS ====================
  const showAddTruckBtn = document.getElementById('showAddTruckBtn');
  const addTruckForm = document.getElementById('addTruckForm');
  showAddTruckBtn.addEventListener('click', () => { addTruckForm.style.display = 'block'; showAddTruckBtn.style.display = 'none'; });
  document.getElementById('cancelTruckBtn').addEventListener('click', () => { addTruckForm.style.display = 'none'; showAddTruckBtn.style.display = 'inline-flex'; });

  const truckTypeSelect = document.getElementById('truckTypeSelect');
  const truckTypeOther = document.getElementById('truckTypeOther');
  truckTypeSelect.addEventListener('change', () => {
    truckTypeOther.style.display = truckTypeSelect.value === '__other__' ? 'block' : 'none';
  });

  const truckDocInput = document.getElementById('truckDocInput');
  const truckDocHint = document.getElementById('truckDocHint');
  const truckDocPath = document.getElementById('truckDocPath');
  truckDocInput.addEventListener('change', async () => {
    const file = truckDocInput.files[0];
    if (!file) return;
    truckDocPath.value = '';
    truckDocHint.textContent = 'Uploading…';
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await fetch('/api/kyc/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'driverRcPhoto', imageBase64: dataUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not upload that file.');
      truckDocPath.value = data.path;
      truckDocHint.textContent = '✓ ' + file.name + ' uploaded.';
      truckDocHint.style.color = 'var(--green-deep)';
    } catch (err) {
      truckDocHint.textContent = err.message;
      truckDocHint.style.color = 'var(--danger, #c0392b)';
    }
  });

  document.getElementById('saveTruckBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('truckFormError');
    errEl.textContent = '';
    const vehicleNumber = document.getElementById('truckVehicleNumber').value.trim();
    const truckType = truckTypeSelect.value === '__other__' ? truckTypeOther.value.trim() : truckTypeSelect.value;
    const capacityTons = document.getElementById('truckCapacity').value;
    if (!vehicleNumber || !truckType || !capacityTons) {
      errEl.textContent = 'Please fill in vehicle number, truck type, and capacity.';
      return;
    }
    try {
      const res = await fetch('/api/carrier/trucks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleNumber, truckType, capacityTons,
          bodyType: document.getElementById('truckBodyType').value.trim(),
          currentLocation: document.getElementById('truckLocation').value.trim(),
          documentPhotoPath: truckDocPath.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add that truck.');
      if (window.LS && LS.showSuccess) LS.showSuccess('Truck added! It will be eligible for matching once Admin verifies it. Shippers with a matching load are being notified.');
      addTruckForm.style.display = 'none';
      showAddTruckBtn.style.display = 'inline-flex';
      ['truckVehicleNumber', 'truckBodyType', 'truckLocation'].forEach((id) => { document.getElementById(id).value = ''; });
      document.getElementById('truckCapacity').value = '';
      truckDocPath.value = ''; truckDocHint.textContent = '';
      loadTrucks();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  let allTrucks = [];
  let allDrivers = [];

  function renderTruckCard(t) {
    const driver = allDrivers.find((d) => d.id === t.assignedDriverId);
    return `
      <div class="fleet-card">
        <div>
          <div class="fleet-card-main">${t.vehicleNumber} — ${t.truckType}</div>
          <div class="fleet-card-sub">${t.capacityTons} tons${t.bodyType ? ' · ' + t.bodyType : ''}${t.currentLocation ? ' · ' + t.currentLocation : ''}</div>
          <div class="fleet-card-sub">${driver ? 'Driver: ' + driver.name : 'No driver assigned yet'}</div>
        </div>
        <div class="fleet-card-actions">
          <span class="fleet-pill ${t.verified ? 'verified' : 'pending'}">${t.verified ? 'Verified' : 'Pending verification'}</span>
          <span class="fleet-pill ${t.status}">${t.status.replace('_', ' ')}</span>
          <button type="button" class="fleet-link-btn" data-assign="${t.id}">${driver ? 'Change driver' : 'Assign driver'}</button>
        </div>
      </div>`;
  }

  function renderTrucks() {
    const wrap = document.getElementById('trucksListWrap');
    if (!allTrucks.length) {
      wrap.innerHTML = '<div class="empty-state">No trucks added yet. Use "+ Add a truck" above to onboard your first one.</div>';
      return;
    }
    wrap.innerHTML = allTrucks.map(renderTruckCard).join('');
    wrap.querySelectorAll('[data-assign]').forEach((btn) => {
      btn.addEventListener('click', () => openAssignModal(btn.getAttribute('data-assign')));
    });
  }

  function loadTrucks() {
    fetch('/api/carrier/trucks')
      .then((res) => res.json())
      .then((data) => { allTrucks = data; renderTrucks(); })
      .catch(() => showError('Could not load your trucks.'));
  }

  // ==================== DRIVERS ====================
  const showAddDriverBtn = document.getElementById('showAddDriverBtn');
  const addDriverForm = document.getElementById('addDriverForm');
  showAddDriverBtn.addEventListener('click', () => { addDriverForm.style.display = 'block'; showAddDriverBtn.style.display = 'none'; });
  document.getElementById('cancelDriverBtn').addEventListener('click', () => { addDriverForm.style.display = 'none'; showAddDriverBtn.style.display = 'inline-flex'; });

  document.getElementById('saveDriverBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('driverFormError');
    errEl.textContent = '';
    const name = document.getElementById('driverName').value.trim();
    const mobileNumber = document.getElementById('driverMobile').value.trim();
    const licenseNumber = document.getElementById('driverLicense').value.trim();
    const licenseExpiry = document.getElementById('driverLicenseExpiry').value;
    if (!name || !mobileNumber || !licenseNumber || !licenseExpiry) {
      errEl.textContent = 'Please fill in all fields.';
      return;
    }
    try {
      const res = await fetch('/api/carrier/drivers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mobileNumber, licenseNumber, licenseExpiry }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add that driver.');
      if (window.LS && LS.showSuccess) LS.showSuccess('Driver added! They can log in at /driver/login with their mobile number once verified by Admin.');
      addDriverForm.style.display = 'none';
      showAddDriverBtn.style.display = 'inline-flex';
      ['driverName', 'driverMobile', 'driverLicense', 'driverLicenseExpiry'].forEach((id) => { document.getElementById(id).value = ''; });
      loadDrivers();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  function renderDriverCard(d) {
    return `
      <div class="fleet-card">
        <div>
          <div class="fleet-card-main">${d.name}</div>
          <div class="fleet-card-sub">${d.mobileNumber} · Licence ${d.licenseNumber}</div>
          <div class="fleet-card-sub">Licence expiry: ${new Date(d.licenseExpiry).toLocaleDateString('en-IN')}</div>
        </div>
        <div class="fleet-card-actions">
          <span class="fleet-pill ${d.verified ? 'verified' : 'pending'}">${d.verified ? 'Verified' : 'Pending verification'}</span>
          <span class="fleet-pill ${d.status}">${d.status.replace('_', ' ')}</span>
        </div>
      </div>`;
  }

  function renderDrivers() {
    const wrap = document.getElementById('driversListWrap');
    if (!allDrivers.length) {
      wrap.innerHTML = '<div class="empty-state">No drivers added yet. Use "+ Add a driver" above to onboard your first one.</div>';
      return;
    }
    wrap.innerHTML = allDrivers.map(renderDriverCard).join('');
  }

  function loadDrivers() {
    fetch('/api/carrier/drivers')
      .then((res) => res.json())
      .then((data) => { allDrivers = data; renderDrivers(); renderTrucks(); })
      .catch(() => showError('Could not load your drivers.'));
  }

  // ==================== Assign driver modal ====================
  const assignModalOverlay = document.getElementById('assignModalOverlay');
  let assignTargetTruckId = null;
  function openAssignModal(truckId) {
    assignTargetTruckId = truckId;
    const truck = allTrucks.find((t) => t.id === truckId);
    document.getElementById('assignModalTruckLabel').textContent = truck ? `${truck.vehicleNumber} — ${truck.truckType}` : '';
    const select = document.getElementById('assignDriverSelect');
    const availableDrivers = allDrivers.filter((d) => !d.assignedTruckId || d.assignedTruckId === truckId);
    select.innerHTML = availableDrivers.length
      ? availableDrivers.map((d) => `<option value="${d.id}">${d.name} — ${d.mobileNumber}${d.verified ? '' : ' (unverified)'}</option>`).join('')
      : '<option value="">No drivers available to assign</option>';
    document.getElementById('assignModalError').textContent = '';
    assignModalOverlay.classList.add('show');
  }
  document.getElementById('assignModalCloseBtn').addEventListener('click', () => assignModalOverlay.classList.remove('show'));
  assignModalOverlay.addEventListener('click', (e) => { if (e.target === assignModalOverlay) assignModalOverlay.classList.remove('show'); });

  document.getElementById('assignModalConfirmBtn').addEventListener('click', async () => {
    const driverId = document.getElementById('assignDriverSelect').value;
    const errEl = document.getElementById('assignModalError');
    if (!driverId) { errEl.textContent = 'No driver selected.'; return; }
    try {
      const res = await fetch(`/api/carrier/trucks/${assignTargetTruckId}/assign-driver`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driverId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not assign that driver.');
      assignModalOverlay.classList.remove('show');
      if (window.LS && LS.showSuccess) LS.showSuccess('Driver assigned to truck!');
      loadTrucks();
      loadDrivers();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  loadDrivers();
  loadTrucks();
