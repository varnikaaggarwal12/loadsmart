/**
 * lib/loadStatusMachine.js
 *
 * Single source of truth for the load lifecycle's status values and legal
 * transitions (spec sections 1 and 22). Used by server_load.js so every
 * status-changing route enforces the same rules instead of re-implementing
 * ad-hoc checks — "prevent random status changes from the frontend" is
 * enforced HERE, once, not scattered across a dozen route handlers.
 *
 * This does not replace the existing `loadStage` enum on BookingRequest —
 * it documents and validates it. The existing values (POSTED, MATCHED,
 * ASSIGNED, DRIVER_ACCEPTED, ARRIVED_PICKUP, LOADING, LOADED, IN_TRANSIT,
 * DELIVERED) are kept exactly as they already behave; this file only adds
 * the handful of new stages the full lifecycle needs (DRIVER_REJECTED,
 * REACHED_DESTINATION, UNLOADING, COMPLETED, and — added for the manual
 * digital trip-tracking milestone expansion — DEPARTED_PICKUP between
 * LOADED and IN_TRANSIT, and UNLOADING_COMPLETE between UNLOADING and
 * DELIVERED) and formalizes the driver action → transition table that
 * already existed inline in server_load.js (DRIVER_ACTION_TRANSITIONS) as
 * the shared, importable definition.
 *
 * ---------------------------------------------------------------------
 * Mapping from the spec's requested vocabulary to this app's actual field
 * values (kept distinct on purpose — see the comment above each block):
 *
 *   Spec vocabulary            →  This app's actual status
 *   ---------------------------------------------------------
 *   POSTED                     →  BookingRequest.status = 'pending'
 *                                  (kind: 'booking' | 'rate_request')
 *   ADMIN REVIEW                  (implicit — status stays 'pending'
 *                                  until an admin acts)
 *   APPROVED                   →  BookingRequest.status = 'accepted'
 *   (rejected)                 →  BookingRequest.status = 'rejected'
 *                                  (+ rejectionReason)
 *   DRIVER/CARRIER ASSIGNED    →  loadStage = 'ASSIGNED'
 *   DRIVER ACCEPTED            →  loadStage = 'DRIVER_ACCEPTED'
 *   (driver rejected)          →  loadStage = 'DRIVER_REJECTED'  (NEW)
 *   PICKUP PENDING              →  loadStage = 'DRIVER_ACCEPTED' (driver is
 *                                  now en route to pickup — the existing
 *                                  pipeline doesn't need a separate stage
 *                                  for "pending" vs "accepted": the next
 *                                  concrete event is ARRIVED_PICKUP)
 *   PICKED UP                  →  loadStage = 'LOADED'  (truck loaded and
 *                                  departing — matches the existing
 *                                  ARRIVED_PICKUP → LOADING → LOADED chain)
 *   IN TRANSIT                 →  loadStage = 'IN_TRANSIT'
 *   REACHED CHECKPOINT /
 *   LOCATION UPDATE             →  a TrackingEvent row (type CHECKPOINT),
 *                                  logged WITHOUT changing loadStage —
 *                                  checkpoints are informational pings
 *                                  along an already-IN_TRANSIT load, not a
 *                                  new pipeline stage (spec section 8
 *                                  confirms this: "update current trip
 *                                  status" = the tracking.remarks/location,
 *                                  not a new gate)
 *   REACHED DESTINATION        →  loadStage = 'REACHED_DESTINATION' (NEW)
 *   UNLOADING                  →  loadStage = 'UNLOADING'  (NEW)
 *   DELIVERED                  →  loadStage = 'DELIVERED'
 *   POD UPLOADED                →  podPath set, podStatus = 'uploaded'
 *   POD APPROVED                →  podStatus = 'approved', podVerified = true
 *   LOAD COMPLETED              →  loadStage = 'COMPLETED'  (NEW — set only
 *                                  after POD is approved)
 *
 *   DELAYED is modeled as an OVERLAY, not a pipeline stage: reporting a
 *   delay sets the existing tracking.status enum value 'Delayed' (already
 *   present in the schema — see server_load.js bookingRequestSchema) and
 *   `load.delay = {...}` details, without losing the load's real
 *   loadStage/place in the pipeline. The next real driver action clears it
 *   automatically. This avoids inserting "Delayed" as a dead-end pipeline
 *   stage that would need its own way back into the main flow.
 * ---------------------------------------------------------------------
 */

