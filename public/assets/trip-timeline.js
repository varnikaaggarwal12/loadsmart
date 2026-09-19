/**
 * trip-timeline.js
 * Load Smart — shared, professional trip-timeline component.
 *
 * Shared across every role's UI (driver dashboard, shipper Live Tracking,
 * carrier Loads, Admin Tracking) so the milestone ladder and audit log look
 * and behave identically everywhere, and only exist in one place — same
 * pattern already used for live-map.js (shared Leaflet map module).
 *
 * Renders TWO things from the same data:
 *   1. A connected milestone LADDER — the fixed lifecycle sequence
 *      (Load Posted -> ... -> Load Completed), each step shown done (✓),
 *      current (●, pulsing), or upcoming (○) — with date/time, who updated
 *      it, location (if captured), and notes shown under any step that has
 *      already happened.
 *   2. A flat, chronological ACTIVITY LOG underneath — every recorded
 *      TrackingEvent verbatim (including checkpoints, delays, POD actions,
 *      admin approvals — anything that doesn't map onto one fixed ladder
 *      step), so the full audit trail stays visible even though the ladder
 *      itself only shows the primary milestones.
 *
 * Data comes straight from GET /api/loads/:token/tracking (an array of
 * TrackingEvent docs — see lib/opsModels.js) plus the load's current
 * loadStage. Nothing here talks to the network itself — callers fetch and
 * pass the data in, same division of responsibility as live-map.js.
 *
 * Usage:
 *   LSTripTimeline.render(document.getElementById('timelineEl'), {
 *     currentStage: order.loadStage,   // e.g. 'IN_TRANSIT'
 *     events: eventsArray,              // from GET /api/loads/:token/tracking
 *     docLinkFn: (photoPath) => url,    // optional — turn a photoPath into a clickable URL
 *   });
 *
 * NOTE: ORDERED_STAGES below mirrors lib/loadStatusMachine.js's LOAD_STAGES
 * exactly (key + label) — this file cannot `require()` that server module
 * (browser vs Node boundary, same reason driver-dashboard.js keeps its own
 * STAGE_LABELS copy and gpsValidation.js's haversine formula is duplicated
 * client-side). Keep the two lists in sync if the lifecycle ever changes.
 */
