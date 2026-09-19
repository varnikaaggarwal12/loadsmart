/**
 * lib/matchingEngine.js
 * Load Smart — Smart Load -> Truck -> Driver Matching engine.
 *
 * Pure, deterministic, DB-free — every function here takes plain
 * load/truck/driver objects (e.g. the result of a Mongoose `.lean()`
 * query) and returns plain data. No network calls, no LLM calls, no
 * randomness. This is intentional (see the project brief): the AI
 * chatbot is allowed to EXPLAIN what this engine decided, never to
 * replace the decision itself.
 *
 * Two-phase design, per spec:
 *   1. Hard eligibility filtering (checkTruckEligibility /
 *      checkDriverEligibility) — a candidate that fails ANY hard rule is
 *      marked INELIGIBLE with the specific reason(s) and never scored.
 *      A too-small truck is not "a low score" — it's ineligible.
 *   2. Weighted scoring (scoreCandidate) — only run on candidates that
 *      passed phase 1. Combines seven weighted factors (MATCH_WEIGHTS,
 *      one config object, easy to retune) into a single 0-100 match
 *      score with a full breakdown for the "why this candidate" UI.
 *
 * `rankCandidates` ties both phases together for a whole pool of
 * truck/driver pairs and returns them sorted, ready for the dispatcher
 * dashboard, the `/matches` API, and the chatbot's FIND_MATCHES action.
 */
'use strict';