// Every loadStage value this app now uses, in pipeline order, with a
// human label — the single list the frontend timeline (spec section 7)
// renders from, so the UI can never drift out of sync with the backend.
const LOAD_STAGES = [
  { key: 'POSTED', label: 'Load Posted' },
  { key: 'MATCHED', label: 'AI Match Found (awaiting admin approval)' },
  // 'BIDDING_OPEN' — new (carrier-bidding system): the assignmentMode:
  // 'bidding' counterpart to 'MATCHED' above. A load only ever passes
  // through ONE of these two stages, never both — see the `assignmentMode`
  // field on BookingRequest and openLoadForBidding() in server_load.js.
  // Sits in the same "who gets this load" slot as MATCHED so the rest of
  // the pipeline (ASSIGNED onward) never needs to know which mechanism was
  // used — both converge on ASSIGNED exactly the same way.
  { key: 'BIDDING_OPEN', label: 'Open for Carrier Bidding' },
  { key: 'ASSIGNED', label: 'Driver / Carrier Assigned' },
  { key: 'DRIVER_ACCEPTED', label: 'Driver Accepted' },
  { key: 'DRIVER_REJECTED', label: 'Driver Rejected — awaiting reassignment' },
  { key: 'ARRIVED_PICKUP', label: 'Reached Pickup Location' },
  { key: 'LOADING', label: 'Loading In Progress' },
  { key: 'LOADED', label: 'Picked Up' },
  // 'DEPARTED_PICKUP' and 'UNLOADING_COMPLETE' — new (manual digital trip
  // tracking expansion): each of the 9 driver-tappable milestones the spec
  // asks for now maps to its own real loadStage, matching the granularity
  // already used for every other step. Inserted between the two existing
  // stages they sit between so nothing before/after them shifts meaning.
  { key: 'DEPARTED_PICKUP', label: 'Departed Pickup Location' },
  { key: 'IN_TRANSIT', label: 'In Transit' },
  { key: 'REACHED_DESTINATION', label: 'Reached Destination' },
  { key: 'UNLOADING', label: 'Unloading' },
  { key: 'UNLOADING_COMPLETE', label: 'Unloading Completed' },
  { key: 'DELIVERED', label: 'Delivered' },
  { key: 'COMPLETED', label: 'Load Completed' },
];
const LOAD_STAGE_KEYS = LOAD_STAGES.map((s) => s.key);
const STAGE_LABELS = Object.fromEntries(LOAD_STAGES.map((s) => [s.key, s.label]));

