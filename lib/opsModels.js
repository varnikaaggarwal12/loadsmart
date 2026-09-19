/**
 * lib/opsModels.js
 *
 * New Mongoose models for the full load-lifecycle workflow (posting →
 * admin approval → driver assignment → manual tracking → delivery → POD →
 * completion). Kept in their own file — same pattern already used by
 * lib/matchingEngine.js and lib/trustScore.js — rather than growing
 * server_load.js's inline model block further. Every model here is
 * ADDITIVE: nothing in this file changes or removes any existing
 * Registration/BookingRequest/Truck/Driver/Feedback/TrackingPoint schema.
 *
 * Required once from server_load.js: `const ops = require('./lib/opsModels');`
 */
const mongoose = require('mongoose');

// ---------- TrackingEvent ----------
// One row per manual trip update — the chronological "what happened, when,
// where, and who said so" history for a load. Distinct from the existing
// TrackingPoint collection (raw GPS lat/lng pings only, high frequency,
// numeric-only) — this is the human-readable event log: "10:15 AM — Trip
// Started — Chandigarh", "01:30 PM — Reached Checkpoint — Ludhiana — Vehicle
// stopped for inspection." Never overwritten or deleted — append-only, so a
// load's full history can always be reconstructed and shown as a timeline.
const TRACKING_EVENT_TYPES = [
  'TRIP_STARTED', 'REACHED_PICKUP', 'LOADING_STARTED', 'LOADING_COMPLETED',
  // 'DEPARTED_PICKUP' — new (manual trip-tracking milestone expansion): the
  // driver's "left the pickup location" tap, distinct from LOADING_COMPLETED
  // (goods loaded) and TRIP_STARTED (live GPS tracking begins) — see
  // lib/loadStatusMachine.js's 'depart' action for where this is created.
  'DEPARTED_PICKUP',
  'PICKED_UP', 'IN_TRANSIT', 'CHECKPOINT', 'DELAYED', 'REACHED_DESTINATION',
  'UNLOADING_STARTED', 'UNLOADING_COMPLETED', 'DELIVERED',
  // Non-driver-initiated events that still belong on the same timeline so
  // the shipper/admin see one unified history rather than two separate
  // feeds (see spec section 19 "Load Details / Tracking Page > Tracking").
  'LOAD_POSTED', 'LOAD_APPROVED', 'LOAD_REJECTED', 'DRIVER_ASSIGNED',
  'DRIVER_ACCEPTED', 'DRIVER_REJECTED', 'POD_UPLOADED', 'POD_APPROVED',
  'POD_REJECTED', 'LOAD_COMPLETED',
  // ---- Carrier-bidding system (assignmentMode: 'bidding') ----
  // Parallels the LOAD_POSTED/LOAD_APPROVED/DRIVER_ASSIGNED events above,
  // one level down: BIDDING_OPEN parallels LOAD_APPROVED (the moment a
  // load becomes visible to carriers), BID_SUBMITTED/BID_WITHDRAWN are
  // per-carrier events, and CARRIER_SELECTED parallels DRIVER_ASSIGNED
  // (the moment a winning bid is accepted and the load moves to ASSIGNED).
  'BIDDING_OPEN', 'BID_SUBMITTED', 'BID_WITHDRAWN', 'CARRIER_SELECTED', 'BIDDING_CLOSED',
];
const trackingEventSchema = new mongoose.Schema({
  tokenNo: { type: String, required: true, index: true },
  type: { type: String, enum: TRACKING_EVENT_TYPES, required: true },
  // Human-readable label shown directly on the timeline (e.g. "Reached
  // Checkpoint") — stored alongside `type` so the timeline never needs a
  // separate lookup table and old rows keep their original wording even if
  // labels are tweaked later.
  label: { type: String, required: true },
  location: { type: String, default: '' },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  notes: { type: String, default: '' },
  // Re-uses the exact same private-uploads/kyc storage + /api/kyc/upload
  // flow as every other document/photo in this app (see server_load.js) —
  // the field just stores the returned /admin/kyc-photo/:filename path.
  photoPath: { type: String, default: '' },
  createdByRole: { type: String, default: '' }, // 'driver' | 'admin' | 'system'
  createdByName: { type: String, default: '' },
  createdByUsername: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true },
}, { strict: true });
trackingEventSchema.index({ tokenNo: 1, createdAt: 1 });
const TrackingEvent = mongoose.model('TrackingEvent', trackingEventSchema);

// ---------- Notification (in-app notification center) ----------
const notificationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  // Who this notification is for. userRole + userId together identify the
  // recipient the same way the rest of the app already does: a Registration
  // record's `id` for shipper/broker/carrier, a Driver record's `id` for
  // drivers, or the literal string 'admin' (admin is a shared inbox — every
  // logged-in admin sees the same notifications, same as the existing
  // NOTIFY_TO_EMAIL ops inbox pattern) for role 'admin'.
  userId: { type: String, required: true, index: true },
  userRole: { type: String, enum: ['shipper', 'broker', 'carrier', 'driver', 'admin'], required: true },
  loadId: { type: String, default: '' }, // tokenNo, when relevant
  type: { type: String, default: '' },   // machine-readable event key, e.g. 'LOAD_APPROVED'
  title: { type: String, required: true },
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, index: true },
}, { strict: true });
notificationSchema.index({ userId: 1, userRole: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, userRole: 1, read: 1 });
const Notification = mongoose.model('Notification', notificationSchema);

