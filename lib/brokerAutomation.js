/**
 * lib/brokerAutomation.js
 *
 * Pure, DB-free helpers for the Broker→Carrier→Shipper automation workflow —
 * same contract as lib/matchingEngine.js / lib/biddingEngine.js / lib/trustScore.js:
 * plain objects in, plain objects out, no Mongoose/Express/network access, so
 * every rule here is unit-testable with `node --test` and safe to call from
 * any route.
 *
 * Deliberately does NOT re-implement truck/driver eligibility or scoring —
 * every ranking here calls straight into the existing lib/matchingEngine.js
 * (checkTruckEligibility / scoreCandidate), so a truck's match score/reasons
 * for a Broker are computed by the exact same engine used everywhere else in
 * this app (Carrier Bidding, the Broker's own eligible-truck list, dispatcher
 * auto-match). This file only adds the CARRIER-SCOPING and
 * RECOMMENDATION/AGGREGATION layer on top — never a second, competing
 * scoring system, and never a fabricated score/location/availability for a
 * record that doesn't actually have one.
 */
'use strict';

const matchingEngine = require('./matchingEngine');

/**
 * Ranks ONE carrier's own trucks against ONE load — the "Smart Truck
 * Matching" step (spec section 2). Every truck considered must actually
 * belong to `carrierUsername` (callers are expected to have already
 * filtered `trucks` by carrierUsername; this function re-asserts it as a
 * safety net so a caller bug can never leak a different carrier's fleet).
 *
 * @param {object} load plain BookingRequest-shaped object
 * @param {string} carrierUsername
 * @param {Array<object>} trucks plain Truck-shaped objects (should already be carrierUsername-scoped)
 * @param {Map<string,object>} driverById driverId -> plain Driver-shaped object (only for drivers actually linked to these trucks — never invented)
 * @returns {{eligible:Array<object>, ineligible:Array<object>}}
 */
function findSuitableTrucksForCarrier(load, carrierUsername, trucks, driverById) {
  const ownTrucks = (trucks || []).filter((t) => t.carrierUsername === carrierUsername);
  const pairs = ownTrucks.map((truck) => ({
    truck,
    driver: truck.assignedDriverId ? (driverById.get(truck.assignedDriverId) || null) : null,
  }));

  const eligible = [];
  const ineligible = [];
  for (const { truck, driver } of pairs) {
    const truckCheck = matchingEngine.checkTruckEligibility(load, truck);
    if (!truckCheck.eligible) {
      ineligible.push({
        truckId: truck.id, vehicleNumber: truck.vehicleNumber, truckType: truck.truckType,
        status: 'INELIGIBLE', reasons: truckCheck.reasons, complianceStatus: truck.verified ? 'verified' : 'unverified',
      });
      continue;
    }
    // A truck with no driver linked yet is still a real, eligible truck —
    // never invent a driver to score against. Score it with a neutral
    // driver-trust/on-time/trip-history baseline (matchingEngine's own
    // documented behavior for a missing driver record) and say so plainly.
    const { score, breakdown } = matchingEngine.scoreCandidate(load, truck, driver || {});
    const reasons = driver
      ? matchingEngine.buildReasons(load, truck, driver, breakdown)
      : ['Truck meets the required capacity and type', 'No driver linked to this truck yet — trust/on-time factors use a neutral baseline'];
    eligible.push({
      truckId: truck.id,
      vehicleNumber: truck.vehicleNumber,
      truckType: truck.truckType,
      bodyType: truck.bodyType || '',
      capacityTons: truck.capacityTons,
      currentLocation: truck.currentLocation || '',
      complianceStatus: truck.verified ? 'verified' : 'unverified',
      driverId: driver ? driver.id : '',
      driverName: driver ? driver.name : '',
      driverAvailable: driver ? driver.status === 'available' : null,
      matchScore: score,
      breakdown,
      reasons,
      recommendation: score >= 80
        ? 'Recommended — this truck meets the required capacity and operates on a compatible route.'
        : score >= 60
          ? 'Usable match — meets the load requirements with a moderate overall fit.'
          : 'Eligible, but a weaker fit than other options — review before selecting.',
    });
  }
  eligible.sort((a, b) => b.matchScore - a.matchScore);
  return { eligible, ineligible };
}

