  // ---- Dark / Light mode toggle (shared with the rest of the shipper portal) ----
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

  const errorBanner = document.getElementById('errorBanner');
  const successBanner = document.getElementById('successBanner');
  function showError(msg) {
    successBanner.style.display = 'none';
    errorBanner.textContent = msg;
    errorBanner.style.display = 'block';
    errorBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function showSuccess(msg) {
    errorBanner.style.display = 'none';
    successBanner.innerHTML = msg;
    successBanner.style.display = 'block';
  }
  function clearBanners() {
    errorBanner.style.display = 'none';
    successBanner.style.display = 'none';
  }
  function formatINR(n) {
    return '₹' + Number(n).toLocaleString('en-IN');
  }
  function getAssignmentMode() {
    const el = document.querySelector('input[name="assignmentMode"]:checked');
    return el ? el.value : 'bidding';
  }

  const materialSelect = document.getElementById('material');
  const weightInput = document.getElementById('weight');
  const distanceInput = document.getElementById('distanceKm');
  const distanceHint = document.getElementById('distanceHint');

  const pickupStateSelect = document.getElementById('pickupState');
  const pickupDistrictSelect = document.getElementById('pickupDistrict');
  const destStateSelect = document.getElementById('destState');
  const destDistrictSelect = document.getElementById('destDistrict');
  const pickupAddressInput = document.getElementById('pickupAddress');
  const destAddressInput = document.getElementById('destAddress');

  // ---- State → District selectors, populated from the shared dataset ----
  let statesData = null;
  function populateStateSelect(select) {
    Object.keys(statesData).sort().forEach((state) => {
      const opt = document.createElement('option');
      opt.value = state;
      opt.textContent = state;
      select.appendChild(opt);
    });
  }
  function wireStateDistrict(stateSelect, districtSelect) {
    stateSelect.addEventListener('change', () => {
      districtSelect.innerHTML = '<option value="">Select District</option>';
      const districts = statesData[stateSelect.value] || [];
      districts.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        districtSelect.appendChild(opt);
      });
      districtSelect.disabled = !stateSelect.value;
      districtSelect.value = '';
      maybeAutoCalculateDistance();
    });
    districtSelect.addEventListener('change', maybeAutoCalculateDistance);
  }

  fetch('/assets/india-states-districts.json')
    .then((res) => res.json())
    .then((data) => {
      statesData = data;
      populateStateSelect(pickupStateSelect);
      populateStateSelect(destStateSelect);
      wireStateDistrict(pickupStateSelect, pickupDistrictSelect);
      wireStateDistrict(destStateSelect, destDistrictSelect);
    })
    .catch(() => {
      distanceHint.textContent = 'Could not load the state/district list. Please refresh the page.';
      distanceHint.style.color = 'var(--danger)';
    });

  function pickupValue() {
    return pickupDistrictSelect.value ? `${pickupDistrictSelect.value}, ${pickupStateSelect.value}` : '';
  }
  function destinationValue() {
    return destDistrictSelect.value ? `${destDistrictSelect.value}, ${destStateSelect.value}` : '';
  }

  // ---- Automatic distance calculation — fires as soon as both a pickup
  // and destination district are selected, and again any time either one
  // changes. No "Calculate" button; reuses the same free geocoding lookup
  // the address/PIN-code feature uses elsewhere in the app. ----
  let distanceRequestSeq = 0;
  async function maybeAutoCalculateDistance() {
    const pickup = pickupValue();
    const destination = destinationValue();
    distanceInput.value = '';
    if (!pickup || !destination) {
      distanceHint.textContent = 'Select both locations to calculate distance automatically.';
      distanceHint.style.color = '';
      return;
    }
    if (pickup === destination) {
      distanceHint.textContent = 'Pickup and destination can\'t be the same location.';
      distanceHint.style.color = 'var(--danger)';
      return;
    }
    const seq = ++distanceRequestSeq;
    distanceHint.innerHTML = '<span class="ls-spinner" style="vertical-align:middle; margin-right:6px;"></span>Calculating distance…';
    distanceHint.style.color = '';
    try {
      const res = await fetch('/api/estimate/distance?pickup=' + encodeURIComponent(pickup) + '&destination=' + encodeURIComponent(destination));
      const data = await res.json();
      if (seq !== distanceRequestSeq) return; // a newer selection superseded this request
      if (!res.ok) throw new Error(data.error || 'Could not calculate distance.');
      distanceInput.value = data.distanceKm;
      distanceHint.textContent = 'Distance: ' + data.distanceKm + ' km (calculated automatically).';
      distanceHint.style.color = 'var(--green-deep)';
    } catch (err) {
      if (seq !== distanceRequestSeq) return;
      distanceHint.textContent = err.message;
      distanceHint.style.color = 'var(--danger)';
    }
  }

  let currentEstimate = null; // { pickup, destination, pickupAddress, destAddress, distanceKm, material, weight, estimatedRate, minAllowedRate }
  let requiredTruckType = '';

  // ================= WIZARD NAVIGATION =================
  const stepCards = { 1: document.getElementById('stepPickup'), 2: document.getElementById('stepDelivery'), 3: document.getElementById('stepLoad'), 4: document.getElementById('stepTruck') };
  function goToStep(n) {
    Object.keys(stepCards).forEach((k) => { stepCards[k].style.display = (Number(k) === n) ? 'block' : 'none'; });
    document.querySelectorAll('.wiz-step').forEach((el) => {
      const s = Number(el.getAttribute('data-step'));
      el.classList.toggle('active', s === n);
      el.classList.toggle('done', s < n);
    });
    document.getElementById('wizard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  document.querySelectorAll('.wiz-next').forEach((btn) => {
    btn.addEventListener('click', () => {
      clearBanners();
      const current = btn.closest('.wiz-card');
      if (current.id === 'stepPickup') {
        if (!pickupValue()) return showError('Select a pickup state and district.');
        if (!pickupAddressInput.value.trim()) return showError('Enter the full pickup address.');
      }
      if (current.id === 'stepDelivery') {
        if (!destinationValue()) return showError('Select a delivery state and district.');
        if (!destAddressInput.value.trim()) return showError('Enter the full delivery address.');
        if (!distanceInput.value || Number(distanceInput.value) <= 0) return showError('Distance is still being calculated — please wait a moment.');
      }
      if (current.id === 'stepLoad') {
        if (!weightInput.value || Number(weightInput.value) <= 0) return showError('Enter a valid cargo weight.');
      }
      goToStep(Number(btn.getAttribute('data-next')));
    });
  });
  document.querySelectorAll('.wiz-back').forEach((btn) => {
    btn.addEventListener('click', () => { clearBanners(); goToStep(Number(btn.getAttribute('data-back'))); });
  });

  // ---- Truck type picker ----
  const truckTypeGrid = document.getElementById('truckTypeGrid');
  const otherTruckTypeField = document.getElementById('otherTruckTypeField');
  const otherTruckTypeInput = document.getElementById('otherTruckType');
  truckTypeGrid.querySelectorAll('.truck-type-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      truckTypeGrid.querySelectorAll('.truck-type-opt').forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
      const val = opt.getAttribute('data-value');
      if (val === '__other') {
        otherTruckTypeField.style.display = 'flex';
        requiredTruckType = otherTruckTypeInput.value.trim();
      } else {
        otherTruckTypeField.style.display = 'none';
        requiredTruckType = val;
      }
    });
  });
  otherTruckTypeInput.addEventListener('input', () => { requiredTruckType = otherTruckTypeInput.value.trim(); });
  // "Any Suitable Truck" selected by default
  truckTypeGrid.querySelector('.truck-type-opt[data-value=""]').classList.add('selected');

  // ================= FIND BEST TRUCK (AI matching) =================
  function hideAllResultCards() {
    document.getElementById('aiMatchingCard').style.display = 'none';
    document.getElementById('aiRecommendCard').style.display = 'none';
    document.getElementById('noMatchCard').style.display = 'none';
    document.getElementById('submittedCard').style.display = 'none';
  }

  const matchingSteps = ['Analyzing available trucks…', 'Checking driver availability…', 'Verifying documents & compliance…', 'Calculating best match…'];

  document.getElementById('findMatchBtn').addEventListener('click', async () => {
    clearBanners();
    const pickup = pickupValue();
    const destination = destinationValue();
    if (!pickup || !destination || !distanceInput.value) return showError('Please complete the pickup and delivery steps first.');
    if (!weightInput.value || Number(weightInput.value) <= 0) return showError('Enter a valid cargo weight.');

    document.getElementById('wizard').style.display = 'none';
    hideAllResultCards();
    const aiCard = document.getElementById('aiMatchingCard');
    aiCard.style.display = 'block';
    aiCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const stepEl = document.getElementById('aiMatchingStep');
    let stepIdx = 0;
    stepEl.textContent = matchingSteps[0];
    const stepTimer = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, matchingSteps.length - 1);
      stepEl.textContent = matchingSteps[stepIdx];
    }, 550);

    try {
      const [calcRes] = await Promise.all([
        fetch('/api/estimate/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ distanceKm: Number(distanceInput.value), material: materialSelect.value, weight: Number(weightInput.value) }),
        }),
        new Promise((r) => setTimeout(r, 1900)), // let the animation play out — feels intentional, not instant
      ]);
      const calcData = await calcRes.json();
      if (!calcRes.ok) throw new Error(calcData.error || 'Could not calculate estimate.');

      currentEstimate = {
        pickup, destination,
        pickupAddress: pickupAddressInput.value.trim(),
        destAddress: destAddressInput.value.trim(),
        distanceKm: calcData.distanceKm,
        material: calcData.material,
        weight: calcData.weight,
        estimatedRate: calcData.estimatedRate,
        minAllowedRate: calcData.minAllowedRate,
      };

      const matchRes = await fetch('/api/estimate/match-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickup, weight: calcData.weight, requiredTruckType }),
      });
      const matchData = await matchRes.json();
      clearInterval(stepTimer);
      if (!matchRes.ok) throw new Error(matchData.error || 'Could not run AI matching.');

      hideAllResultCards();
      if (matchData.matched) {
        renderRecommendation(matchData);
      } else {
        document.getElementById('noMatchReason').textContent = matchData.reason || 'LoadSmart couldn\'t find a truck that meets all requirements right now.';
        document.getElementById('noMatchCard').style.display = 'block';
        document.getElementById('noMatchCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (err) {
      clearInterval(stepTimer);
      document.getElementById('wizard').style.display = 'block';
      hideAllResultCards();
      showError(err.message);
    }
  });

  function renderRecommendation(matchData) {
    document.getElementById('matchScoreValue').textContent = matchData.matchScore + '%';
    document.getElementById('matchScoreRing').style.background =
      `conic-gradient(var(--orange) 0deg ${matchData.matchScore * 3.6}deg, var(--line) ${matchData.matchScore * 3.6}deg 360deg)`;
    document.getElementById('recTruckNo').textContent = matchData.truck.vehicleNumber || '—';
    document.getElementById('recDriverName').textContent = matchData.driver.name || '—';
    document.getElementById('recCapacity').textContent = matchData.truck.capacityTons ? matchData.truck.capacityTons + ' Ton' : '—';
    document.getElementById('recLocation').textContent = matchData.truck.currentLocation || 'Nearby';
    const list = document.getElementById('whyMatchList');
    list.innerHTML = (matchData.reasons || []).map((r) => `<li>${r}</li>`).join('');
    document.getElementById('estAmountValue').textContent = currentEstimate ? formatINR(currentEstimate.estimatedRate) : '—';
    const altNote = document.getElementById('altCountNote');
    altNote.textContent = matchData.alternateCount > 0
      ? `${matchData.alternateCount} other eligible truck${matchData.alternateCount === 1 ? '' : 's'} also considered — this was the best match.`
      : 'This was the only eligible truck available right now.';
    document.getElementById('aiRecommendCard').style.display = 'block';
    document.getElementById('aiRecommendCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.getElementById('backFromRecommendBtn').addEventListener('click', () => {
    hideAllResultCards();
    document.getElementById('wizard').style.display = 'block';
    goToStep(4);
  });

  // ---- Request Admin Approval → creates the booking (existing pipeline
  // handles matching/assignment server-side exactly as before). ----
  async function submitLoad() {
    if (!currentEstimate) return;
    try {
      const assignmentMode = getAssignmentMode();
      const payload = { ...currentEstimate, requiredTruckType, assignmentMode };
      if (assignmentMode === 'bidding') payload.biddingWindowHours = 48;
      const res = await fetch('/api/estimate/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create booking.');
      if (window.LS && LS.Track) LS.Track.log('LOAD_POST_INTERACTION', 'LOAD_POSTED');
      showSubmitted(data);
    } catch (err) {
      showError(err.message);
    }
  }
  document.getElementById('requestApprovalBtn').addEventListener('click', submitLoad);
  document.getElementById('postAnywayBtn').addEventListener('click', submitLoad);

  function showSubmitted(data) {
    hideAllResultCards();
    const tokenHtml = data.tokenNo ? ` Token No. <b>${data.tokenNo}</b> ${LS.copyBtnHtml ? LS.copyBtnHtml(data.tokenNo) : ''}` : '';
    document.getElementById('submittedNote').innerHTML = 'Your load has been posted and sent for admin review.' + tokenHtml;
    const stages = ['Load Posted', 'AI Matching', 'AI Recommended', 'Admin Approval', 'Truck Assigned', 'In Transit', 'Delivered'];
    const timeline = document.getElementById('statusTimeline');
    timeline.innerHTML = stages.map((s, i) => `<span class="status-pill ${i === 0 ? 'done' : (i === 3 ? 'current' : '')}">${s}</span>`).join('');
    document.getElementById('submittedCard').style.display = 'block';
    document.getElementById('submittedCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Spec: never claim an email was "sent" synchronously — the actual
    // send happens on a background queue/worker after this response. The
    // load itself IS confirmed saved (that's what unlocked this screen),
    // so it's honest to say matching carriers are being notified.
    if (window.LS && LS.showSuccess) LS.showSuccess('Load posted successfully. Matching carriers are being notified.', { sub: data.tokenNo ? 'Token No. ' + data.tokenNo : '' });
  }

  document.getElementById('postAnotherBtn').addEventListener('click', () => {
    currentEstimate = null;
    requiredTruckType = '';
    truckTypeGrid.querySelectorAll('.truck-type-opt').forEach((o) => o.classList.remove('selected'));
    truckTypeGrid.querySelector('.truck-type-opt[data-value=""]').classList.add('selected');
    otherTruckTypeField.style.display = 'none';
    otherTruckTypeInput.value = '';
    weightInput.value = ''; document.getElementById('quantity').value = ''; document.getElementById('specialRequirements').value = '';
    pickupAddressInput.value = ''; destAddressInput.value = '';
    pickupStateSelect.value = ''; pickupDistrictSelect.innerHTML = '<option value="">Select District</option>'; pickupDistrictSelect.disabled = true;
    destStateSelect.value = ''; destDistrictSelect.innerHTML = '<option value="">Select District</option>'; destDistrictSelect.disabled = true;
    hideAllResultCards();
    document.getElementById('wizard').style.display = 'block';
    goToStep(1);
    clearBanners();
  });

  // ================= LEGACY: negotiate manually (kept fully working) =================
  function showLegacyFlow() {
    document.getElementById('wizard').style.display = 'none';
    hideAllResultCards();
    document.getElementById('legacyFlow').style.display = 'block';
    if (currentEstimate) {
      openLegacyResultOrListing();
    } else if (pickupValue() && destinationValue() && distanceInput.value) {
      // Compute an estimate first from whatever's already filled in.
      fetch('/api/estimate/calculate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ distanceKm: Number(distanceInput.value), material: materialSelect.value, weight: Number(weightInput.value || 1) }),
      }).then((r) => r.json()).then((data) => {
        if (data.estimatedRate) {
          currentEstimate = {
            pickup: pickupValue(), destination: destinationValue(),
            pickupAddress: pickupAddressInput.value.trim(), destAddress: destAddressInput.value.trim(),
            distanceKm: data.distanceKm, material: data.material, weight: data.weight,
            estimatedRate: data.estimatedRate, minAllowedRate: data.minAllowedRate,
          };
          renderLegacyResult(data);
        } else {
          document.getElementById('listingCard').style.display = 'block';
          loadProviders();
        }
      }).catch(() => { document.getElementById('listingCard').style.display = 'block'; loadProviders(); });
    } else {
      document.getElementById('listingCard').style.display = 'block';
      loadProviders();
    }
    document.getElementById('legacyFlow').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function openLegacyResultOrListing() {
    renderLegacyResult({ distanceKm: currentEstimate.distanceKm, material: currentEstimate.material, weight: currentEstimate.weight, estimatedRate: currentEstimate.estimatedRate, rateChart: [] });
  }
  function renderLegacyResult(data) {
    document.getElementById('resDistance').textContent = data.distanceKm + ' km';
    document.getElementById('resMaterial').textContent = data.material;
    document.getElementById('resWeight').textContent = data.weight + ' tons';
    document.getElementById('resRate').textContent = formatINR(data.estimatedRate);
    const table = document.getElementById('rateChartTable');
    if (data.rateChart && data.rateChart.length) {
      let html = '<thead><tr><th>Distance</th><th>Material</th><th>Load</th><th>Estimated Rate</th></tr></thead><tbody>';
      data.rateChart.forEach(row => {
        const isCurrent = row.distanceKm === data.distanceKm;
        html += `<tr class="${isCurrent ? 'current-row' : ''}"><td>${row.distanceKm} km</td><td>${data.material}</td><td>${data.weight} tons</td><td>${formatINR(row.estimatedRate)}</td></tr>`;
      });
      html += '</tbody>';
      table.innerHTML = html;
    }
    document.getElementById('resultCard').style.display = 'block';
    document.getElementById('listingCard').style.display = 'none';
    document.getElementById('rateReqCard').style.display = 'none';
  }

  document.getElementById('negotiateInsteadLink').addEventListener('click', (e) => { e.preventDefault(); showLegacyFlow(); });
  document.getElementById('negotiateInsteadLink2').addEventListener('click', (e) => { e.preventDefault(); showLegacyFlow(); });
  document.getElementById('backToAiFlowLink').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('legacyFlow').style.display = 'none';
    document.getElementById('resultCard').style.display = 'none';
    document.getElementById('listingCard').style.display = 'none';
    document.getElementById('rateReqCard').style.display = 'none';
    document.getElementById('wizard').style.display = 'block';
  });

  document.getElementById('bookNowBtn').addEventListener('click', async () => {
    if (!currentEstimate) return;
    try {
      const assignmentMode = getAssignmentMode();
      const bookNowPayload = { ...currentEstimate, assignmentMode };
      if (assignmentMode === 'bidding') bookNowPayload.biddingWindowHours = 48;
      const res = await fetch('/api/estimate/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookNowPayload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create booking.');
      const tokenHtml = data.tokenNo ? ` Your Token No. is <b>${data.tokenNo}</b> ${LS.copyBtnHtml(data.tokenNo)} — save this to track your shipment.` : '';
      showSuccess('Booking created — reference ' + data.id + '.' + tokenHtml + ' Our team will be in touch to confirm.');
      if (window.LS && LS.showSuccess) LS.showSuccess('Booking created successfully. Matching carriers are being notified.', { sub: data.tokenNo ? 'Token No. ' + data.tokenNo : '' });
      document.getElementById('resultCard').style.display = 'none';
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById('cancelBtn').addEventListener('click', () => {
    document.getElementById('resultCard').style.display = 'none';
    document.getElementById('listingCard').style.display = 'none';
    document.getElementById('rateReqCard').style.display = 'none';
    clearBanners();
  });

  // ---- Rate Request Listing: pick a carrier/broker before naming a rate ----
  let selectedProvider = null; // { role, username, companyName } | null
  let providersLoaded = false;

  function renderProviderList(data) {
    const wrap = document.getElementById('providerListWrap');
    const all = [...data.carriers.map(p => ({ ...p, role: 'carrier' })), ...data.brokers.map(p => ({ ...p, role: 'broker' }))];
    if (!all.length) {
      wrap.innerHTML = '<div class="empty-state" style="text-align:center; padding:24px; color:#7a867e; font-size:13.5px;">No carriers or brokers are registered yet. Continue without selecting — admin will assign one after reviewing your request.</div>';
      return;
    }
    wrap.innerHTML = '<div class="provider-list">' + all.map((p, i) => `
      <div class="provider-card" data-idx="${i}">
        <div class="info">
          <div class="name-row">
            <span class="name">${p.companyName}</span>
            <span class="provider-role-badge ${p.role}">${p.role === 'carrier' ? 'Carrier' : 'Broker'}</span>
            <span class="provider-status-badge">Available</span>
          </div>
          <div class="provider-meta-row">
            <span>Route: <b>${currentEstimate ? currentEstimate.pickup + ' → ' + currentEstimate.destination : '—'}</b></span>
            ${p.vehicleCapacity ? `<span>Load capacity: <b>${p.vehicleCapacity} tons</b></span>` : ''}
            ${p.phoneNumber ? `<span>Contact: <b>${p.phoneNumber}</b></span>` : ''}
          </div>
        </div>
        <button type="button" class="select-btn" data-idx="${i}">Select</button>
      </div>
    `).join('') + '</div>';

    wrap.querySelectorAll('.select-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = all[Number(btn.getAttribute('data-idx'))];
        selectedProvider = p;
        wrap.querySelectorAll('.provider-card').forEach((c) => c.classList.remove('selected'));
        wrap.querySelector('.provider-card[data-idx="' + btn.getAttribute('data-idx') + '"]').classList.add('selected');
        openRateReqCard();
      });
    });
  }

  function loadProviders() {
    if (providersLoaded) return;
    const status = document.getElementById('listingSearchStatus');
    status.classList.add('show');
    fetch('/api/estimate/providers')
      .then(res => res.json())
      .then(data => {
        providersLoaded = true;
        renderProviderList(data);
      })
      .catch(() => {
        document.getElementById('providerListWrap').innerHTML = '<div class="empty-state" style="text-align:center; padding:24px; color:#7a867e; font-size:13.5px;">Could not load carriers/brokers right now. You can continue without selecting.</div>';
      })
      .finally(() => status.classList.remove('show'));
  }

  document.getElementById('cancelListingBtn').addEventListener('click', () => {
    document.getElementById('listingCard').style.display = 'none';
  });

  document.getElementById('continueWithoutProviderBtn').addEventListener('click', () => {
    selectedProvider = null;
    openRateReqCard();
  });

  function openRateReqCard() {
    if (!currentEstimate) return;
    const rateInput = document.getElementById('requestedRate');
    rateInput.value = '';

    const noteEl = document.getElementById('selectedProviderNote');
    if (selectedProvider) {
      noteEl.style.display = 'flex';
      noteEl.className = 'selected-provider-note';
      noteEl.innerHTML = `<span>Requesting from <b>${selectedProvider.companyName}</b> (${selectedProvider.role === 'carrier' ? 'Carrier' : 'Broker'})</span><button type="button" id="changeProviderBtn">Change</button>`;
      document.getElementById('changeProviderBtn').addEventListener('click', () => {
        document.getElementById('rateReqCard').style.display = 'none';
        document.getElementById('listingCard').style.display = 'block';
      });
    } else {
      noteEl.style.display = 'none';
    }

    document.getElementById('listingCard').style.display = 'none';
    document.getElementById('rateReqCard').style.display = 'block';
    document.getElementById('rateReqCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    rateInput.focus();
  }

  document.getElementById('cancelRateReqBtn').addEventListener('click', () => {
    document.getElementById('rateReqCard').style.display = 'none';
  });

  document.getElementById('submitRateReqBtn').addEventListener('click', async () => {
    if (!currentEstimate) return;
    const requested = Number(document.getElementById('requestedRate').value);
    if (!document.getElementById('requestedRate').value.trim() || !requested || requested <= 0) {
      return showError('Enter a valid rate greater than zero.');
    }
    try {
      const assignmentMode = getAssignmentMode();
      const payload = { ...currentEstimate, requestedRate: requested, assignmentMode };
      if (assignmentMode === 'bidding') payload.biddingWindowHours = 48;
      if (selectedProvider) payload[selectedProvider.role + 'Username'] = selectedProvider.username;
      const res = await fetch('/api/estimate/rate-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit rate request.');
      const tokenHtml = data.tokenNo ? ` Your Token No. is <b>${data.tokenNo}</b> ${LS.copyBtnHtml(data.tokenNo)}.` : '';
      showSuccess('Rate request sent — reference ' + data.id + '.' + tokenHtml + ' The admin team will review it shortly. You can track its status any time from the Request tab.');
      if (window.LS && LS.showSuccess) LS.showSuccess('Rate request submitted successfully!', { sub: data.tokenNo ? 'Token No. ' + data.tokenNo : '' });
      if (window.LS && LS.Track) LS.Track.log('RATE_REQUEST_INTERACTION', 'RATE_REQUEST_SUBMITTED');
      document.getElementById('rateReqCard').style.display = 'none';
      document.getElementById('listingCard').style.display = 'none';
      document.getElementById('resultCard').style.display = 'none';
    } catch (err) {
      showError(err.message);
    }
  });
