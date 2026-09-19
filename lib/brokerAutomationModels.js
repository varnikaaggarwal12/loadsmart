/**
 * lib/brokerAutomationModels.js
 *
 * New Mongoose models for the Broker→Carrier→Shipper automation workflow
 * (Find Loads for a Carrier → Save Load → Find Suitable Truck → Select Truck
 * → Request Shipper Connection → Notifications → Bid/Negotiation → Approval
 * → Assignment). Same additive pattern as lib/opsModels.js / lib/biddingModels.js
 * — nothing here changes or removes any existing Registration/BookingRequest/
 * Truck/Driver/Bid schema. Both models below are scoped to real, existing
 * BookingRequest (Load) and Registration (Carrier) records by their stable
 * string ids/usernames, the same convention every other collection in this
 * app already uses — never a raw Mongo ObjectId reference.
 *
 * Required once from server_load.js:
 *   const brokerAutomationModels = require('./lib/brokerAutomationModels');
 */
const mongoose = require('mongoose');

// ---------- BrokerSavedLoad ----------
// One row per (broker, carrier, load) a broker has shortlisted on that
// carrier's behalf. Saving a load is purely a bookmarking/shortlisting
// action — it never touches BookingRequest.loadStage or any other field on
// the load itself (spec: "Keep the original load status unchanged" /
// "A saved load must not automatically become accepted or assigned").
const BROKER_SAVED_LOAD_STATUSES = ['saved', 'matched', 'contacted', 'accepted', 'rejected'];
const brokerSavedLoadSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  brokerId: { type: String, required: true, index: true },       // Registration.id (role: broker)
  brokerUsername: { type: String, required: true, index: true },
  carrierId: { type: String, required: true, index: true },      // Registration.id (role: carrier)
  carrierUsername: { type: String, required: true, index: true },
  carrierCompanyName: { type: String, default: '' },
  loadId: { type: String, required: true, index: true },         // BookingRequest.tokenNo
  // Denormalized snapshot of the load at save time, purely for fast list
  // rendering — the live BookingRequest is still the source of truth for
  // status/assignment; this is never used to make an authorization decision.
  loadSnapshot: {
    pickup: { type: String, default: '' },
    destination: { type: String, default: '' },
    material: { type: String, default: '' },
    weight: { type: Number, default: null },
    requiredTruckType: { type: String, default: '' },
    shipperCompanyName: { type: String, default: '' },
  },
  status: { type: String, enum: BROKER_SAVED_LOAD_STATUSES, default: 'saved' },
  notes: { type: String, default: '' },
  savedByUsername: { type: String, default: '' }, // audit: who actually clicked Save (always the broker today, kept for a future team-seat feature)
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { strict: true });
// Prevents a broker from saving the exact same load for the exact same
// carrier twice (spec: "Prevent duplicate saved records") — a DB-level
// guarantee, not just an application-level check.
brokerSavedLoadSchema.index({ brokerUsername: 1, carrierUsername: 1, loadId: 1 }, { unique: true });
brokerSavedLoadSchema.index({ brokerUsername: 1, status: 1, createdAt: -1 });
const BrokerSavedLoad = mongoose.model('BrokerSavedLoad', brokerSavedLoadSchema);

// ---------- BrokerConnection ----------
// One row per "connect this carrier with this load's shipper" workflow
// instance a broker starts. Deliberately separate from Bid (lib/biddingModels.js)
// — a BrokerConnection tracks the BROKER'S OWN workflow/audit trail (who
// requested what, when, current stage) while the actual monetary offer and
// the real accept/reject transaction continue to run entirely through the
// existing Bid + shipper accept-bid flow, completely unmodified. `bidId`
// links the two once a bid has actually been placed for this connection.
const BROKER_CONNECTION_STATUSES = [
  'pending', 'shipper_notified', 'carrier_notified', 'negotiating',
  'approved', 'rejected', 'expired', 'cancelled',
];
const brokerConnectionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  brokerId: { type: String, required: true, index: true },
  brokerUsername: { type: String, required: true, index: true },
  brokerCompanyName: { type: String, default: '' },
  carrierId: { type: String, required: true, index: true },
  carrierUsername: { type: String, required: true, index: true },
  carrierCompanyName: { type: String, default: '' },
  loadId: { type: String, required: true, index: true }, // BookingRequest.tokenNo
  shipperId: { type: String, default: '' },
  shipperUsername: { type: String, default: '' },
  shipperCompanyName: { type: String, default: '' },
  truckId: { type: String, required: true },
  vehicleNumber: { type: String, default: '' },
  // Populated once the broker actually places an offer for this connection
  // (see POST /api/broker/connections/:id/bid in server_load.js) — that
  // route creates a real lib/biddingModels.js Bid document; this is just
  // that Bid's own `id`, so this connection's status can be kept in sync
  // whenever the real bid's status changes (accept/reject/withdraw), without
  // ever duplicating the bid's own fields (amount, margin, etc.) here.
  bidId: { type: String, default: '' },
  status: { type: String, enum: BROKER_CONNECTION_STATUSES, default: 'pending', index: true },
  // The spec's requested status vocabulary includes two notification
  // checkpoints (shipper_notified / carrier_notified) that, in this app's
  // actual workflow, fire TOGETHER the moment a connection is created —
  // `status` still moves through them as one coarse lifecycle value
  // (pending -> shipper_notified -> negotiating -> approved/rejected/
  // cancelled/expired), while these two timestamps record the precise,
  // independent fact of "did this specific party's notification actually
  // go out" for the UI/audit trail without needing a second status field.
  shipperNotifiedAt: { type: Date, default: null },
  carrierNotifiedAt: { type: Date, default: null },
  notes: { type: String, default: '' },
  // Append-only audit trail — never rewritten, so "what happened to this
  // connection, in order" is always answerable without cross-referencing
  // ActivityLog/TrackingEvent (spec: "Show the connection status to the
  // Broker").
  statusHistory: {
    type: [{
      status: { type: String, required: true },
      at: { type: Date, default: Date.now },
      note: { type: String, default: '' },
    }],
    default: [],
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { strict: true });
brokerConnectionSchema.index({ brokerUsername: 1, status: 1, createdAt: -1 });
brokerConnectionSchema.index({ loadId: 1, carrierUsername: 1 });
brokerConnectionSchema.index({ bidId: 1 }, { sparse: true });
const BrokerConnection = mongoose.model('BrokerConnection', brokerConnectionSchema);