// Sums to 100. Change weights here — nowhere else — to retune matching.
const MATCH_WEIGHTS = {
  truckCompatibility: 25, // capacity fit + truck/body type match quality
  routeCompatibility: 20, // how close the truck's current location is to pickup
  availability: 15,       // truck & driver free to take this load right now
  capacity: 10,           // how well-suited the truck's capacity is (not oversized/undersized)
  driverTrust: 15,        // the driver's Trust Score (see lib/trustScore.js)
  onTimePerformance: 10,  // driver's recent on-time delivery rate
  tripHistory: 5,         // driver's track record depth (completed trips)
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function norm(str) {
  return String(str || '').trim().toLowerCase();
}

/**
 * Phase 1a — hard truck eligibility. Returns {eligible, reasons}.
 * `reasons` is always populated when ineligible (why), and left empty
 * when eligible (positive reasons are built separately by
 * `buildReasons`, once we know it's actually being scored/ranked).
 */
function checkTruckEligibility(load, truck) {
  const reasons = [];
  if (!truck) {
    return { eligible: false, reasons: ['No truck record'] };
  }
  if (!truck.verified) reasons.push('Truck documents are not verified');
  if (truck.status === 'maintenance') reasons.push('Truck is currently under maintenance');
  else if (truck.status && truck.status !== 'available') {
    reasons.push(`Truck is currently ${String(truck.status).replace(/_/g, ' ')}`);
  }
  const requiredWeight = Number(load.weight || 0);
  const capacity = Number(truck.capacityTons || 0);
  if (requiredWeight > 0 && capacity < requiredWeight) {
    reasons.push(`Truck capacity (${capacity}t) is below the required ${requiredWeight}t`);
  }
  if (load.requiredTruckType && norm(truck.truckType) !== norm(load.requiredTruckType)) {
    reasons.push(`Truck type "${truck.truckType || '—'}" does not match the required "${load.requiredTruckType}"`);
  }
  if (load.requiredBodyType && norm(truck.bodyType) !== norm(load.requiredBodyType)) {
    reasons.push(`Body type "${truck.bodyType || '—'}" does not match the required "${load.requiredBodyType}"`);
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Phase 1b — hard driver eligibility. `truck` is passed so we can check
 * the driver is actually linked to (qualified for) this specific truck
 * when the app's truck<->driver relationship is in use.
 */
function checkDriverEligibility(load, driver, truck) {
  if (!driver) {
    return { eligible: false, reasons: ['No driver linked to this truck'] };
  }
  const reasons = [];
  if (driver.blocked) reasons.push('Driver is blocked/suspended');
  if (!driver.verified) reasons.push('Driver documents are not verified');
  if (driver.status && driver.status !== 'available') {
    reasons.push(`Driver is currently ${String(driver.status).replace(/_/g, ' ')}`);
  }
  if (driver.licenseExpiry && new Date(driver.licenseExpiry).getTime() < Date.now()) {
    reasons.push('Driver license has expired');
  }
  if (truck && truck.id && driver.assignedTruckId && driver.assignedTruckId !== truck.id) {
    reasons.push('Driver is not qualified/linked for this truck');
  }
  return { eligible: reasons.length === 0, reasons };
}

// ---------- Phase 2 — weighted scoring (only for eligible pairs) ----------

/** Capacity fit + type match quality, 0-100. Already-eligible trucks pass the hard capacity/type checks, so this only differentiates HOW well they fit. */
function scoreTruckCompatibility(load, truck) {
  const requiredWeight = Number(load.weight || 0);
  const capacity = Number(truck.capacityTons || 0);
  const unused = Math.max(0, capacity - requiredWeight);
  // Prefer the tightest reasonable fit over the biggest truck available —
  // wasting a 32-ft container on a 1-ton load is a poor match even though
  // it's technically eligible.
  let score = 100 - Math.min(55, unused * 2.5);
  return Math.round(clamp(score, 40, 100));
}

/** How close the truck's current location is to the pickup point. Text-match today (no live geocoding wired into the fleet side yet) — same signal the pre-existing engine used, kept and documented rather than silently dropped. */
function scoreRouteCompatibility(load, truck) {
  const pickup = norm(load.pickup);
  const loc = norm(truck.currentLocation);
  if (!pickup || !loc) return 55; // unknown — neutral-low, not penalized as if mismatched
  if (loc === pickup) return 100;
  if (loc.includes(pickup) || pickup.includes(loc)) return 78;
  return 45;
}

/** Both already passed the hard "available now" check to get here — this only exists as its own weighted factor because the brief calls it out separately (e.g. a truck freed up seconds ago vs. one that's been sitting idle is equally "available" today; kept as a flat 100 with room to add finer-grained signals like queue position later). */
function scoreAvailability() {
  return 100;
}

/** Distinct from truckCompatibility: rewards a capacity that's proportionate to the load rather than wildly oversized, even when the raw-tons gap (used above) is small in absolute terms but large in ratio (e.g. a 2-ton load in a 40-ton trailer). */
function scoreCapacitySuitability(load, truck) {
  const requiredWeight = Number(load.weight || 0) || 1;
  const capacity = Number(truck.capacityTons || 0);
  const ratio = capacity / requiredWeight;
  if (ratio <= 1.15) return 100;
  if (ratio <= 1.5) return 88;
  if (ratio <= 2) return 70;
  if (ratio <= 3) return 50;
  return 32;
}

function scoreDriverTrust(driver) {
  return Math.round(clamp(driver.trustScore != null ? driver.trustScore : 70, 0, 100));
}

function scoreOnTimePerformance(driver) {
  const rate = driver.trustBreakdown && driver.trustBreakdown.onTimeRate != null ? driver.trustBreakdown.onTimeRate : 85;
  return Math.round(clamp(rate, 0, 100));
}

function scoreTripHistory(driver) {
  const total = Number(driver.completedTrips || 0);
  if (total >= 100) return 100;
  if (total >= 50) return 90;
  if (total >= 20) return 80;
  if (total >= 5) return 65;
  if (total >= 1) return 55;
  return 50; // brand-new driver — neutral, not penalized for being new
}

/**
 * Combines all seven factors into one weighted 0-100 score, with the
 * full per-factor breakdown (used for the "Truck compatibility: 100%"
 * style UI and the chatbot's explanation text).
 */
function scoreCandidate(load, truck, driver) {
  const breakdown = {
    truckCompatibility: scoreTruckCompatibility(load, truck),
    routeCompatibility: scoreRouteCompatibility(load, truck),
    availability: scoreAvailability(),
    capacity: scoreCapacitySuitability(load, truck),
    driverTrust: scoreDriverTrust(driver),
    onTimePerformance: scoreOnTimePerformance(driver),
    tripHistory: scoreTripHistory(driver),
  };
  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(MATCH_WEIGHTS)) {
    weightedSum += breakdown[key] * MATCH_WEIGHTS[key];
    weightTotal += MATCH_WEIGHTS[key];
  }
  const score = Math.round(clamp(weightTotal ? weightedSum / weightTotal : 0, 0, 100));
  return { score, breakdown };
}

/** Plain-English bullets for the dispatcher UI and the chatbot's "why this one" answer. */
function buildReasons(load, truck, driver, breakdown) {
  const reasons = [];
  reasons.push(
    breakdown.truckCompatibility >= 85
      ? 'Truck capacity is a strong fit for this cargo'
      : 'Truck capacity meets the requirement'
  );
  if (load.requiredTruckType) reasons.push(`Truck type matches "${load.requiredTruckType}"`);
  if (breakdown.routeCompatibility >= 95) reasons.push('Truck is already at the pickup location');
  else if (breakdown.routeCompatibility >= 70) reasons.push('Truck is near the pickup location');
  reasons.push('Truck and driver are both currently available');
  reasons.push('Vehicle documents are verified');
  if (breakdown.driverTrust >= 90) reasons.push(`Excellent driver trust score (${breakdown.driverTrust}/100)`);
  else if (breakdown.driverTrust >= 75) reasons.push(`Strong driver trust score (${breakdown.driverTrust}/100)`);
  else reasons.push(`Driver trust score: ${breakdown.driverTrust}/100`);
  if (breakdown.onTimePerformance >= 90) reasons.push(`Excellent on-time delivery history (${breakdown.onTimePerformance}%)`);
  const trips = Number(driver.completedTrips || 0);
  reasons.push(trips > 0 ? `${trips} completed trip${trips === 1 ? '' : 's'}` : 'New driver — no completed trips yet');
  return reasons;
}

/**
 * Scores + ranks a pool of {truck, driver} pairs against one load.
 * Returns { eligible: [...sorted desc by score], ineligible: [...] }.
 * Every entry (eligible or not) carries `truckId`/`driverId` plus enough
 * of the truck/driver record for the UI to render without a second
 * lookup.
 */
function rankCandidates(load, pairs) {
  const eligible = [];
  const ineligible = [];

  for (const pair of pairs) {
    const { truck, driver } = pair;
    const truckCheck = checkTruckEligibility(load, truck);
    const driverCheck = checkDriverEligibility(load, driver, truck);
    const eligibleNow = truckCheck.eligible && driverCheck.eligible;
    const reasons = [...truckCheck.reasons, ...driverCheck.reasons];

    if (!eligibleNow) {
      ineligible.push({
        truckId: truck && truck.id,
        driverId: driver && driver.id,
        vehicleNumber: truck && truck.vehicleNumber,
        driverName: driver && driver.name,
        status: 'INELIGIBLE',
        reasons,
      });
      continue;
    }

    const { score, breakdown } = scoreCandidate(load, truck, driver);
    eligible.push({
      truckId: truck.id,
      driverId: driver.id,
      vehicleNumber: truck.vehicleNumber,
      truckType: truck.truckType,
      bodyType: truck.bodyType,
      capacityTons: truck.capacityTons,
      currentLocation: truck.currentLocation,
      driverName: driver.name,
      trustScore: Math.round(clamp(driver.trustScore != null ? driver.trustScore : 70, 0, 100)),
      onTimeRate: breakdown.onTimePerformance,
      completedTrips: Number(driver.completedTrips || 0),
      status: 'ELIGIBLE',
      matchScore: score,
      breakdown,
      reasons: buildReasons(load, truck, driver, breakdown),
    });
  }

  eligible.sort((a, b) => b.matchScore - a.matchScore);
  return { eligible, ineligible };
}

// ---------- Load<->Truck match score (email-notification system) ----------
// A SEPARATE, driver-agnostic weighted score — distinct from scoreCandidate
// above (which is driver-inclusive and drives actual dispatch/assignment).
// This one is what the email notification system (spec sections 4-6, "Load
// -> Truck Match Email" / "Truck -> Load Match Email") uses to decide
// whether a load and a truck are a good enough fit to email both parties
// about, gated by a configurable threshold (see lib/matchConfig.js) — a
// truck with no driver linked yet can still be "a great match for this
// load" worth emailing the carrier about, well before any driver/dispatch
// decision is made.
//
// Weights are the ones given in the spec, adapted onto this engine's
// existing signals (sums to 100):
const MATCH_EMAIL_WEIGHTS = {
  truckType: 30,     // does the truck's type match what the load requires
  capacity: 25,       // how well the truck's capacity fits the load's weight
  location: 20,        // how close the truck currently is to the pickup point
  availability: 15,   // is the truck actually free to take this load
  routeCompatibility: 10, // does the truck's current lane cover this route
};

/** 0-100: exact/no-requirement match scores 100, a real mismatch scores 0 — this is the one hard-ish factor inside an otherwise continuous score, since a wrong truck type is rarely a usable match even at a low weight. */
function scoreEmailTruckType(load, truck) {
  if (!load.requiredTruckType) return 100;
  return norm(truck.truckType) === norm(load.requiredTruckType) ? 100 : 0;
}

/** Reuses the same capacity-ratio curve as scoreCapacitySuitability — tightest reasonable fit scores highest. */
function scoreEmailCapacity(load, truck) {
  const requiredWeight = Number(load.weight || 0);
  const capacity = Number(truck.capacityTons || 0);
  if (requiredWeight > 0 && capacity < requiredWeight) return 0; // truck can't physically carry it
  return scoreCapacitySuitability(load, truck);
}

/** Reuses the same text-proximity heuristic as scoreRouteCompatibility. */
function scoreEmailLocation(load, truck) {
  return scoreRouteCompatibility(load, truck);
}

/** Truck must be operationally available right now, and — when the load specifies a pickup date — free by then. */
function scoreEmailAvailability(load, truck) {
  if (truck.status && truck.status !== 'available') return 0;
  if (!truck.verified) return 40; // usable signal, but unverified trucks are a materially weaker match
  if (load.pickupDateTime && truck.availableFrom) {
    const needBy = new Date(load.pickupDateTime).getTime();
    const freeFrom = new Date(truck.availableFrom).getTime();
    if (Number.isFinite(needBy) && Number.isFinite(freeFrom) && freeFrom > needBy) return 35;
  }
  return 100;
}

/** Coarse "does this truck already run this lane" signal: rewards a truck whose current location also relates to the load's destination (i.e. it's plausibly already covering pickup->destination), neutral when unknown. */
function scoreEmailRoute(load, truck) {
  const dest = norm(load.destination);
  const loc = norm(truck.currentLocation);
  if (!dest || !loc) return 55;
  if (loc === dest || loc.includes(dest) || dest.includes(loc)) return 90;
  return 50;
}

/**
 * Scores one load/truck pair for the match-EMAIL system (no driver
 * required). Returns { score, breakdown, eligible }. `eligible` is false
 * only for hard blockers (wrong type / under capacity / truck not
 * available) — those never get an email regardless of score.
 */
function computeLoadTruckMatchScore(load, truck) {
  const breakdown = {
    truckType: scoreEmailTruckType(load, truck),
    capacity: scoreEmailCapacity(load, truck),
    location: scoreEmailLocation(load, truck),
    availability: scoreEmailAvailability(load, truck),
    routeCompatibility: scoreEmailRoute(load, truck),
  };
  const hardBlocked = breakdown.truckType === 0 || breakdown.capacity === 0 || breakdown.availability === 0;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(MATCH_EMAIL_WEIGHTS)) {
    weightedSum += breakdown[key] * MATCH_EMAIL_WEIGHTS[key];
    weightTotal += MATCH_EMAIL_WEIGHTS[key];
  }
  const score = Math.round(clamp(weightTotal ? weightedSum / weightTotal : 0, 0, 100));
  return { score, breakdown, eligible: !hardBlocked };
}

module.exports = {
  MATCH_WEIGHTS,
  MATCH_EMAIL_WEIGHTS,
  checkTruckEligibility,
  checkDriverEligibility,
  scoreCandidate,
  buildReasons,
  rankCandidates,
  computeLoadTruckMatchScore,
};
