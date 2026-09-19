  const token = sessionStorage.getItem('ls_driver_token');
  if (!token) { window.location.href = '/driver/login'; }

  document.getElementById('driverNameLabel').textContent = sessionStorage.getItem('ls_driver_name') || 'Driver';
  document.getElementById('logoutBtn').addEventListener('click', () => {
    stopGpsWatch();
    sessionStorage.removeItem('ls_driver_token');
    sessionStorage.removeItem('ls_driver_name');
    window.location.href = '/driver/login';
  });
  if (window.LSNotifBell) LSNotifBell.init({ tokenKey: 'ls_driver_token', mountSelector: '#notifBellMount' });

  function driverFetch(url, options = {}) {
    const headers = Object.assign({}, options.headers, { Authorization: 'Bearer ' + token });
    return fetch(url, Object.assign({}, options, { headers }));
  }
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const STAGE_LABELS = {
    POSTED: 'Waiting for match', MATCHED: 'Matched', ASSIGNED: 'New load offered to you',
    DRIVER_ACCEPTED: 'Accepted — head to pickup', ARRIVED_PICKUP: 'Arrived at pickup',
    LOADING: 'Loading in progress', LOADED: 'Loaded — ready to depart',
    DEPARTED_PICKUP: 'Departed pickup location',
    IN_TRANSIT: 'In transit — tracking live', REACHED_DESTINATION: 'Reached destination',
    UNLOADING: 'Unloading', UNLOADING_COMPLETE: 'Unloading completed — confirm delivery',
    DELIVERED: 'Delivered', DRIVER_REJECTED: 'Rejected', COMPLETED: 'Completed',
  };

  // Every stage's single "move it forward" button — 'deliver' opens the
  // delivery-confirmation form below instead of firing immediately (spec
  // section 11: delivery confirmation, receiver info and date are captured
  // before the load can become Delivered).
  const NEXT_ACTION = {
    ASSIGNED: { action: 'accept', label: 'Accept load' },
    DRIVER_ACCEPTED: { action: 'arrived', label: "I've arrived at pickup" },
    ARRIVED_PICKUP: { action: 'start_loading', label: 'Start loading' },
    LOADING: { action: 'loaded', label: 'Mark as loaded' },
    LOADED: { action: 'depart', label: 'Departed pickup location' },
    DEPARTED_PICKUP: { action: 'start_trip', label: 'Start trip (begin live tracking)' },
    IN_TRANSIT: { action: 'reach_destination', label: "I've reached the destination" },
    REACHED_DESTINATION: { action: 'start_unloading', label: 'Start unloading' },
    UNLOADING: { action: 'complete_unloading', label: 'Mark unloading completed' },
    UNLOADING_COMPLETE: { action: 'deliver', label: 'Mark as Delivered', opensForm: 'deliver' },
  };
  // Stages where the driver can still add a checkpoint / report a delay —
  // any point after the trip has actually begun, up to (not including)
  // Delivered.
  const TRACKABLE_STAGES = ['ARRIVED_PICKUP', 'LOADING', 'LOADED', 'DEPARTED_PICKUP', 'IN_TRANSIT', 'REACHED_DESTINATION', 'UNLOADING', 'UNLOADING_COMPLETE'];

  // Best-effort, non-blocking GPS capture for a milestone update (spec:
  // "Save GPS/location if browser/device permission is available... If
  // location permission is unavailable, the status update must still
  // work. Do not make GPS mandatory.") — races a one-shot
  // getCurrentPosition() against a short timeout so a denied/slow/missing
  // permission NEVER delays or blocks the actual status update; resolves
  // to null rather than rejecting in every failure case.
  const MILESTONE_GPS_TIMEOUT_MS = 4000;
  function getMilestoneLocationBestEffort() {
    return new Promise((resolve) => {
      if (!navigator.geolocation || !window.isSecureContext) { resolve(null); return; }
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, MILESTONE_GPS_TIMEOUT_MS);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } },
        { enableHighAccuracy: false, maximumAge: 60000, timeout: MILESTONE_GPS_TIMEOUT_MS }
      );
    });
  }

  let currentLoad = null;
  let gpsWatchId = null;
  let gpsIntervalId = null;
  let openForm = null; // null | 'deliver' | 'checkpoint' | 'delay' | 'pod'

  function render(data) {
    const content = document.getElementById('driverContent');
    currentLoad = data.load;
    if (!data.load) {
      content.innerHTML = '<div class="driver-card"><div class="driver-empty">No load assigned right now.<br>You\'ll see it here the moment one is matched to you.</div></div>';
      stopGpsWatch();
      return;
    }
    const l = data.load;
    const t = data.truck;
    const stageLabel = STAGE_LABELS[l.loadStage] || l.loadStage;
    const next = NEXT_ACTION[l.loadStage];
    const delayActive = l.delay && l.delay.active;

    content.innerHTML = `
      <div class="driver-card">
        <span class="driver-stage-pill">${escapeHtml(stageLabel)}</span>
        <div class="driver-route">${escapeHtml(l.pickup)} → ${escapeHtml(l.destination)}</div>
        <div class="driver-token">Token No. ${escapeHtml(l.tokenNo)}</div>
        ${delayActive ? `<div class="driver-delay-banner">⚠️ You reported a delay: ${escapeHtml(l.delay.reason || '')}${l.delay.currentLocation ? ' — ' + escapeHtml(l.delay.currentLocation) : ''}</div>` : ''}
        <div class="driver-info-row"><span class="k">Material</span><span class="v">${escapeHtml(l.material || '—')}</span></div>
        <div class="driver-info-row"><span class="k">Weight</span><span class="v">${l.weight != null ? l.weight + ' tons' : '—'}</span></div>
        <div class="driver-info-row"><span class="k">Truck</span><span class="v">${t ? escapeHtml(t.vehicleNumber) + ' (' + escapeHtml(t.truckType) + ')' : '—'}</span></div>
        <div class="driver-info-row"><span class="k">Shipper</span><span class="v">${escapeHtml(l.companyName || '—')}</span></div>

        ${l.loadStage === 'ASSIGNED' ? `
          <div class="driver-action-row">
            <button type="button" class="driver-action-btn" id="acceptBtn" style="flex:2;">Accept load</button>
            <button type="button" class="driver-action-btn danger" id="rejectBtn" style="flex:1;">Reject</button>
          </div>
          <div class="driver-form" id="rejectForm" style="display:none;">
            <label for="rejectReasonInput">Reason (optional)</label>
            <textarea id="rejectReasonInput" placeholder="Why are you rejecting this load?"></textarea>
            <button type="button" class="driver-action-btn danger small" id="rejectSubmitBtn">Confirm rejection</button>
          </div>
        ` : ''}

        ${(next && next.action !== 'deliver') ? `<button type="button" class="driver-action-btn" id="nextActionBtn">${next.label}</button>` : ''}
        ${l.loadStage === 'UNLOADING_COMPLETE' ? `<button type="button" class="driver-action-btn" id="openDeliverFormBtn">Mark as Delivered</button>` : ''}

        ${l.trackingSessionActive ? `
          <div class="gps-status" id="gpsStatusBlock">
            <span class="gps-dot" id="gpsDot"></span>
            <span id="gpsStatusText">Starting GPS…</span>
          </div>
          <p class="gps-substatus" id="gpsSubStatusText"></p>
        ` : ''}
        <p class="driver-error" id="actionError"></p>
      </div>

      ${l.loadStage === 'UNLOADING_COMPLETE' ? `
        <div class="driver-card" id="deliverFormCard" style="display:none;">
          <h2>Confirm delivery</h2>
          <div class="driver-form" style="border-top:none; padding-top:0;">
            <label for="receiverNameInput">Receiver name (optional)</label>
            <input type="text" id="receiverNameInput" placeholder="Who received the goods?">
            <label for="receiverPhoneInput">Receiver phone (optional)</label>
            <input type="tel" id="receiverPhoneInput" placeholder="Receiver's phone number">
            <label for="deliveryNotesInput">Delivery notes (optional)</label>
            <textarea id="deliveryNotesInput" placeholder="Anything worth noting about the delivery"></textarea>
            <button type="button" class="driver-action-btn" id="confirmDeliverBtn">Confirm &amp; mark Delivered</button>
          </div>
        </div>` : ''}

      ${TRACKABLE_STAGES.includes(l.loadStage) ? `
        <div class="driver-card">
          <h2>Update Trip</h2>
          <button type="button" class="driver-toggle-btn" id="toggleCheckpointBtn">📍 Add checkpoint / location update</button>
          <div class="driver-form" id="checkpointForm" style="display:none;">
            <label for="cpLocationInput">Current city / location</label>
            <input type="text" id="cpLocationInput" placeholder="e.g. Ludhiana, Punjab">
            <label for="cpNotesInput">Notes (optional)</label>
            <textarea id="cpNotesInput" placeholder="e.g. Vehicle stopped for inspection."></textarea>
            <div class="hint">Latitude/longitude are optional and only used if your browser shares location.</div>
            <button type="button" class="driver-action-btn small" id="cpSubmitBtn">Save checkpoint</button>
          </div>
          <button type="button" class="driver-toggle-btn" id="toggleDelayBtn">⏱️ Report a delay</button>
          <div class="driver-form" id="delayForm" style="display:none;">
            <label for="delayReasonSelect">Reason</label>
            <select id="delayReasonSelect">
              <option value="Traffic">Traffic</option>
              <option value="Vehicle breakdown">Vehicle breakdown</option>
              <option value="Weather">Weather</option>
              <option value="Road closure">Road closure</option>
              <option value="Loading delay">Loading delay</option>
              <option value="Other">Other</option>
            </select>
            <label for="delayLocationInput">Current location</label>
            <input type="text" id="delayLocationInput" placeholder="e.g. Ambala">
            <label for="delayDurationInput">Expected delay (minutes)</label>
            <input type="number" id="delayDurationInput" placeholder="e.g. 120">
            <label for="delayNotesInput">Notes (optional)</label>
            <textarea id="delayNotesInput" placeholder="Any extra detail"></textarea>
            <button type="button" class="driver-action-btn danger small" id="delaySubmitBtn">Report delay</button>
          </div>
        </div>` : ''}

      ${l.loadStage === 'DELIVERED' || l.loadStage === 'COMPLETED' ? renderPodSection(l) : ''}

      <div class="driver-card">
        <h2>Trip Timeline</h2>
        <div id="timelineList"><p class="tl-meta">Loading history…</p></div>
      </div>
    `;

    wireActions(l);
    loadTimeline(l.tokenNo, l.loadStage);
    // Tracking is active for exactly as long as the SERVER says so
    // (trackingSessionActive — true from "Start trip" through Delivered),
    // not a hardcoded loadStage check — this keeps the browser's GPS watch
    // correctly running through Reached Destination / Unloading too,
    // matching what the backend actually still accepts and stores.
    if (l.trackingSessionActive) startGpsWatch(l.tokenNo);
    else stopGpsWatch();
  }

  function renderPodSection(l) {
    const status = l.podStatus || 'pending';
    const statusLabel = { pending: 'Not uploaded', uploaded: 'Awaiting admin review', approved: 'Approved — load completed', rejected: 'Rejected — please re-upload' }[status] || status;
    // Ran automatically server-side the moment this POD photo was uploaded
    // (see server_load.js runPodAiCheck) — raw driver data (unlike the
    // admin/shipper tracking summary) leaves the subdocument's defaults in
    // place even before a check has run, so only a real `checkedAt` counts
    // as "present".
    const aiCheck = l.podAiCheck && l.podAiCheck.checkedAt ? l.podAiCheck : null;
    const aiNote = !aiCheck ? '' : aiCheck.looksValid
      ? '<p class="driver-pod-ai-note valid">✅ Looks good!</p>'
      : `<p class="driver-pod-ai-note flagged">⚠️ ${escapeHtml(aiCheck.summary || '')} — you may want to re-upload a clearer photo.</p>`;
    return `
      <div class="driver-card">
        <h2>Proof of Delivery (POD)</h2>
        <span class="driver-pod-status ${status}">${escapeHtml(statusLabel)}</span>
        ${aiNote}
        ${l.podRejectionReason ? `<p style="font-size:12.5px;color:#8a2f1f;margin-bottom:10px;">Reason: ${escapeHtml(l.podRejectionReason)}</p>` : ''}
        ${status === 'approved' ? '' : `
          <div class="driver-form" style="border-top:none;padding-top:0;">
            <label for="podFileInput">POD document / photo</label>
            <input type="file" id="podFileInput" accept="image/*,application/pdf">
            <label for="podReceiverNameInput">Receiver name (optional)</label>
            <input type="text" id="podReceiverNameInput" value="${escapeHtml(l.deliveryReceiverName || '')}">
            <label for="podNotesInput">Delivery notes (optional)</label>
            <textarea id="podNotesInput">${escapeHtml(l.deliveryNotes || '')}</textarea>
            <button type="button" class="driver-action-btn small" id="podSubmitBtn">Upload POD</button>
          </div>`}
      </div>`;
  }

  function loadTimeline(tokenNo, currentStage) {
    driverFetch('/api/loads/' + encodeURIComponent(tokenNo) + '/tracking')
      .then((r) => (r.ok ? r.json() : []))
      .then((events) => {
        const list = document.getElementById('timelineList');
        if (!list) return;
        if (window.LSTripTimeline) {
          LSTripTimeline.render(list, { currentStage, events: events || [] });
        } else {
          list.innerHTML = '<p class="tl-meta">No trip updates yet.</p>';
        }
      })
      .catch(() => {});
  }

  function wireActions(l) {
    const errEl = document.getElementById('actionError');
    const nextBtn = document.getElementById('nextActionBtn');
    if (nextBtn) nextBtn.addEventListener('click', () => runAction(NEXT_ACTION[l.loadStage].action));

    const acceptBtn = document.getElementById('acceptBtn');
    if (acceptBtn) acceptBtn.addEventListener('click', () => runAction('accept'));
    const rejectBtn = document.getElementById('rejectBtn');
    const rejectForm = document.getElementById('rejectForm');
    if (rejectBtn) rejectBtn.addEventListener('click', () => { rejectForm.style.display = rejectForm.style.display === 'none' ? 'block' : 'none'; });
    const rejectSubmitBtn = document.getElementById('rejectSubmitBtn');
    if (rejectSubmitBtn) rejectSubmitBtn.addEventListener('click', () => {
      runAction('reject', { reason: document.getElementById('rejectReasonInput').value.trim() });
    });

    const openDeliverBtn = document.getElementById('openDeliverFormBtn');
    const deliverCard = document.getElementById('deliverFormCard');
    if (openDeliverBtn) openDeliverBtn.addEventListener('click', () => { deliverCard.style.display = deliverCard.style.display === 'none' ? 'block' : 'none'; });
    const confirmDeliverBtn = document.getElementById('confirmDeliverBtn');
    if (confirmDeliverBtn) confirmDeliverBtn.addEventListener('click', () => {
      runAction('deliver', {
        confirmDelivery: true,
        receiverName: document.getElementById('receiverNameInput').value.trim(),
        receiverPhone: document.getElementById('receiverPhoneInput').value.trim(),
        deliveryNotes: document.getElementById('deliveryNotesInput').value.trim(),
      });
    });

    const toggleCp = document.getElementById('toggleCheckpointBtn');
    const cpForm = document.getElementById('checkpointForm');
    if (toggleCp) toggleCp.addEventListener('click', () => { cpForm.style.display = cpForm.style.display === 'none' ? 'block' : 'none'; });
    const cpSubmitBtn = document.getElementById('cpSubmitBtn');
    if (cpSubmitBtn) cpSubmitBtn.addEventListener('click', () => {
      const location = document.getElementById('cpLocationInput').value.trim();
      if (!location) { if (errEl) errEl.textContent = 'Please enter a location.'; return; }
      submitCheckpoint(location, document.getElementById('cpNotesInput').value.trim());
    });

    const toggleDelay = document.getElementById('toggleDelayBtn');
    const delayForm = document.getElementById('delayForm');
    if (toggleDelay) toggleDelay.addEventListener('click', () => { delayForm.style.display = delayForm.style.display === 'none' ? 'block' : 'none'; });
    const delaySubmitBtn = document.getElementById('delaySubmitBtn');
    if (delaySubmitBtn) delaySubmitBtn.addEventListener('click', () => {
      submitDelay({
        reason: document.getElementById('delayReasonSelect').value,
        currentLocation: document.getElementById('delayLocationInput').value.trim(),
        expectedDurationMinutes: document.getElementById('delayDurationInput').value.trim(),
        notes: document.getElementById('delayNotesInput').value.trim(),
      });
    });

    const podSubmitBtn = document.getElementById('podSubmitBtn');
    if (podSubmitBtn) podSubmitBtn.addEventListener('click', () => submitPod(l.tokenNo));
  }

  async function runAction(action, extra) {
    const errEl = document.getElementById('actionError');
    if (errEl) errEl.textContent = '';
    try {
      // Best-effort device location for this milestone — never blocks or
      // fails the update itself (see getMilestoneLocationBestEffort above).
      const loc = await getMilestoneLocationBestEffort();
      const body = Object.assign({ action }, extra || {});
      if (loc && body.lat == null && body.lng == null) { body.lat = loc.lat; body.lng = loc.lng; }
      const res = await driverFetch(`/api/driver/loads/${currentLoad.tokenNo}/action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update this load.');
      await loadMe();
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
  }

  async function submitCheckpoint(location, notes) {
    const errEl = document.getElementById('actionError');
    try {
      const res = await driverFetch(`/api/driver/loads/${currentLoad.tokenNo}/checkpoint`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, notes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save checkpoint.');
      if (window.LS && LS.showSuccess) LS.showSuccess('Checkpoint saved!');
      await loadMe();
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
  }

  async function submitDelay(payload) {
    const errEl = document.getElementById('actionError');
    try {
      const res = await driverFetch(`/api/driver/loads/${currentLoad.tokenNo}/delay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not report delay.');
      if (window.LS && LS.showSuccess) LS.showSuccess('Delay reported.');
      await loadMe();
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    }
  }

  // POD file -> base64 -> the existing shared /api/kyc/upload endpoint
  // (type: 'pod', same one carrier accounts already use) -> then the
  // driver-scoped POD-save endpoint with the returned path.
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  async function submitPod(tokenNo) {
    const errEl = document.getElementById('actionError');
    const fileInput = document.getElementById('podFileInput');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) { if (errEl) errEl.textContent = 'Please choose a POD file first.'; return; }
    const btn = document.getElementById('podSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
    try {
      const dataUrl = await fileToDataUrl(file);
      const uploadRes = await fetch('/api/kyc/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'pod', imageBase64: dataUrl }),
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'Could not upload the POD file.');
      const res = await driverFetch(`/api/driver/loads/${tokenNo}/pod`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          podPath: uploadData.path,
          receiverName: document.getElementById('podReceiverNameInput').value.trim(),
          deliveryNotes: document.getElementById('podNotesInput').value.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save the POD.');
      if (window.LS && LS.showSuccess) LS.showSuccess('POD uploaded — awaiting admin approval.');
      await loadMe();
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Upload POD'; }
    }
  }

  // ---------- GPS: browser Geolocation API ----------
  // There is no native mobile app in this project — everything here runs
  // inside the driver's mobile browser. That has real, permanent limits
  // no amount of client code can remove: the browser generally requires a
  // secure context (HTTPS, or localhost) to expose location at all, and a
  // backgrounded/closed browser tab will have its GPS watch suspended or
  // killed by the OS — there is no guaranteed "keep tracking after the
  // driver switches apps" here. A future native Android/iOS app could use
  // a foreground service / background location API for that; this web
  // implementation instead tracks reliably WHILE THE PAGE IS OPEN AND
  // VISIBLE, and is honest with the driver about that (see the Page
  // Visibility handling below).
  //
  // Uses watchPosition() (continuous stream) rather than a fixed-interval
  // getCurrentPosition() poll, but throttles which readings actually get
  // POSTed — both by minimum elapsed time AND minimum distance moved — so
  // a stationary truck at a red light doesn't spam the network/battery,
  // while a fast-moving truck still reports promptly even before the time
  // floor elapses (mirrors the server's own defense-in-depth throttle in
  // lib/gpsValidation.shouldAcceptPing).
  const GPS_MIN_SEND_INTERVAL_MS = 8000;
  const GPS_MIN_MOVEMENT_METERS = 15;
  const GPS_MAX_QUEUE_LENGTH = 50; // bounded — never let a long offline stretch grow this without limit
  let lastSentAt = 0;
  let lastSentPoint = null;
  let offlineQueue = []; // [{lat,lng,speedKph,headingDeg,accuracy,altitude,deviceTimestamp}], oldest first
  let sendInFlight = false;
  let currentTokenNo = null;

  function haversineMeters(a, b) {
    if (!a || !b) return Infinity;
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function setGpsStatus(text, sub) {
    const statusText = document.getElementById('gpsStatusText');
    const subText = document.getElementById('gpsSubStatusText');
    if (statusText) statusText.textContent = text;
    if (subText) subText.textContent = sub || '';
  }
  function setGpsDotState(state) {
    // state: 'live' | 'waiting' | 'offline' | 'error'
    const dot = document.getElementById('gpsDot');
    if (!dot) return;
    dot.classList.remove('live', 'waiting', 'offline', 'error');
    dot.classList.add(state);
  }

  /** Basic client-side sanity check before a reading is even queued — the
   * authoritative validation still happens server-side (lib/gpsValidation),
   * this is just to avoid queuing/sending obviously-bad points at all. */
  function isPlausiblePosition(pos) {
    const lat = pos && pos.coords && pos.coords.latitude;
    const lng = pos && pos.coords && pos.coords.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    if (lat === 0 && lng === 0) return false;
    return true;
  }

  function pointFromPosition(pos) {
    return {
      lat: pos.coords.latitude, lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null,
      speedKph: pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) : null,
      headingDeg: pos.coords.heading != null && !Number.isNaN(pos.coords.heading) ? Math.round(pos.coords.heading) : null,
      altitude: pos.coords.altitude != null ? Math.round(pos.coords.altitude) : null,
      deviceTimestamp: new Date(pos.timestamp).toISOString(),
    };
  }

  /** Sends the oldest queued point; on success, keeps draining the queue;
   * on failure, stops and leaves the rest queued for the next trigger
   * (an interval tick, or the browser's 'online' event). Bounded queue —
   * points are dropped from the FRONT (oldest/stalest first) once full, so
   * a long offline stretch never grows this without limit and, once back
   * online, the freshest available points are what get sent first. */
  async function drainQueue() {
    if (sendInFlight || !offlineQueue.length || !currentTokenNo) return;
    sendInFlight = true;
    setGpsDotState('waiting');
    setGpsStatus(offlineQueue.length > 1 ? `Sending ${offlineQueue.length} queued updates…` : 'Sending location…');
    try {
      while (offlineQueue.length) {
        const point = offlineQueue[0];
        const res = await driverFetch(`/api/driver/loads/${currentTokenNo}/gps`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(point),
        });
        if (res.status === 409) {
          // Tracking is no longer active for this load (e.g. it moved on
          // to Delivered while a point was queued) — nothing more to send.
          offlineQueue = [];
          break;
        }
        if (!res.ok && res.status !== 202) {
          throw new Error('HTTP ' + res.status);
        }
        offlineQueue.shift(); // sent (or server-side throttled as a no-op) — either way, done with it
      }
      setGpsDotState('live');
      setGpsStatus('Live — last sent ' + new Date().toLocaleTimeString());
    } catch (err) {
      // Leaves whatever's left in the queue for the next attempt — network
      // errors are expected (tunnels, weak signal areas) and must not lose
      // data, just delay it.
      setGpsDotState('offline');
      setGpsStatus('Offline — saving updates', `${offlineQueue.length} update${offlineQueue.length === 1 ? '' : 's'} queued, will resend automatically.`);
    } finally {
      sendInFlight = false;
    }
  }

  function queuePoint(point) {
    offlineQueue.push(point);
    while (offlineQueue.length > GPS_MAX_QUEUE_LENGTH) offlineQueue.shift(); // drop oldest first, never grow unbounded
    drainQueue();
  }

  function handlePosition(pos) {
    if (!isPlausiblePosition(pos)) return; // silently skip — do not send invalid coordinates
    const point = pointFromPosition(pos);
    const now = Date.now();
    const elapsed = now - lastSentAt;
    const moved = haversineMeters(lastSentPoint, point);
    // Send if enough time has passed, OR the truck has genuinely moved a
    // meaningful distance even before the time floor — a fast-moving truck
    // should never wait 8 full seconds to report a large jump.
    if (lastSentAt !== 0 && elapsed < GPS_MIN_SEND_INTERVAL_MS && moved < GPS_MIN_MOVEMENT_METERS) return;
    lastSentAt = now;
    lastSentPoint = point;
    queuePoint(point);
  }

  function handlePositionError(err) {
    setGpsDotState('error');
    const CODE_MESSAGES = {
      1: 'Location permission denied — please allow location access in your browser settings to keep tracking this trip.',
      2: 'Location signal unavailable right now — waiting for a GPS fix.',
      3: 'Getting your location timed out — retrying…',
    };
    setGpsStatus(CODE_MESSAGES[err && err.code] || 'Location error: ' + (err && err.message));
  }

  let onlineListenerAttached = false;
  function startGpsWatch(tokenNo) {
    currentTokenNo = tokenNo;
    if (gpsWatchId != null) return; // already running
    if (!window.isSecureContext) {
      setGpsDotState('error');
      setGpsStatus('Location sharing requires a secure connection (HTTPS).', 'This page was not loaded over HTTPS, so the browser will not provide GPS access.');
      return;
    }
    if (!navigator.geolocation) {
      setGpsDotState('error');
      setGpsStatus('This browser does not support location sharing.');
      return;
    }
    setGpsDotState('waiting');
    setGpsStatus('Requesting location permission…');
    gpsWatchId = navigator.geolocation.watchPosition(
      handlePosition,
      handlePositionError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    if (!onlineListenerAttached) {
      onlineListenerAttached = true;
      window.addEventListener('online', drainQueue);
      // Honest limitation, surfaced rather than hidden: most mobile
      // browsers throttle or fully suspend a background tab's GPS watch
      // within seconds to minutes, and tracking stops entirely if the tab
      // or browser is closed. There is no web API that guarantees
      // otherwise — that guarantee only exists in a native app with a
      // foreground location service.
      document.addEventListener('visibilitychange', () => {
        if (!currentTokenNo) return;
        const subText = document.getElementById('gpsSubStatusText');
        if (subText && document.visibilityState === 'hidden') {
          subText.textContent = 'Tracking may pause while this tab is in the background — keep it open for reliable live tracking.';
        }
      });
    }
  }
  function stopGpsWatch() {
    if (gpsWatchId != null && navigator.geolocation) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
    if (gpsIntervalId) { clearInterval(gpsIntervalId); gpsIntervalId = null; }
    lastSentAt = 0;
    lastSentPoint = null;
    currentTokenNo = null;
    // Intentionally NOT clearing offlineQueue here — if tracking is
    // resumed for the same load in this same page session, any not-yet-
    // sent points are still worth trying to deliver.
  }

  function loadMe() {
    return driverFetch('/api/driver/me')
      .then((res) => {
        if (res.status === 401) { window.location.href = '/driver/login'; return null; }
        return res.json();
      })
      .then((data) => { if (data) render(data); })
      .catch(() => {
        document.getElementById('driverContent').innerHTML = '<div class="driver-card"><div class="driver-empty">Could not load your dashboard.</div></div>';
      });
  }

  loadMe();
  // Poll every 10s so a newly-matched load / stage change from Admin shows
  // up without the driver needing to refresh manually.
  setInterval(loadMe, 10000);
