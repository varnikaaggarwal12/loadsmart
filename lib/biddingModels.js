/**
 * lib/biddingModels.js
 *
 * New Mongoose models for the Carrier Bidding + LoadSmart Margin system —
 * kept in their own file, same additive pattern already used by
 * lib/opsModels.js / lib/matchingEngine.js / lib/trustScore.js. Nothing
 * here changes or removes any existing model. See server_load.js's
 * "Carrier Bidding System" section for the routes that use these.
 *
 * Required once from server_load.js:
 *   const bidding = require('./lib/biddingModels');
 */
const mongoose = require('mongoose');

// ---------- Bid ----------
// One row per carrier bid on one load. A carrier may have at most one
// ACTIVE (SUBMITTED or SHORTLISTED) bid per load at a time — enforced in
// the submit-bid route, not here, so the error message can be specific.
const BID_STATUSES = ['SUBMITTED', 'SHORTLISTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'];
const bidSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  // BookingRequest.tokenNo — same "Token No. is the one link" convention
  // used everywhere else in this app (see bookingRequestSchema comment).
  loadId: { type: String, required: true, index: true },
  carrierUsername: { type: String, required: true, index: true },
  carrierCompanyName: { type: String, default: '' },
  // ---------- Broker module addition ----------
  // A Broker can also submit a bid (spec section 6) — reusing this exact
  // Bid model/engine rather than a second, competing bidding system.
  // `carrierUsername` above is still always populated (a broker must still
  // pick one eligible, verified truck to bid with — see
  // POST /api/broker/loads/:token/bids in server_load.js — so every
  // existing carrier-bidding invariant, index and query keeps working
  // completely unchanged); these two fields are purely additive metadata
  // recording WHICH broker placed it, defaulting to '' for every existing
  // carrier-submitted bid.
  submittedByRole: { type: String, enum: ['carrier', 'broker'], default: 'carrier' },
  brokerUsername: { type: String, default: '', index: true },
  brokerCompanyName: { type: String, default: '' },
  // The specific truck (from the carrier's own fleet, see server_load.js's
  // Truck/Driver models) this bid is offering — required so eligibility
  // (capacity/type/verification) and later AI-match/trust ranking can be
  // computed per bid without guessing which vehicle would be used.
  truckId: { type: String, required: true },
  vehicleNumber: { type: String, default: '' },
  // Best-effort snapshot of the truck's driver at bid time — the live
  // truck.assignedDriverId is still re-read at ranking/accept time in case
  // it changed, this is just for quick display.
  driverId: { type: String, default: '' },
  bidAmount: { type: Number, required: true }, // what the CARRIER would be paid — never shown to the shipper
  notes: { type: String, default: '' },
  status: { type: String, enum: BID_STATUSES, default: 'SUBMITTED', index: true },
  // ---------- Pricing snapshot ----------
  // Populated ONLY once this bid is ACCEPTED (see acceptBidTransactional in
  // server_load.js) — an immutable audit record of exactly what margin
  // rule produced the shipper's final price at the moment of acceptance,
  // even if the global MarginConfiguration is changed later.
  marginType: { type: String, default: '' },
  marginValue: { type: Number, default: null },
  marginAmount: { type: Number, default: null },
  finalShipperPrice: { type: Number, default: null },
  acceptedAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: '' },
  withdrawnAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true },
}, { strict: true });
// Per the spec's required index list (Bid.loadId, Bid.carrierId,
// Bid.status, Bid.createdAt) — carrierUsername/loadId already get a
// single-field index from `index: true` above; these compound indexes
// cover the two hot queries: "all active bids on this load" and "all of
// this carrier's bids by status".
bidSchema.index({ loadId: 1, status: 1 });
bidSchema.index({ carrierUsername: 1, status: 1 });
const Bid = mongoose.model('Bid', bidSchema);

// ---------- MarginConfiguration ----------
// Single-document collection (same "one row, upsert-on-read" pattern as
// the existing `Settings` model in server_load.js) holding LoadSmart's
// current margin rule, plus a full audit history of every change — never
// overwritten, only appended to, so "who changed the margin, when, and
// from what" is always answerable (spec: "keep history of margin changes
// for audit").
const MARGIN_TYPES = ['FIXED', 'PERCENTAGE'];
const marginConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true },
  marginType: { type: String, enum: MARGIN_TYPES, default: 'PERCENTAGE' },
  // PERCENTAGE: percentage points added on top of the carrier's bid (e.g.
  // 10 = +10%). FIXED: a flat currency amount added on top, regardless of
  // bid size.
  marginValue: { type: Number, default: 10 },
  // Optional floor/ceiling on the computed margin AMOUNT (not the
  // percentage) — e.g. "never less than ₹500, never more than ₹15,000"
  // even on a PERCENTAGE rule. Either can be left null to mean "no bound".
  minMargin: { type: Number, default: null },
  maxMargin: { type: Number, default: null },
  updatedBy: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now },
  history: [{
    marginType: String,
    marginValue: Number,
    minMargin: Number,
    maxMargin: Number,
    changedBy: { type: String, default: '' },
    changedAt: { type: Date, default: Date.now },
    reason: { type: String, default: '' },
  }],
}, { strict: true });
const MarginConfiguration = mongoose.model('MarginConfiguration', marginConfigSchema);

/** Reads the single margin config row, creating the default one on first use. */
async function getMarginConfig() {
  let cfg = await MarginConfiguration.findOne({ key: 'default' });
  if (!cfg) cfg = await MarginConfiguration.create({ key: 'default' });
  return cfg;
}

module.exports = { Bid, BID_STATUSES, MarginConfiguration, MARGIN_TYPES, getMarginConfig };
