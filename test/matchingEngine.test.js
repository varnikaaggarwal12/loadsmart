'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MATCH_WEIGHTS,
  checkTruckEligibility,
  checkDriverEligibility,
  scoreCandidate,
  rankCandidates,
} = require('../lib/matchingEngine');

function baseLoad(overrides) {
  return Object.assign(
    {
      tokenNo: 'LS0000000001',
      pickup: 'Delhi',
      destination: 'Mumbai',
      weight: 8,
      material: 'Electronics',
      requiredTruckType: 'Closed body',
    },
    overrides
  );
}

function baseTruck(overrides) {
  return Object.assign(
    {
      id: 'TR102',
      vehicleNumber: 'DL01AB1234',
      truckType: 'Closed body',
      bodyType: 'Closed',
      capacityTons: 10,
      currentLocation: 'Delhi',
      verified: true,
      status: 'available',
    },
    overrides
  );
}

function baseDriver(overrides) {
  return Object.assign(
    {
      id: 'D102',
      name: 'Raj Kumar',
      verified: true,
      status: 'available',
      blocked: false,
      assignedTruckId: 'TR102',
      trustScore: 92,
      trustBreakdown: { onTimeRate: 96 },
      completedTrips: 127,
    },
    overrides
  );
}

// ---------- Truck eligibility ----------

test('truck eligibility: correct capacity and type passes', () => {
  const result = checkTruckEligibility(baseLoad(), baseTruck());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

test('truck eligibility: insufficient capacity is ineligible with a reason, not a low score', () => {
  const result = checkTruckEligibility(baseLoad({ weight: 8 }), baseTruck({ capacityTons: 5 }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => /capacity/i.test(r)));
});

test('truck eligibility: wrong truck type is ineligible', () => {
  const result = checkTruckEligibility(baseLoad({ requiredTruckType: 'Closed body' }), baseTruck({ truckType: 'Open body' }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => /type/i.test(r)));
});

test('truck eligibility: unavailable truck (already assigned) is ineligible', () => {
  const result = checkTruckEligibility(baseLoad(), baseTruck({ status: 'assigned' }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => /assigned/i.test(r)));
});

test('truck eligibility: truck under maintenance is ineligible', () => {
  const result = checkTruckEligibility(baseLoad(), baseTruck({ status: 'maintenance' }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => /maintenance/i.test(r)));
});

test('truck eligibility: unverified truck is ineligible', () => {
  const result = checkTruckEligibility(baseLoad(), baseTruck({ verified: false }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => /not verified/i.test(r)));
});

test('truck eligibility: empty requiredTruckType means any type is OK', () => {
  const result = checkTruckEligibility(baseLoad({ requiredTruckType: '' }), baseTruck({ truckType: 'Open body' }));
  assert.equal(result.eligible, true);
});

// ---------- Driver eligibility ----------

test('driver eligibility: available verified driver passes', () => {
  const result = checkDriverEligibility(baseLoad(), baseDriver(), baseTruck());
  assert.equal(result.eligible, true);
});

test('driver eligibility: busy driver is ineligible', () => {
  const result = checkDriverEligibility(baseLoad(), baseDriver({ status: 'on_trip' }), baseTruck());
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => /on trip/i.test(r)));
});

test('driver eligibility: inactive/off-duty driver is ineligible', () => {
  const result = checkDriverEligibility(baseLoad(), baseDriver({ status: 'off_duty' }), baseTruck());
  assert.equal(result.eligible, false);
});

test('driver eligibility: blocked driver is ineligible regardless of status', () => {
  const result = checkDriverEligibility(baseLoad(), baseDriver({ blocked: true }), baseTruck());
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => /blocked/i.test(r)));
});

test('driver eligibility: expired license is ineligible', () => {
  const result = checkDriverEligibility(baseLoad(), baseDriver({ licenseExpiry: '2000-01-01' }), baseTruck());
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => /license/i.test(r)));
});

test('driver eligibility: missing driver is ineligible', () => {
  const result = checkDriverEligibility(baseLoad(), null, baseTruck());
  assert.equal(result.eligible, false);
});