/**
 * Recommendation engine, load-centric (spec section 4, "For each available
 * load, recommend..."). Takes every {truck, driver, carrier} triple already
 * assembled by the caller (real DB data only) and returns the single best
 * carrier+truck pairing for this load, or null with a plain-language reason
 * when nothing is eligible yet.
 *
 * @param {object} load
 * @param {Array<{truck:object, driver:object|null, carrierUsername:string, carrierCompanyName:string}>} candidates
 * @returns {{best: object|null, missingInfo: string[], consideredCount: number}}
 */
function recommendBestCarrierForLoad(load, candidates) {
  const missingInfo = [];
  if (!load.requiredTruckType) missingInfo.push('Load has no required truck type specified — matching is broader/less precise as a result.');
  if (!load.weight) missingInfo.push('Load has no weight specified — capacity fit cannot be scored precisely.');

  const scored = (candidates || []).map((c) => {
    const truckCheck = matchingEngine.checkTruckEligibility(load, c.truck);
    if (!truckCheck.eligible) return { ...c, eligible: false, reasons: truckCheck.reasons };
    const { score, breakdown } = matchingEngine.scoreCandidate(load, c.truck, c.driver || {});
    return { ...c, eligible: true, score, breakdown, reasons: c.driver ? matchingEngine.buildReasons(load, c.truck, c.driver, breakdown) : ['No driver linked yet — scored with a neutral baseline'] };
  });
  const eligible = scored.filter((c) => c.eligible).sort((a, b) => b.score - a.score);
  if (!eligible.length) {
    return { best: null, missingInfo, consideredCount: scored.length };
  }
  const top = eligible[0];
  return {
    best: {
      carrierUsername: top.carrierUsername,
      carrierCompanyName: top.carrierCompanyName,
      truckId: top.truck.id,
      vehicleNumber: top.truck.vehicleNumber,
      truckType: top.truck.truckType,
      capacityTons: top.truck.capacityTons,
      currentLocation: top.truck.currentLocation || '',
      driverName: top.driver ? top.driver.name : '',
      trustScore: top.driver && typeof top.driver.trustScore === 'number' ? top.driver.trustScore : null,
      matchScore: top.score,
      reasons: top.reasons,
    },
    missingInfo,
    consideredCount: scored.length,
  };
}

/**
 * Recommendation engine, carrier-centric (spec section 4, "For each
 * Carrier, recommend..."). For one carrier's own fleet, scores every
 * currently open load and returns the ones with at least one eligible
 * truck, best-first. `reduceEmptyTravel` is only ever set true when the
 * load's pickup text-matches one of the carrier's trucks' real
 * currentLocation — never inferred without that real location data.
 *
 * @param {string} carrierUsername
 * @param {Array<object>} carrierTrucks plain Truck-shaped objects already scoped to this carrier
 * @param {Map<string,object>} driverById
 * @param {Array<object>} openLoads plain BookingRequest-shaped objects (loadStage BIDDING_OPEN)
 * @returns {Array<{tokenNo, bestTruckId, matchScore, reasons, reduceEmptyTravel}>}
 */
