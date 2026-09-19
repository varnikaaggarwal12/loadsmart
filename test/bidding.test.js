/**
 * test/bidding.test.js
 *
 * Pure, DB-free unit tests for the Carrier Bidding system's two hardest
 * pieces of logic (lib/biddingEngine.js — margin pricing and bid ranking),
 * plus a few structural checks on the loadStatusMachine/opsModels
 * additions the bidding system relies on. Mirrors test/tripLifecycle.test.js's
 * style and scope.
 *
 * Run: node --test test/bidding.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const biddingEngine = require('../lib/biddingEngine');
const statusMachine = require('../lib/loadStatusMachine');
const opsModels = require('../lib/opsModels');

// ---------- calculateLoadSmartPricing ----------

test('calculateLoadSmartPricing: PERCENTAGE margin adds the right amount', () => {
  const result = biddingEngine.calculateLoadSmartPricing({
    carrierBidAmount: 10000,
    marginConfig: { marginType: 'PERCENTAGE', marginValue: 10 },
  });
  assert.equal(result.marginAmount, 1000);
  assert.equal(result.finalShipperPrice, 11000);
  assert.equal(result.carrierBidAmount, 10000);
});

test('calculateLoadSmartPricing: FIXED margin adds a flat amount regardless of bid size', () => {
  const small = biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: 1000, marginConfig: { marginType: 'FIXED', marginValue: 500 } });
  const large = biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: 100000, marginConfig: { marginType: 'FIXED', marginValue: 500 } });
  assert.equal(small.marginAmount, 500);
  assert.equal(large.marginAmount, 500);
  assert.equal(small.finalShipperPrice, 1500);
  assert.equal(large.finalShipperPrice, 100500);
});

test('calculateLoadSmartPricing: minMargin floors the computed margin amount', () => {
  const result = biddingEngine.calculateLoadSmartPricing({
    carrierBidAmount: 1000, // 5% of 1000 = 50, below the 200 floor
    marginConfig: { marginType: 'PERCENTAGE', marginValue: 5, minMargin: 200 },
  });
  assert.equal(result.marginAmount, 200);
  assert.equal(result.finalShipperPrice, 1200);
});

test('calculateLoadSmartPricing: maxMargin caps the computed margin amount', () => {
  const result = biddingEngine.calculateLoadSmartPricing({
    carrierBidAmount: 100000, // 20% of 100000 = 20000, above the 5000 cap
    marginConfig: { marginType: 'PERCENTAGE', marginValue: 20, maxMargin: 5000 },
  });
  assert.equal(result.marginAmount, 5000);
  assert.equal(result.finalShipperPrice, 105000);
});

test('calculateLoadSmartPricing: rejects a non-positive bid amount', () => {
  assert.throws(() => biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: 0, marginConfig: { marginType: 'PERCENTAGE', marginValue: 10 } }), /positive number/);
  assert.throws(() => biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: -50, marginConfig: { marginType: 'PERCENTAGE', marginValue: 10 } }), /positive number/);
  assert.throws(() => biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: 'not-a-number', marginConfig: { marginType: 'PERCENTAGE', marginValue: 10 } }), /positive number/);
});

test('calculateLoadSmartPricing: defaults to PERCENTAGE with a safe 0 value when marginConfig is malformed', () => {
  const result = biddingEngine.calculateLoadSmartPricing({ carrierBidAmount: 5000, marginConfig: { marginType: 'NOT_A_TYPE', marginValue: 'NaN' } });
  assert.equal(result.marginType, 'PERCENTAGE');
  assert.equal(result.marginAmount, 0);
  assert.equal(result.finalShipperPrice, 5000);
});

// ---------- priceScoreWithinSet ----------

test('priceScoreWithinSet: cheapest gets 100, priciest gets 0, linear between', () => {
  const prices = [1000, 1500, 2000];
  assert.equal(biddingEngine.priceScoreWithinSet(1000, prices), 100);
  assert.equal(biddingEngine.priceScoreWithinSet(2000, prices), 0);
  assert.equal(biddingEngine.priceScoreWithinSet(1500, prices), 50);
});

test('priceScoreWithinSet: a single bid (or all-equal bids) scores 100 — no false "expensive" penalty', () => {
  assert.equal(biddingEngine.priceScoreWithinSet(5000, [5000]), 100);
  assert.equal(biddingEngine.priceScoreWithinSet(5000, [5000, 5000, 5000]), 100);
});

// ---------- rankBidsForShipper ----------

function makeLoad(overrides) {
  return { pickup: 'Chandigarh', destination: 'Delhi', weight: 5, requiredTruckType: '', requiredBodyType: '', ...overrides };
}
function makeTruck(overrides) {
  return { id: 'T1', truckType: 'Open Truck', bodyType: 'Open', capacityTons: 10, verified: true, status: 'available', currentLocation: 'Chandigarh', ...overrides };
}
function makeDriver(overrides) {
  return { id: 'D1', status: 'available', verified: true, blocked: false, trustScore: 80, completedTrips: 10, onTimeRate: 90, ...overrides };
}

test('rankBidsForShipper: cheaper + better-matched bid ranks first', () => {
  const load = makeLoad();
  const cheapGoodBid = { id: 'BID-1', carrierCompanyName: 'Cheap Co', createdAt: new Date(), notes: '' };
  const pricyBid = { id: 'BID-2', carrierCompanyName: 'Pricy Co', createdAt: new Date(), notes: '' };
  const context = [
    { bid: cheapGoodBid, truck: makeTruck({ id: 'T1' }), driver: makeDriver({ id: 'D1', trustScore: 90 }), finalShipperPrice: 10000 },
    { bid: pricyBid, truck: makeTruck({ id: 'T2' }), driver: makeDriver({ id: 'D2', trustScore: 40 }), finalShipperPrice: 20000 },
  ];
  const ranked = biddingEngine.rankBidsForShipper(load, context);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].bidId, 'BID-1');
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].rank, 2);
  assert.ok(ranked[0].compositeScore >= ranked[1].compositeScore);
});

test('rankBidsForShipper: every returned offer includes AI match + trust + price fields', () => {
  const load = makeLoad();
  const context = [{ bid: { id: 'BID-1', carrierCompanyName: 'X', createdAt: new Date(), notes: '' }, truck: makeTruck(), driver: makeDriver(), finalShipperPrice: 5000 }];
  const [offer] = biddingEngine.rankBidsForShipper(load, context);
  assert.equal(typeof offer.aiMatchScore, 'number');
  assert.equal(typeof offer.trustScore, 'number');
  assert.equal(typeof offer.priceScore, 'number');
  assert.equal(typeof offer.compositeScore, 'number');
  assert.equal(offer.finalShipperPrice, 5000);
});

test('rankBidsForShipper: NEVER leaks carrierBidAmount or margin fields into a ranked offer (spec section 16)', () => {
  const load = makeLoad();
  const context = [{ bid: { id: 'BID-1', carrierCompanyName: 'X', createdAt: new Date(), notes: '' }, truck: makeTruck(), driver: makeDriver(), finalShipperPrice: 5000 }];
  const [offer] = biddingEngine.rankBidsForShipper(load, context);
  const forbiddenKeys = ['carrierBidAmount', 'bidAmount', 'marginAmount', 'marginType', 'marginValue'];
  forbiddenKeys.forEach((key) => {
    assert.equal(Object.prototype.hasOwnProperty.call(offer, key), false, `ranked offer must never expose "${key}" to the shipper`);
  });
});

test('rankBidsForShipper: a driver missing a cached trustScore falls back to the neutral 70 baseline, not a crash', () => {
  const load = makeLoad();
  const context = [{ bid: { id: 'BID-1', carrierCompanyName: 'X', createdAt: new Date(), notes: '' }, truck: makeTruck(), driver: null, finalShipperPrice: 5000 }];
  const [offer] = biddingEngine.rankBidsForShipper(load, context);
  assert.equal(offer.trustScore, 70);
});

// ---------- loadStatusMachine / opsModels additions ----------

test('BIDDING_OPEN sits between MATCHED and ASSIGNED in LOAD_STAGE_KEYS', () => {
  const keys = statusMachine.LOAD_STAGE_KEYS;
  const matchedIdx = keys.indexOf('MATCHED');
  const biddingIdx = keys.indexOf('BIDDING_OPEN');
  const assignedIdx = keys.indexOf('ASSIGNED');
  assert.ok(biddingIdx > matchedIdx && biddingIdx < assignedIdx, 'BIDDING_OPEN must sit between MATCHED and ASSIGNED');
});

test('BIDDING_OPEN has a STAGE_LABEL and a TRACKING_STATUS_MAP entry', () => {
  assert.equal(typeof statusMachine.STAGE_LABELS.BIDDING_OPEN, 'string');
  assert.ok(statusMachine.STAGE_LABELS.BIDDING_OPEN.length > 0);
  const LEGACY_STATUSES = ['Booked', 'Confirmed', 'Picked Up', 'In Transit', 'Out for Delivery', 'Delayed', 'Delivered'];
  assert.ok(LEGACY_STATUSES.includes(statusMachine.TRACKING_STATUS_MAP.BIDDING_OPEN));
});

test('opsModels.TRACKING_EVENT_TYPES includes every new bidding event type', () => {
  ['BIDDING_OPEN', 'BID_SUBMITTED', 'BID_WITHDRAWN', 'CARRIER_SELECTED', 'BIDDING_CLOSED'].forEach((type) => {
    assert.ok(opsModels.TRACKING_EVENT_TYPES.includes(type), `missing new event type ${type}`);
  });
});