// ---------- ActivityLog (audit trail) ----------
const activityLogSchema = new mongoose.Schema({
  loadId: { type: String, default: '', index: true }, // tokenNo, when relevant
  userId: { type: String, default: '' },
  userRole: { type: String, default: '' },
  userName: { type: String, default: '' },
  action: { type: String, required: true },
  oldStatus: { type: String, default: '' },
  newStatus: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  ip: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true },
}, { strict: true });
activityLogSchema.index({ loadId: 1, createdAt: -1 });
const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

// ---------- EmailLog ----------
// Every email attempt made through the email notification system (spec:
// "email notification system across the existing application", section 12
// "Notification Database") is recorded here — queued, sent, retried, or
// failed — so an SMTP/provider hiccup is visible/debuggable in the Admin
// Email Log without ever blocking or rolling back the database transaction
// that triggered it.
//
// Two generations of fields intentionally coexist:
//   - `recipient`/`event`/`loadId`/`error`/`sentAt` — the original, simpler
//     fields written by the very first synchronous emailService.js. Kept so
//     nothing that already reads them breaks.
//   - `email`/`eventType`/`entityType`/`entityId`/`userId`/`subject`/
//     `providerMessageId`/`errorMessage`/`idempotencyKey`/`attempts`/
//     `html`/`text`/`createdAt` — the fields the new queue+worker email
//     system (lib/emailQueue.js) actually writes/reads. New code should
//     prefer these; the admin Email Log UI reads from this generation.
// lib/emailQueue.js keeps both generations populated on every write so a
// single row is equally readable by old and new code.
const EMAIL_LOG_STATUSES = ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'RETRYING', 'sent', 'skipped_no_smtp', 'failed'];
const emailLogSchema = new mongoose.Schema({
  // ---- legacy fields ----
  recipient: { type: String, required: true },
  event: { type: String, required: true }, // e.g. 'LOAD_APPROVED'
  loadId: { type: String, default: '' },
  error: { type: String, default: '' },
  sentAt: { type: Date, default: null, index: true },
  // ---- spec-shaped fields (section 12) ----
  email: { type: String, default: '' },
  eventType: { type: String, default: '' },
  entityType: { type: String, default: '' }, // 'Load' | 'Truck' | 'Driver' | 'Assignment'
  entityId: { type: String, default: '' },
  userId: { type: String, default: '' },
  userRole: { type: String, default: '' },
  subject: { type: String, default: '' },
  // Idempotency key = eventType + entityId + recipient — the unique
  // constraint that makes duplicate-send prevention a DB-level guarantee,
  // not just an in-process check (spec: "prevent duplicate emails ... on
  // page refresh, frontend retry, backend retry, matching re-run, or
  // worker restart").
  idempotencyKey: { type: String, default: null, index: { unique: true, sparse: true } },
  providerMessageId: { type: String, default: '' },
  errorMessage: { type: String, default: '' },
  attempts: { type: Number, default: 0 },
  // The rendered body is stored so the Admin "Retry" button can literally
  // resend the exact same email rather than needing to recompute it (and
  // so a debugging admin can see exactly what a recipient received). Never
  // holds passwords/OTPs/tokens/bank or ID numbers — see lib/emailTemplates.js.
  html: { type: String, default: '' },
  text: { type: String, default: '' },
  status: { type: String, enum: EMAIL_LOG_STATUSES, required: true, default: 'PENDING' },
  createdAt: { type: Date, default: Date.now, index: true },
}, { strict: true });
emailLogSchema.index({ status: 1, createdAt: -1 });
emailLogSchema.index({ eventType: 1, createdAt: -1 });
const EmailLog = mongoose.model('EmailLog', emailLogSchema);

// ---------- SmsLog ----------
// Same shape/purpose as EmailLog above, one generation only (this is new
// infrastructure — see lib/smsProvider.js/lib/smsQueue.js for why). Every
// SMS attempt the Broker automation features trigger (load posted, carrier
// connection requested/accepted/rejected, bid invitation, bid submitted/
// accepted, etc.) is recorded here so delivery is auditable and a Twilio
// hiccup never silently disappears or blocks the business transaction that
// triggered it.
const SMS_LOG_STATUSES = ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'RETRYING'];
const smsLogSchema = new mongoose.Schema({
  recipient: { type: String, required: true }, // phone number
  eventType: { type: String, default: '' },    // e.g. 'LOAD_POSTED', 'CARRIER_CONNECTION_ACCEPTED'
  entityType: { type: String, default: '' },   // 'Load' | 'CarrierConnection' | 'Bid' | ...
  entityId: { type: String, default: '' },
  userId: { type: String, default: '' },
  userRole: { type: String, default: '' },
  body: { type: String, default: '' },
  // Idempotency key = eventType + entityId + recipient, same guarantee as
  // EmailLog.idempotencyKey — a second enqueue() for the exact same
  // event/entity/recipient is detected and skipped rather than sent twice.
  idempotencyKey: { type: String, default: null, index: { unique: true, sparse: true } },
  providerMessageId: { type: String, default: '' },
  errorMessage: { type: String, default: '' },
  attempts: { type: Number, default: 0 },
  status: { type: String, enum: SMS_LOG_STATUSES, required: true, default: 'PENDING' },
  sentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
}, { strict: true });
smsLogSchema.index({ status: 1, createdAt: -1 });
smsLogSchema.index({ eventType: 1, createdAt: -1 });
const SmsLog = mongoose.model('SmsLog', smsLogSchema);

module.exports = { TrackingEvent, Notification, ActivityLog, EmailLog, SmsLog, TRACKING_EVENT_TYPES, EMAIL_LOG_STATUSES, SMS_LOG_STATUSES };