// Driver-initiated action → { from, to, remarks, trackingEventType, trackingEventLabel }
// This is the canonical transition table — server_load.js's
// /api/driver/loads/:token/action route (and its spec-shaped REST aliases)
// both read from this one object, so there is exactly one place that
// decides what's legal.
const DRIVER_ACTION_TRANSITIONS = {
  accept: { from: 'ASSIGNED', to: 'DRIVER_ACCEPTED', remarks: 'Driver accepted the load.', eventType: 'DRIVER_ACCEPTED', eventLabel: 'Driver Accepted' },
  reject: { from: 'ASSIGNED', to: 'DRIVER_REJECTED', remarks: 'Driver rejected the load.', eventType: 'DRIVER_REJECTED', eventLabel: 'Driver Rejected' },
  arrived: { from: 'DRIVER_ACCEPTED', to: 'ARRIVED_PICKUP', remarks: 'Driver arrived at pickup location.', eventType: 'REACHED_PICKUP', eventLabel: 'Reached Pickup Location' },
  start_loading: { from: 'ARRIVED_PICKUP', to: 'LOADING', remarks: 'Loading in progress.', eventType: 'LOADING_STARTED', eventLabel: 'Loading Started' },
  loaded: { from: 'LOADING', to: 'LOADED', remarks: 'Truck loaded — ready to depart.', eventType: 'LOADING_COMPLETED', eventLabel: 'Loading Completed' },
  // 'depart' — new: driver confirms they've physically left the pickup
  // location. Deliberately does NOT touch trackingSessionActive/GPS — that
  // stays exclusively on 'start_trip' below, one stage later, so the
  // GPS-consent moment ("Start trip (begin live tracking)") is unchanged
  // from what was already tested and working.
  depart: { from: 'LOADED', to: 'DEPARTED_PICKUP', remarks: 'Truck departed the pickup location.', eventType: 'DEPARTED_PICKUP', eventLabel: 'Departed Pickup Location' },
  start_trip: { from: 'DEPARTED_PICKUP', to: 'IN_TRANSIT', remarks: 'Truck departed — in transit. Live tracking started.', eventType: 'TRIP_STARTED', eventLabel: 'Trip Started' },
  reach_destination: { from: 'IN_TRANSIT', to: 'REACHED_DESTINATION', remarks: 'Driver reached the destination.', eventType: 'REACHED_DESTINATION', eventLabel: 'Reached Destination' },
  start_unloading: { from: 'REACHED_DESTINATION', to: 'UNLOADING', remarks: 'Unloading in progress.', eventType: 'UNLOADING_STARTED', eventLabel: 'Unloading Started' },
  // 'complete_unloading' — new: separates "physically finished unloading"
  // from "delivery confirmed" (receiver name/phone/notes, captured by the
  // existing 'deliver' step below) — matches the spec's own milestone list,
  // and reflects the real-world gap between the two.
  complete_unloading: { from: 'UNLOADING', to: 'UNLOADING_COMPLETE', remarks: 'Unloading completed.', eventType: 'UNLOADING_COMPLETED', eventLabel: 'Unloading Completed' },
  // 'deliver' is the spec-named action (POST /api/loads/:id/deliver);
  // 'complete' is kept as an accepted alias for backward compatibility
  // with the existing driver dashboard button that already calls it.
  deliver: { from: 'UNLOADING_COMPLETE', to: 'DELIVERED', remarks: 'Delivered. Live tracking stopped.', eventType: 'DELIVERED', eventLabel: 'Delivered', requiresDeliveryConfirmation: true },
  complete: { from: 'UNLOADING_COMPLETE', to: 'DELIVERED', remarks: 'Delivered. Live tracking stopped.', eventType: 'DELIVERED', eventLabel: 'Delivered', requiresDeliveryConfirmation: true },
};

// tracking.status is a small, PRE-EXISTING enum
// ['Booked','Confirmed','Picked Up','In Transit','Out for Delivery',
//  'Delayed','Delivered'] that the shipper Live Tracking page, the public
// phone-lookup, and computeFlowStage() all already read. It is deliberately
// left untouched (not extended) — every new loadStage maps onto the
// closest existing value so none of that older code needs to change.
const TRACKING_STATUS_MAP = {
  POSTED: 'Booked', MATCHED: 'Booked', BIDDING_OPEN: 'Booked', ASSIGNED: 'Confirmed', DRIVER_ACCEPTED: 'Confirmed',
  DRIVER_REJECTED: 'Booked', ARRIVED_PICKUP: 'Confirmed', LOADING: 'Confirmed', LOADED: 'Picked Up',
  DEPARTED_PICKUP: 'In Transit', IN_TRANSIT: 'In Transit', REACHED_DESTINATION: 'Out for Delivery',
  UNLOADING: 'Out for Delivery', UNLOADING_COMPLETE: 'Out for Delivery',
  DELIVERED: 'Delivered', COMPLETED: 'Delivered',
};

/** Throws a formatted, HTTP-status-carrying error if `action` isn't legal from `currentStage`. */
function assertTransition(currentStage, action) {
  const transition = DRIVER_ACTION_TRANSITIONS[action];
  if (!transition) {
    const err = new Error(`Unknown action "${action}".`);
    err.status = 400;
    throw err;
  }
  if (currentStage !== transition.from) {
    const err = new Error(`This action isn't valid right now (load is currently ${STAGE_LABELS[currentStage] || currentStage}).`);
    err.status = 409;
    throw err;
  }
  return transition;
}

module.exports = {
  LOAD_STAGES, LOAD_STAGE_KEYS, STAGE_LABELS,
  DRIVER_ACTION_TRANSITIONS, TRACKING_STATUS_MAP,
  assertTransition,
};