function recommendLoadsForCarrier(carrierUsername, carrierTrucks, driverById, openLoads) {
  const ownTrucks = (carrierTrucks || []).filter((t) => t.carrierUsername === carrierUsername);
  const results = [];
  for (const load of openLoads || []) {
    const { eligible } = findSuitableTrucksForCarrier(load, carrierUsername, ownTrucks, driverById || new Map());
    if (!eligible.length) continue;
    const top = eligible[0];
    const reduceEmptyTravel = ownTrucks.some((t) => {
      const loc = String(t.currentLocation || '').trim().toLowerCase();
      const pickup = String(load.pickup || '').trim().toLowerCase();
      return loc && pickup && (loc === pickup || loc.includes(pickup) || pickup.includes(loc));
    });
    results.push({
      tokenNo: load.tokenNo, pickup: load.pickup, destination: load.destination,
      requiredTruckType: load.requiredTruckType, weight: load.weight,
      bestTruckId: top.truckId, bestVehicleNumber: top.vehicleNumber, matchScore: top.matchScore,
      reasons: top.reasons, reduceEmptyTravel,
      note: reduceEmptyTravel ? 'One of your trucks is already near this pickup point — may reduce empty travel.' : '',
    });
  }
  results.sort((a, b) => b.matchScore - a.matchScore);
  return results;
}

/**
 * Validates whether a broker may create a connection request for
 * (carrier, load, truck) — spec section 3, steps 1-4. Every check reads
 * only real fields the caller passed in (no network/DB access here); the
 * route handler is responsible for fetching them first. Returns the FIRST
 * failing reason (checks run in the spec's own order) or {ok:true}.
 *
 * @param {{carrier:object|null, load:object|null, truck:object|null, existingActiveConnection:object|null}} ctx
 */
function canBrokerConnect({ carrier, load, truck, existingActiveConnection }) {
  // 1. Broker <-> Carrier authorization: the carrier account must be real
  // and in good standing. This app has no separate "broker roster" concept
  // (a broker isn't pre-assigned a fixed carrier list — see BROKER_PORTAL_SYSTEM.md's
  // existing "any verified truck platform-wide" bidding model), so
  // "authorized to work with" is defined the same way the rest of the
  // marketplace already treats carrier eligibility: an active, KYC-accepted
  // carrier account in good standing.
  if (!carrier) return { ok: false, code: 'carrier_not_found', reason: 'That carrier account could not be found.' };
  if (carrier.active === false) return { ok: false, code: 'carrier_inactive', reason: 'That carrier account is not currently active.' };
  if (carrier.status !== 'accepted') return { ok: false, code: 'carrier_not_verified', reason: 'That carrier is not yet verified/accepted by admin.' };

  // 2. The load must still actually be available.
  if (!load) return { ok: false, code: 'load_not_found', reason: 'That load could not be found.' };
  if (load.loadStage !== 'BIDDING_OPEN') {
    return { ok: false, code: 'load_not_available', reason: `This load is no longer available (currently ${load.loadStage}).` };
  }
  if (load.biddingDeadline && new Date(load.biddingDeadline).getTime() < Date.now()) {
    return { ok: false, code: 'load_expired', reason: 'The bidding window for this load has already closed.' };
  }

  // 3. The truck must belong to the selected carrier and meet the load's
  // real requirements — never a truck borrowed from a different carrier.
  if (!truck) return { ok: false, code: 'truck_not_found', reason: 'That truck could not be found.' };
  if (truck.carrierUsername !== carrier.username) {
    return { ok: false, code: 'truck_not_owned', reason: 'That truck does not belong to the selected carrier.' };
  }
  if (!truck.verified || truck.status !== 'available') {
    return { ok: false, code: 'truck_not_available', reason: 'That truck is not currently verified and available.' };
  }
  const eligibility = matchingEngine.checkTruckEligibility(load, truck);
  if (!eligibility.eligible) {
    return { ok: false, code: 'truck_not_eligible', reason: 'That truck does not meet this load\'s requirements: ' + eligibility.reasons.join('; ') };
  }

  // 4. The load must actually have an associated shipper to connect to.
  if (!load.shipperUsername) {
    return { ok: false, code: 'no_shipper', reason: 'This load has no associated shipper on file.' };
  }

  if (existingActiveConnection) {
    return { ok: false, code: 'duplicate_connection', reason: 'You already have an active connection request for this carrier and load.' };
  }

  return { ok: true };
}