(function (window) {
  'use strict';

  // Primary lifecycle ladder shown as connected dots. DRIVER_REJECTED and
  // MATCHED are deliberately excluded — they're exception/transient system
  // states, not steps a normal trip's timeline should always show; if a
  // load is currently sitting at one of those, `render()` falls back to
  // highlighting the nearest earlier ladder step as "current" (see below).
  const ORDERED_STAGES = [
    { key: 'POSTED', label: 'Load Posted' },
    { key: 'ASSIGNED', label: 'Driver / Carrier Assigned' },
    { key: 'DRIVER_ACCEPTED', label: 'Driver Accepted' },
    { key: 'ARRIVED_PICKUP', label: 'Reached Pickup' },
    { key: 'LOADING', label: 'Loading Started' },
    { key: 'LOADED', label: 'Loading Completed' },
    { key: 'DEPARTED_PICKUP', label: 'Departed Pickup' },
    { key: 'IN_TRANSIT', label: 'In Transit' },
    { key: 'REACHED_DESTINATION', label: 'Reached Destination' },
    { key: 'UNLOADING', label: 'Unloading Started' },
    { key: 'UNLOADING_COMPLETE', label: 'Unloading Completed' },
    { key: 'DELIVERED', label: 'Delivered' },
    { key: 'COMPLETED', label: 'Trip Completed' },
  ];
  const STAGE_INDEX = Object.fromEntries(ORDERED_STAGES.map((s, i) => [s.key, i]));

  // Which TrackingEvent `type` represents each ladder step reaching that
  // point — mirrors the eventType each action writes in
  // lib/loadStatusMachine.js's DRIVER_ACTION_TRANSITIONS, plus the two
  // system-initiated types (LOAD_POSTED, DRIVER_ASSIGNED) logged elsewhere
  // in server_load.js, and POD approval's LOAD_COMPLETED.
  const STAGE_EVENT_TYPE = {
    POSTED: 'LOAD_POSTED',
    ASSIGNED: 'DRIVER_ASSIGNED',
    DRIVER_ACCEPTED: 'DRIVER_ACCEPTED',
    ARRIVED_PICKUP: 'REACHED_PICKUP',
    LOADING: 'LOADING_STARTED',
    LOADED: 'LOADING_COMPLETED',
    DEPARTED_PICKUP: 'DEPARTED_PICKUP',
    IN_TRANSIT: 'TRIP_STARTED',
    REACHED_DESTINATION: 'REACHED_DESTINATION',
    UNLOADING: 'UNLOADING_STARTED',
    UNLOADING_COMPLETE: 'UNLOADING_COMPLETED',
    DELIVERED: 'DELIVERED',
    COMPLETED: 'LOAD_COMPLETED',
  };
  // Reverse lookup, used to keep the milestone ladder from also listing an
  // event a second time in the activity log below it.
  const LADDER_EVENT_TYPES = new Set(Object.values(STAGE_EVENT_TYPE));

  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch (e) { return ''; }
  }
  function whoLabel(e) {
    const role = e.createdByRole ? e.createdByRole.charAt(0).toUpperCase() + e.createdByRole.slice(1) : '';
    if (e.createdByName && role) return `${e.createdByName} (${role})`;
    return e.createdByName || role || 'System';
  }

  function renderStepDetail(e, docLinkFn) {
    if (!e) return '';
    const locBits = [];
    if (e.location) locBits.push(escapeHtml(e.location));
    if (e.lat != null && e.lng != null) locBits.push(`${Number(e.lat).toFixed(5)}, ${Number(e.lng).toFixed(5)}`);
    const docUrl = e.photoPath && typeof docLinkFn === 'function' ? docLinkFn(e.photoPath) : null;
    return `
      <div class="ls-tt-detail">
        <div class="ls-tt-detail-row"><span class="ls-tt-when">${fmtWhen(e.createdAt)}</span><span class="ls-tt-who">${escapeHtml(whoLabel(e))}</span></div>
        ${locBits.length ? `<div class="ls-tt-loc">📍 ${locBits.join(' — ')}</div>` : ''}
        ${e.notes ? `<div class="ls-tt-notes">${escapeHtml(e.notes)}</div>` : ''}
        ${docUrl ? `<a class="ls-tt-doc-link" href="${docUrl}" target="_blank" rel="noopener">📎 View evidence</a>` : ''}
      </div>`;
  }

  function renderLadder(containerEl, currentStage, eventByType, docLinkFn) {
    // If the load is currently at a non-ladder state (DRIVER_REJECTED,
    // MATCHED), treat the nearest PRECEDING ladder stage as "current" so
    // the ladder degrades gracefully instead of showing nothing as active.
    let currentIndex = STAGE_INDEX[currentStage];
    if (currentIndex == null) {
      currentIndex = currentStage === 'MATCHED' ? STAGE_INDEX.ASSIGNED - 1
        : currentStage === 'DRIVER_REJECTED' ? STAGE_INDEX.ASSIGNED - 1 : 0;
    }
    const html = ORDERED_STAGES.map((stage, i) => {
      const eventType = STAGE_EVENT_TYPE[stage.key];
      const event = eventByType[eventType];
      const status = event || i < currentIndex ? 'done' : (i === currentIndex ? 'current' : 'future');
      const mark = status === 'done' ? '✓' : (status === 'current' ? '●' : '○');
      return `
        <li class="ls-tt-step ${status}">
          <span class="ls-tt-dot" aria-hidden="true">${mark}</span>
          <div class="ls-tt-body">
            <div class="ls-tt-label">${escapeHtml(stage.label)}</div>
            ${event ? renderStepDetail(event, docLinkFn) : (status === 'current' ? '<div class="ls-tt-detail ls-tt-pending">In progress…</div>' : '')}
          </div>
        </li>`;
    }).join('');
    containerEl.innerHTML = `<ol class="ls-tt-ladder">${html}</ol>`;
  }

  function renderActivityLog(containerEl, events, docLinkFn) {
    const extra = (events || []).filter((e) => !LADDER_EVENT_TYPES.has(e.type));
    if (!extra.length) { containerEl.innerHTML = ''; containerEl.hidden = true; return; }
    containerEl.hidden = false;
    const rows = extra.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((e) => `
      <li class="ls-tt-activity-item">
        <div class="ls-tt-activity-label">${escapeHtml(e.label || e.type)}</div>
        ${renderStepDetail(e, docLinkFn)}
      </li>`).join('');
    containerEl.innerHTML = `
      <h4 class="ls-tt-activity-heading">Full activity log</h4>
      <ul class="ls-tt-activity-list">${rows}</ul>`;
  }

  /**
   * render(containerEl, { currentStage, events, docLinkFn, activityEl })
   * containerEl gets the milestone ladder. If `activityEl` is passed, the
   * chronological extra-events log renders there too (a separate,
   * collapsible container is usually nicer than always-expanded); if
   * omitted, the activity log is appended inside containerEl itself.
   */
  function render(containerEl, opts) {
    if (!containerEl) return;
    const o = opts || {};
    const events = Array.isArray(o.events) ? o.events : [];
    const eventByType = {};
    // Earliest event of a given type wins (a load could in theory log the
    // same milestone type twice on a retried/edge-case flow — the ladder
    // should show when it FIRST happened).
    events.forEach((e) => {
      if (!eventByType[e.type] || new Date(e.createdAt) < new Date(eventByType[e.type].createdAt)) {
        eventByType[e.type] = e;
      }
    });
    renderLadder(containerEl, o.currentStage, eventByType, o.docLinkFn);
    if (o.activityEl) {
      renderActivityLog(o.activityEl, events, o.docLinkFn);
    } else {
      const wrap = document.createElement('div');
      renderActivityLog(wrap, events, o.docLinkFn);
      if (wrap.innerHTML) containerEl.insertAdjacentHTML('beforeend', wrap.innerHTML);
    }
  }

  window.LSTripTimeline = { render, ORDERED_STAGES };
})(window);