// ---------- CarrierConnection ----------
// A GENERAL broker<->carrier networking/roster relationship — deliberately
// separate from BrokerConnection above, which tracks one specific
// broker+carrier+truck+load+shipper WORKFLOW instance (a live negotiation).
// This one is simpler and load-independent: "add this carrier to my
// network so I can work with them repeatedly" — the Carrier Connect page's
// Connect/Accept/Reject/Cancel buttons and "My Connected Carriers" list.
const CARRIER_CONNECTION_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'];
const carrierConnectionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  brokerId: { type: String, required: true, index: true },
  brokerUsername: { type: String, required: true, index: true },
  brokerCompanyName: { type: String, default: '' },
  carrierId: { type: String, required: true, index: true },
  carrierUsername: { type: String, required: true, index: true },
  carrierCompanyName: { type: String, default: '' },
  status: { type: String, enum: CARRIER_CONNECTION_STATUSES, default: 'PENDING', index: true },
  message: { type: String, default: '' }, // optional note the broker sends with the connection request
  respondedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { strict: true });
// A broker may only ever have ONE non-cancelled/non-rejected connection
// record per carrier — re-sending after a REJECTED/CANCELLED one is still
// allowed (a partial unique index, not a blanket unique pair), so
// "duplicate connection" prevention is enforced at the DB level for the
// case that actually matters (an already PENDING or ACCEPTED request).
carrierConnectionSchema.index(
  { brokerUsername: 1, carrierUsername: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['PENDING', 'ACCEPTED'] } } }
);
const CarrierConnection = mongoose.model('CarrierConnection', carrierConnectionSchema);

// ---------- LoadCarrierInvite ----------
// A lightweight, idempotent record of "broker invited this carrier to bid
// on this specific load" (Load Board / Carrier Connect "Invite to load" /
// "Send bid invitation" actions) — separate from CarrierConnection (which
// is load-independent) and from BrokerConnection (which additionally binds
// a specific truck and drives an actual bid/negotiation on the broker's
// OWN behalf). An invite never itself creates a bid — it only notifies the
// carrier that they're welcome to submit one through the normal, existing
// carrier bidding flow.
const loadCarrierInviteSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  brokerId: { type: String, required: true, index: true },
  brokerUsername: { type: String, required: true, index: true },
  loadId: { type: String, required: true, index: true }, // BookingRequest.tokenNo
  carrierId: { type: String, required: true, index: true },
  carrierUsername: { type: String, required: true, index: true },
  carrierCompanyName: { type: String, default: '' },
  status: { type: String, enum: ['INVITED', 'RESPONDED'], default: 'INVITED' },
  createdAt: { type: Date, default: Date.now },
}, { strict: true });
// Prevents the same broker inviting the same carrier to the same load
// more than once (spec: "Avoid duplicate requests").
loadCarrierInviteSchema.index({ brokerUsername: 1, loadId: 1, carrierUsername: 1 }, { unique: true });
const LoadCarrierInvite = mongoose.model('LoadCarrierInvite', loadCarrierInviteSchema);

module.exports = {
  BrokerSavedLoad, BROKER_SAVED_LOAD_STATUSES,
  BrokerConnection, BROKER_CONNECTION_STATUSES,
  CarrierConnection, CARRIER_CONNECTION_STATUSES,
  LoadCarrierInvite,
};