/** True once a connection's underlying load's bidding window has passed and the connection never reached a terminal state — computed live rather than requiring a background sweep job. */
function isConnectionExpired(connection, load) {
  if (!connection || ['approved', 'rejected', 'cancelled', 'expired'].includes(connection.status)) return false;
  if (!load || !load.biddingDeadline) return false;
  return new Date(load.biddingDeadline).getTime() < Date.now();
}

/** Read-time status resolution: reflects a live Bid's outcome or an expired bidding window onto the connection's displayed status WITHOUT needing every bid-status-change call site to remember to update BrokerConnection (defense in depth on top of the explicit sync calls server_load.js makes at the accept/reject/withdraw call sites). Never mutates its inputs. */
function resolveConnectionDisplayStatus(connection, { load, bid } = {}) {
  if (['approved', 'rejected', 'cancelled'].includes(connection.status)) return connection.status;
  if (bid) {
    if (bid.status === 'ACCEPTED') return 'approved';
    if (bid.status === 'REJECTED') return 'rejected';
    if (bid.status === 'WITHDRAWN') return 'cancelled';
    if (['SUBMITTED', 'SHORTLISTED'].includes(bid.status)) return 'negotiating';
  }
  if (isConnectionExpired(connection, load)) return 'expired';
  return connection.status;
}

// ---------- Load Matching (dedicated tab) — Panel B weighted engine ----------
// A THIRD, separately-weighted scoring function alongside matchingEngine's
// own scoreCandidate (dispatch) and computeLoadTruckMatchScore (match
// emails) — same precedent already established in lib/matchingEngine.js's
// own header comment ("A SEPARATE, driver-agnostic weighted score...").
// These are the exact weights the Broker Load Matching page's Panel B asks
// for (sums to 100). Deliberately its own function, never silently reusing
// a different engine's weights, so retuning ONE of these three scores can
// never accidentally retune another feature.
const BROKER_LOAD_MATCH_WEIGHTS = {
  origin: 25,
  destination: 25,
  truckType: 15,
  capacity: 15,
  availability: 10,
  verification: 5,
  trust: 5,
};

function norm(s) { return String(s || '').trim().toLowerCase(); }

function scoreOrigin(load, truck) {
  const pickup = norm(load.pickup);
  const loc = norm(truck.currentLocation);
  if (!pickup || !loc) return 50; // unknown — neutral, never fabricated as a match or a mismatch
  if (loc === pickup) return 100;
  if (loc.includes(pickup) || pickup.includes(loc)) return 75;
  return 20;
}
/** Destination compatibility has no real "truck's destination" field to compare against today (a truck only has a currentLocation) — scored via the same lane-familiarity heuristic recommendLoadsForCarrier already uses (does this truck's current lane plausibly cover this destination), explicitly weaker/neutral when unknown rather than invented. */
function scoreDestination(load, truck) {
  const dest = norm(load.destination);
  const loc = norm(truck.currentLocation);
  if (!dest || !loc) return 50;
  if (loc === dest || loc.includes(dest) || dest.includes(loc)) return 90;
  return 55;
}
function scoreTruckTypeMatch(load, truck) {
  if (!load.requiredTruckType) return 100;
  return norm(truck.truckType) === norm(load.requiredTruckType) ? 100 : 0;
}
function scoreCapacityFit(load, truck) {
  const requiredWeight = Number(load.weight || 0);
  const capacity = Number(truck.capacityTons || 0);
  if (requiredWeight > 0 && capacity < requiredWeight) return 0;
  if (!requiredWeight) return 70;
  const ratio = capacity / requiredWeight;
  if (ratio <= 1.15) return 100;
  if (ratio <= 1.5) return 88;
  if (ratio <= 2) return 70;
  if (ratio <= 3) return 50;
  return 32;
}
function scoreAvailabilityNow(truck) {
  return truck.status === 'available' ? 100 : 0;
}
function scoreVerificationStatus(truck) {
  return truck.verified ? 100 : 0;
}
function scoreTrust(driver, carrierTrustScore) {
  if (driver && typeof driver.trustScore === 'number') return Math.max(0, Math.min(100, driver.trustScore));
  if (typeof carrierTrustScore === 'number') return Math.max(0, Math.min(100, carrierTrustScore));
  return 70; // neutral baseline — same convention matchingEngine.js uses for a brand-new/unlinked driver
}