test('driver eligibility: driver linked to a different truck is ineligible for this one', () => {
  const result = checkDriverEligibility(baseLoad(), baseDriver({ assignedTruckId: 'TR999' }), baseTruck({ id: 'TR102' }));
  assert.equal(result.eligible, false);
});

// ---------- Scoring ----------

test('MATCH_WEIGHTS sums to 100', () => {
  const total = Object.values(MATCH_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test('scoreCandidate: a strong match scores highly and returns a full breakdown', () => {
  const { score, breakdown } = scoreCandidate(baseLoad(), baseTruck(), baseDriver());
  assert.ok(score >= 85, `expected a high score, got ${score}`);
  for (const key of Object.keys(MATCH_WEIGHTS)) {
    assert.ok(key in breakdown, `breakdown missing ${key}`);
    assert.ok(breakdown[key] >= 0 && breakdown[key] <= 100);
  }
});

test('scoreCandidate: an oversized truck scores lower than a well-fitted one', () => {
  const tight = scoreCandidate(baseLoad({ weight: 8 }), baseTruck({ capacityTons: 9 }), baseDriver());
  const oversized = scoreCandidate(baseLoad({ weight: 8 }), baseTruck({ capacityTons: 32 }), baseDriver());
  assert.ok(tight.score > oversized.score);
});

test('scoreCandidate: higher driver trust score raises the match score, all else equal', () => {
  const highTrust = scoreCandidate(baseLoad(), baseTruck(), baseDriver({ trustScore: 95 }));
  const lowTrust = scoreCandidate(baseLoad(), baseTruck(), baseDriver({ trustScore: 40 }));
  assert.ok(highTrust.score > lowTrust.score);
});

// ---------- Ranking (multiple candidates) ----------

test('rankCandidates: ranks multiple eligible candidates by score, descending', () => {
  const load = baseLoad();
  const pairs = [
    { truck: baseTruck({ id: 'TR311', currentLocation: 'Chennai' }), driver: baseDriver({ id: 'D311', assignedTruckId: 'TR311', trustScore: 60, completedTrips: 10 }) },
    { truck: baseTruck({ id: 'TR102' }), driver: baseDriver({ id: 'D102', assignedTruckId: 'TR102', trustScore: 92, completedTrips: 127 }) },
    { truck: baseTruck({ id: 'TR205', currentLocation: 'Delhi NCR' }), driver: baseDriver({ id: 'D205', assignedTruckId: 'TR205', trustScore: 80, completedTrips: 40 }) },
  ];
  const { eligible, ineligible } = rankCandidates(load, pairs);
  assert.equal(ineligible.length, 0);
  assert.equal(eligible.length, 3);
  assert.equal(eligible[0].truckId, 'TR102');
  assert.ok(eligible[0].matchScore >= eligible[1].matchScore);
  assert.ok(eligible[1].matchScore >= eligible[2].matchScore);
  // every eligible candidate carries an explanation
  eligible.forEach((c) => assert.ok(Array.isArray(c.reasons) && c.reasons.length > 0));
});

test('rankCandidates: ineligible candidates are separated out, never scored into the ranking', () => {
  const load = baseLoad({ weight: 8 });
  const pairs = [
    { truck: baseTruck({ id: 'TR-small', capacityTons: 5 }), driver: baseDriver({ id: 'D-a', assignedTruckId: 'TR-small' }) },
    { truck: baseTruck({ id: 'TR-ok' }), driver: baseDriver({ id: 'D-b', assignedTruckId: 'TR-ok' }) },
  ];
  const { eligible, ineligible } = rankCandidates(load, pairs);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].truckId, 'TR-ok');
  assert.equal(ineligible.length, 1);
  assert.equal(ineligible[0].truckId, 'TR-small');
  assert.equal(ineligible[0].status, 'INELIGIBLE');
});

test('rankCandidates: no eligible candidates returns an empty eligible list, not a fabricated match', () => {
  const load = baseLoad({ weight: 100 });
  const pairs = [{ truck: baseTruck({ capacityTons: 10 }), driver: baseDriver() }];
  const { eligible, ineligible } = rankCandidates(load, pairs);
  assert.equal(eligible.length, 0);
  assert.equal(ineligible.length, 1);
});
