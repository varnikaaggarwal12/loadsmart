/**
 * test/brokerAutomation.test.js
 *
 * Unit tests for lib/brokerAutomation.js — the pure, DB-free rules behind
 * the Broker→Carrier→Shipper automation workflow: carrier-scoped truck
 * matching, load/carrier recommendation, and connection-request
 * authorization checks. Reuses lib/matchingEngine.js under the hood, so
 * these tests focus on the carrier-scoping/aggregation/validation layer
 * this file adds on top, not on re-testing matchingEngine itself (see
 * test/matchingEngine.test.js for that).
 *
 * Run: node --test test/brokerAutomation.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const brokerAutomation = require('../lib/brokerAutomation');

function baseLoad(overrides = {}) {
  return {
    tokenNo: 'LS-1001',
    pickup: 'Chandigarh',
    destination: 'Delhi',
    weight: 5,
    requiredTruckType: '32 FT',
    requiredBodyType: '',
    loadStage: 'BIDDING_OPEN',
    biddingDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
    shipperUsername: 'shipper1',
    ...overrides,
  };
}
function baseTruck(overrides = {}) {
  return {
    id: 'TRK-1', carrierUsername: 'carrierA', vehicleNumber: 'PB-01-AB-1234',
    truckType: '32 FT', bodyType: '', capacityTons: 10, verified: true,
    status: 'available', currentLocation: 'Chandigarh', assignedDriverId: '',
    ...overrides,
  };
}
function baseDriver(overrides = {}) {
  return {
    id: 'DRV-1', name: 'Ramesh', verified: true, status: 'available',
    blocked: false, licenseExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    trustScore: 82, completedTrips: 40, assignedTruckId: 'TRK-1',
    ...overrides,
  };
}
function baseCarrier(overrides = {}) {
  return { id: 'CAR-1', username: 'carrierA', companyName: 'Acme Carriers', active: true, status: 'accepted', ...overrides };
}

// ---------- findSuitableTrucksForCarrier ----------
test('findSuitableTrucksForCarrier: only considers the given carrier\'s own trucks', () => {
  const load = baseLoad();
  const trucks = [baseTruck({ id: 'TRK-1', carrierUsername: 'carrierA' }), baseTruck({ id: 'TRK-2', carrierUsername: 'carrierB' })];
  const { eligible } = brokerAutomation.findSuitableTrucksForCarrier(load, 'carrierA', trucks, new Map());
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].truckId, 'TRK-1');
});

test('findSuitableTrucksForCarrier: ineligible truck (wrong type) is reported with a reason, not silently dropped', () => {
  const load = baseLoad({ requiredTruckType: '19 FT' });
  const trucks = [baseTruck()];
  const { eligible, ineligible } = brokerAutomation.findSuitableTrucksForCarrier(load, 'carrierA', trucks, new Map());
  assert.equal(eligible.length, 0);
  assert.equal(ineligible.length, 1);
  assert.match(ineligible[0].reasons.join(';'), /does not match/i);
});

test('findSuitableTrucksForCarrier: scores a truck with no linked driver using a neutral baseline, never inventing a driver', () => {
  const load = baseLoad();
  const trucks = [baseTruck({ assignedDriverId: '' })];
  const { eligible } = brokerAutomation.findSuitableTrucksForCarrier(load, 'carrierA', trucks, new Map());
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].driverId, '');
  assert.equal(eligible[0].driverName, '');
  assert.ok(eligible[0].matchScore > 0);
  assert.match(eligible[0].reasons.join(' '), /no driver linked/i);
});

test('findSuitableTrucksForCarrier: ranks best match first when multiple trucks qualify', () => {
  const load = baseLoad({ weight: 5 });
  const trucks = [
    baseTruck({ id: 'TRK-BIG', capacityTons: 30 }),   // oversized -> lower capacity-fit score
    baseTruck({ id: 'TRK-TIGHT', capacityTons: 6 }),  // tight fit -> higher score
  ];
  const driverById = new Map([['DRV-1', baseDriver()]]);
  trucks.forEach((t) => { t.assignedDriverId = 'DRV-1'; });
  const { eligible } = brokerAutomation.findSuitableTrucksForCarrier(load, 'carrierA', trucks, driverById);
  assert.equal(eligible[0].truckId, 'TRK-TIGHT');
});

// ---------- recommendBestCarrierForLoad ----------
test('recommendBestCarrierForLoad: returns null with missingInfo when nothing is eligible', () => {
  const load = baseLoad({ requiredTruckType: '40 FT Flatbed' });
  const candidates = [{ truck: baseTruck(), driver: baseDriver(), carrierUsername: 'carrierA', carrierCompanyName: 'Acme' }];
  const { best } = brokerAutomation.recommendBestCarrierForLoad(load, candidates);
  assert.equal(best, null);
});

test('recommendBestCarrierForLoad: picks the highest-scoring eligible carrier/truck', () => {
  const load = baseLoad();
  const candidates = [
    { truck: baseTruck({ id: 'TRK-1', capacityTons: 30 }), driver: baseDriver({ id: 'D1', trustScore: 50 }), carrierUsername: 'carrierA', carrierCompanyName: 'Acme' },
    { truck: baseTruck({ id: 'TRK-2', capacityTons: 6, carrierUsername: 'carrierB' }), driver: baseDriver({ id: 'D2', trustScore: 95 }), carrierUsername: 'carrierB', carrierCompanyName: 'BestFleet' },
  ];
  const { best } = brokerAutomation.recommendBestCarrierForLoad(load, candidates);
  assert.equal(best.carrierUsername, 'carrierB');
  assert.ok(best.matchScore > 0);
  assert.ok(Array.isArray(best.reasons) && best.reasons.length > 0);
});

// ---------- recommendLoadsForCarrier ----------
test('recommendLoadsForCarrier: only returns loads this carrier has an eligible truck for', () => {
  const trucks = [baseTruck({ id: 'TRK-1', carrierUsername: 'carrierA', truckType: '32 FT' })];
  const loads = [baseLoad({ tokenNo: 'A', requiredTruckType: '32 FT' }), baseLoad({ tokenNo: 'B', requiredTruckType: '19 FT' })];
  const results = brokerAutomation.recommendLoadsForCarrier('carrierA', trucks, new Map(), loads);
  assert.equal(results.length, 1);
  assert.equal(results[0].tokenNo, 'A');
});

test('recommendLoadsForCarrier: flags reduceEmptyTravel only when a real truck location matches the pickup', () => {
  const trucks = [baseTruck({ id: 'TRK-1', carrierUsername: 'carrierA', currentLocation: 'Chandigarh' })];
  const loads = [baseLoad({ tokenNo: 'A', pickup: 'Chandigarh' })];
  const results = brokerAutomation.recommendLoadsForCarrier('carrierA', trucks, new Map(), loads);
  assert.equal(results[0].reduceEmptyTravel, true);
});

test('recommendLoadsForCarrier: never flags reduceEmptyTravel when location data is absent', () => {
  const trucks = [baseTruck({ id: 'TRK-1', carrierUsername: 'carrierA', currentLocation: '' })];
  const loads = [baseLoad({ tokenNo: 'A', pickup: 'Chandigarh' })];
  const results = brokerAutomation.recommendLoadsForCarrier('carrierA', trucks, new Map(), loads);
  assert.equal(results[0].reduceEmptyTravel, false);
});

// ---------- canBrokerConnect ----------
test('canBrokerConnect: happy path passes', () => {
  const result = brokerAutomation.canBrokerConnect({
    carrier: baseCarrier(), load: baseLoad(), truck: baseTruck(), existingActiveConnection: null,
  });
  assert.equal(result.ok, true);
});

test('canBrokerConnect: rejects an unverified carrier', () => {
  const result = brokerAutomation.canBrokerConnect({
    carrier: baseCarrier({ status: 'pending' }), load: baseLoad(), truck: baseTruck(), existingActiveConnection: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'carrier_not_verified');
});

test('canBrokerConnect: rejects a load that is no longer BIDDING_OPEN', () => {
  const result = brokerAutomation.canBrokerConnect({
    carrier: baseCarrier(), load: baseLoad({ loadStage: 'ASSIGNED' }), truck: baseTruck(), existingActiveConnection: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'load_not_available');
});

test('canBrokerConnect: rejects an expired bidding window', () => {
  const result = brokerAutomation.canBrokerConnect({
    carrier: baseCarrier(), load: baseLoad({ biddingDeadline: new Date(Date.now() - 1000) }), truck: baseTruck(), existingActiveConnection: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'load_expired');
});

test('canBrokerConnect: rejects a truck that does not belong to the selected carrier', () => {
  const result = brokerAutomation.canBrokerConnect({
    carrier: baseCarrier({ username: 'carrierA' }), load: baseLoad(), truck: baseTruck({ carrierUsername: 'carrierB' }), existingActiveConnection: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'truck_not_owned');
});

test('canBrokerConnect: rejects a truck that fails hard eligibility (wrong type)', () => {
  const result = brokerAutomation.canBrokerConnect({
    carrier: baseCarrier(), load: baseLoad({ requiredTruckType: '19 FT' }), truck: baseTruck({ truckType: '32 FT' }), existingActiveConnection: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'truck_not_eligible');
});

test('canBrokerConnect: rejects a load with no associated shipper', () => {
  const result = brokerAutomation.canBrokerConnect({
    carrier: baseCarrier(), load: baseLoad({ shipperUsername: '' }), truck: baseTruck(), existingActiveConnection: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_shipper');
});

test('canBrokerConnect: rejects a duplicate active connection', () => {
  const result = brokerAutomation.canBrokerConnect({
    carrier: baseCarrier(), load: baseLoad(), truck: baseTruck(), existingActiveConnection: { id: 'CONN-1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'duplicate_connection');
});

// ---------- resolveConnectionDisplayStatus / isConnectionExpired ----------
test('resolveConnectionDisplayStatus: reflects an accepted bid as approved', () => {
  const status = brokerAutomation.resolveConnectionDisplayStatus({ status: 'negotiating' }, { bid: { status: 'ACCEPTED' } });
  assert.equal(status, 'approved');
});

test('resolveConnectionDisplayStatus: reflects a rejected bid as rejected', () => {
  const status = brokerAutomation.resolveConnectionDisplayStatus({ status: 'negotiating' }, { bid: { status: 'REJECTED' } });
  assert.equal(status, 'rejected');
});

test('resolveConnectionDisplayStatus: a withdrawn bid reads as cancelled', () => {
  const status = brokerAutomation.resolveConnectionDisplayStatus({ status: 'negotiating' }, { bid: { status: 'WITHDRAWN' } });
  assert.equal(status, 'cancelled');
});

test('resolveConnectionDisplayStatus: never overrides an already-terminal stored status', () => {
  const status = brokerAutomation.resolveConnectionDisplayStatus({ status: 'cancelled' }, { bid: { status: 'SUBMITTED' } });
  assert.equal(status, 'cancelled');
});

test('resolveConnectionDisplayStatus: falls back to expired once the load\'s bidding window has passed with no bid', () => {
  const conn = { status: 'shipper_notified' };
  const load = { biddingDeadline: new Date(Date.now() - 1000) };
  assert.equal(brokerAutomation.isConnectionExpired(conn, load), true);
  assert.equal(brokerAutomation.resolveConnectionDisplayStatus(conn, { load }), 'expired');
});

test('resolveConnectionDisplayStatus: stays pending when nothing has happened yet and deadline has not passed', () => {
  const conn = { status: 'pending' };
  const load = { biddingDeadline: new Date(Date.now() + 60000) };
  assert.equal(brokerAutomation.resolveConnectionDisplayStatus(conn, { load }), 'pending');
});

// ---------- computeBrokerLoadMatchScore (Load Matching Panel B — the exact user-specified weights) ----------
test('BROKER_LOAD_MATCH_WEIGHTS matches the exact spec percentages and sums to 100', () => {
  const w = brokerAutomation.BROKER_LOAD_MATCH_WEIGHTS;
  assert.deepEqual(w, { origin: 25, destination: 25, truckType: 15, capacity: 15, availability: 10, verification: 5, trust: 5 });
  assert.equal(Object.values(w).reduce((a, b) => a + b, 0), 100);
});

test('computeBrokerLoadMatchScore: a strong match on every factor scores very high with a positive explanation', () => {
  // Truck is currently AT the pickup point — the realistic "great match"
  // case, since the schema only tracks one currentLocation field (a truck
  // can't simultaneously be at both the pickup and the destination, so a
  // literal 100/100/100/100/100/100/100 breakdown is not a real scenario
  // this engine can ever produce — see the destination heuristic below).
  const load = baseLoad({ pickup: 'Chandigarh', destination: 'Delhi', requiredTruckType: '32 FT', weight: 5 });
  const truck = baseTruck({ currentLocation: 'Chandigarh', truckType: '32 FT', capacityTons: 5.5, status: 'available', verified: true });
  const driver = baseDriver({ trustScore: 95 });
  const { score, breakdown, explanation } = brokerAutomation.computeBrokerLoadMatchScore(load, truck, driver);
  assert.equal(breakdown.origin, 100);
  assert.equal(breakdown.truckType, 100);
  assert.equal(breakdown.capacity, 100);
  assert.equal(breakdown.availability, 100);
  assert.equal(breakdown.verification, 100);
  assert.ok(score >= 85, `expected a strong overall score, got ${score}`);
  assert.match(explanation, /% match/);
  assert.match(explanation, /pickup location is compatible|route is compatible/);
  assert.match(explanation, /truck type matches/);
  assert.match(explanation, /capacity is sufficient/);
  assert.match(explanation, /available on the requested date/);
});

test('computeBrokerLoadMatchScore: wrong truck type drives the score down hard even when everything else is perfect', () => {
  const load = baseLoad({ requiredTruckType: '32 FT' });
  const truck = baseTruck({ truckType: '20 FT', currentLocation: 'Chandigarh', capacityTons: 20, status: 'available', verified: true });
  const driver = baseDriver({ trustScore: 90 });
  const { score, breakdown, explanation } = brokerAutomation.computeBrokerLoadMatchScore(load, truck, driver);
  assert.equal(breakdown.truckType, 0);
  // truckType alone is 15% of the total weight, so losing it entirely caps the achievable score well under 100.
  assert.ok(score <= 90, `expected a meaningfully reduced score, got ${score}`);
  assert.match(explanation, /does NOT match/);
});

test('computeBrokerLoadMatchScore: insufficient capacity zeroes the capacity factor and is reflected in the explanation', () => {
  const load = baseLoad({ weight: 20 });
  const truck = baseTruck({ capacityTons: 5, status: 'available', verified: true });
  const { breakdown, explanation } = brokerAutomation.computeBrokerLoadMatchScore(load, truck, null);
  assert.equal(breakdown.capacity, 0);
  assert.match(explanation, /capacity is insufficient/);
});

test('computeBrokerLoadMatchScore: an unavailable truck scores 0 on availability and says so plainly', () => {
  const load = baseLoad();
  const truck = baseTruck({ status: 'assigned' });
  const { breakdown, explanation } = brokerAutomation.computeBrokerLoadMatchScore(load, truck, null);
  assert.equal(breakdown.availability, 0);
  assert.match(explanation, /not currently marked available/);
});

test('computeBrokerLoadMatchScore: falls back to the carrier-level trust score when no driver is linked, and to a neutral 70 when neither exists', () => {
  const load = baseLoad();
  const truck = baseTruck();
  const withCarrierScore = brokerAutomation.computeBrokerLoadMatchScore(load, truck, null, { trustScore: 88 });
  assert.equal(withCarrierScore.breakdown.trust, 88);
  const withNeither = brokerAutomation.computeBrokerLoadMatchScore(load, truck, null, {});
  assert.equal(withNeither.breakdown.trust, 70);
});

test('computeBrokerLoadMatchScore: never returns a score outside 0-100 regardless of inputs', () => {
  const load = baseLoad();
  const truck = baseTruck({ verified: false, status: 'available' });
  const { score } = brokerAutomation.computeBrokerLoadMatchScore(load, truck, baseDriver({ trustScore: -50 }));
  assert.ok(score >= 0 && score <= 100);
});