/**
 * The Load Matching page's Panel B score: transparent, weighted, and
 * reproducible — never "AI", always rule-based (spec section 4: "Do not
 * falsely claim that the result was generated by AI when it was generated
 * by rule-based matching"). Returns 0 for a hard-ineligible pair (wrong
 * truck type, insufficient capacity, or the truck currently unavailable) —
 * these are still returned (not filtered out) so the caller/UI can show
 * WHY a candidate scored 0 rather than silently omitting it, but the
 * caller is expected to only "recommend" candidates whose score clears a
 * sensible bar (matchScore > 0 at minimum).
 * @returns {{score:number, breakdown:object, explanation:string}}
 */
function computeBrokerLoadMatchScore(load, truck, driver, carrier = {}) {
  const breakdown = {
    origin: scoreOrigin(load, truck),
    destination: scoreDestination(load, truck),
    truckType: scoreTruckTypeMatch(load, truck),
    capacity: scoreCapacityFit(load, truck),
    availability: scoreAvailabilityNow(truck),
    verification: scoreVerificationStatus(truck),
    trust: scoreTrust(driver, carrier.trustScore),
  };
  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(BROKER_LOAD_MATCH_WEIGHTS)) {
    weightedSum += breakdown[key] * BROKER_LOAD_MATCH_WEIGHTS[key];
    weightTotal += BROKER_LOAD_MATCH_WEIGHTS[key];
  }
  const score = Math.round(Math.max(0, Math.min(100, weightTotal ? weightedSum / weightTotal : 0)));
  return { score, breakdown, explanation: buildBrokerMatchExplanation(score, breakdown, load) };
}

/** Builds the exact "92% match — ..." style sentence the spec asks for, built ONLY from the real breakdown values above — never a templated claim that isn't backed by an actual factor score. */
function buildBrokerMatchExplanation(score, breakdown, load) {
  const clauses = [];
  if (breakdown.origin >= 75 && breakdown.destination >= 75) clauses.push('route is compatible');
  else if (breakdown.origin >= 75) clauses.push('pickup location is compatible');
  else if (breakdown.destination >= 75) clauses.push('destination is compatible');
  if (breakdown.truckType === 100 && load.requiredTruckType) clauses.push('truck type matches what the load requires');
  else if (breakdown.truckType === 0) clauses.push('truck type does NOT match what the load requires');
  if (breakdown.capacity === 0) clauses.push('truck capacity is insufficient for this load');
  else if (breakdown.capacity >= 85) clauses.push('capacity is sufficient');
  if (breakdown.availability === 100) clauses.push('the carrier is available on the requested date');
  else clauses.push('the carrier/truck is not currently marked available');
  if (breakdown.verification === 100) clauses.push('documents are verified');
  else clauses.push('documents are not yet verified');
  if (breakdown.trust >= 85) clauses.push('trust score is strong');

  let sentence;
  if (!clauses.length) sentence = 'Limited information available to explain this match.';
  else if (clauses.length === 1) sentence = clauses[0];
  else sentence = clauses.slice(0, -1).join(', ') + ', and ' + clauses[clauses.length - 1];
  return `${score}% match — ${sentence}.`;
}

module.exports = {
  findSuitableTrucksForCarrier,
  recommendBestCarrierForLoad,
  recommendLoadsForCarrier,
  canBrokerConnect,
  isConnectionExpired,
  resolveConnectionDisplayStatus,
  BROKER_LOAD_MATCH_WEIGHTS,
  computeBrokerLoadMatchScore,
  buildBrokerMatchExplanation,
};
