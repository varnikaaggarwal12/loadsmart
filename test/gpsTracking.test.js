'use strict';

// Pure-logic tests for the GPS tracking system, following the same DB-free
// convention as test/matchingEngine.test.js (this sandbox has no reachable
// MongoDB). Authorization/ownership behavior (a driver can only submit for
// their own assigned load, Socket.IO room scoping, etc.) is exercised via
// the manual testing checklist in the final delivery docs, since it needs
// a live server + DB to run end to end.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateGpsPoint, haversineMeters, shouldAcceptPing, classifyStaleness } = require('../lib/gpsValidation');

// ---------- validateGpsPoint ----------

test('a normal, complete GPS reading validates and passes every field through cleanly', () => {
  const result = validateGpsPoint({ lat: 28.6139, lng: 77.2090, accuracy: 12, speedKph: 45, headingDeg: 180, altitude: 210 });
  assert.equal(result.valid, true);
  assert.equal(result.point.lat, 28.6139);
  assert.equal(result.point.lng, 77.2090);
  assert.equal(result.point.speedKph, 45);
  assert.equal(result.point.headingDeg, 180);
});

test('a minimal reading (lat/lng only) still validates — accuracy/speed/heading/altitude are all optional', () => {
  const result = validateGpsPoint({ lat: 19.076, lng: 72.8777 });
  assert.equal(result.valid, true);
  assert.equal(result.point.accuracy, null);
  assert.equal(result.point.speedKph, null);
});

test('non-numeric or missing lat/lng is rejected, never silently coerced', () => {
  assert.equal(validateGpsPoint({ lat: 'not-a-number', lng: 77 }).valid, false);
  assert.equal(validateGpsPoint({ lat: 28, lng: undefined }).valid, false);
  assert.equal(validateGpsPoint({}).valid, false);
});

test('lat/lng outside the valid world range is rejected', () => {
  assert.equal(validateGpsPoint({ lat: 95, lng: 77 }).valid, false, 'lat > 90');
  assert.equal(validateGpsPoint({ lat: -95, lng: 77 }).valid, false, 'lat < -90');
  assert.equal(validateGpsPoint({ lat: 28, lng: 185 }).valid, false, 'lng > 180');
  assert.equal(validateGpsPoint({ lat: 28, lng: -185 }).valid, false, 'lng < -180');
});

test('(0,0) "Null Island" is rejected as a placeholder/uninitialized reading', () => {
  assert.equal(validateGpsPoint({ lat: 0, lng: 0 }).valid, false);
});

test('accuracy worse than the configured maximum is rejected outright', () => {
  const result = validateGpsPoint({ lat: 28, lng: 77, accuracy: 5000 }, { maxAcceptableAccuracyMeters: 2000 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /accuracy/i);
});

test('a negative or implausibly high speed is rejected', () => {
  assert.equal(validateGpsPoint({ lat: 28, lng: 77, speedKph: -5 }).valid, false);
  assert.equal(validateGpsPoint({ lat: 28, lng: 77, speedKph: 500 }).valid, false);
});

test('heading must be within [0, 360)', () => {
  assert.equal(validateGpsPoint({ lat: 28, lng: 77, headingDeg: -1 }).valid, false);
  assert.equal(validateGpsPoint({ lat: 28, lng: 77, headingDeg: 360 }).valid, false);
  assert.equal(validateGpsPoint({ lat: 28, lng: 77, headingDeg: 359.9 }).valid, true);
});

test('a device timestamp wildly different from server time is rejected (bad device clock protection)', () => {
  const wayOff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
  const result = validateGpsPoint({ lat: 28, lng: 77, deviceTimestamp: wayOff }, { maxClockSkewMs: 10 * 60 * 1000 });
  assert.equal(result.valid, false);
});

test('a device timestamp within the allowed skew window is accepted', () => {
  const closeEnough = new Date(Date.now() - 5000).toISOString(); // 5s ago
  const result = validateGpsPoint({ lat: 28, lng: 77, deviceTimestamp: closeEnough });
  assert.equal(result.valid, true);
  assert.ok(result.point.deviceTimestamp instanceof Date);
});

// ---------- haversineMeters ----------

test('haversineMeters returns ~0 for the same point', () => {
  const p = { lat: 28.6139, lng: 77.2090 };
  assert.ok(haversineMeters(p, p) < 1);
});

test('haversineMeters computes a realistic distance for two known cities (Delhi <-> Mumbai, ~1150-1160km great-circle)', () => {
  const delhi = { lat: 28.6139, lng: 77.2090 };
  const mumbai = { lat: 19.0760, lng: 72.8777 };
  const km = haversineMeters(delhi, mumbai) / 1000;
  assert.ok(km > 1100 && km < 1200, `expected ~1150km, got ${km}`);
});

// ---------- shouldAcceptPing (server-side throttle) ----------

test('the very first ping for a load is always accepted', () => {
  const decision = shouldAcceptPing({ prevPoint: null, prevAt: null, nextPoint: { lat: 28, lng: 77 }, nextAt: Date.now() });
  assert.equal(decision.accept, true);
});

test('a ping that arrives after enough time has passed is accepted even with no movement', () => {
  const decision = shouldAcceptPing(
    { prevPoint: { lat: 28, lng: 77 }, prevAt: 1000, nextPoint: { lat: 28, lng: 77 }, nextAt: 1000 + 5000 },
    { minIntervalMs: 2000 }
  );
  assert.equal(decision.accept, true);
});

test('a ping that arrives too soon AND with negligible movement is rejected (throttled, not stored)', () => {
  const decision = shouldAcceptPing(
    { prevPoint: { lat: 28.0000, lng: 77.0000 }, prevAt: 1000, nextPoint: { lat: 28.00001, lng: 77.00001 }, nextAt: 1000 + 500 },
    { minIntervalMs: 2000, minMovementMeters: 15 }
  );
  assert.equal(decision.accept, false);
});

test('a ping that arrives quickly but with REAL movement is still accepted (a fast-moving truck should not be throttled away)', () => {
  const decision = shouldAcceptPing(
    { prevPoint: { lat: 28.0000, lng: 77.0000 }, prevAt: 1000, nextPoint: { lat: 28.01, lng: 77.01 }, nextAt: 1000 + 500 },
    { minIntervalMs: 2000, minMovementMeters: 15 }
  );
  assert.equal(decision.accept, true);
});

test('an out-of-order (earlier) timestamp is rejected', () => {
  const decision = shouldAcceptPing({ prevPoint: { lat: 28, lng: 77 }, prevAt: 5000, nextPoint: { lat: 28, lng: 77 }, nextAt: 1000 });
  assert.equal(decision.accept, false);
});

// ---------- classifyStaleness ----------

test('no last-updated timestamp at all classifies as no_data', () => {
  assert.equal(classifyStaleness(null).status, 'no_data');
});

test('a very recent update classifies as live', () => {
  const result = classifyStaleness(new Date(Date.now() - 1000), Date.now(), { staleAfterMs: 120000 });
  assert.equal(result.status, 'live');
});

test('an update older than the configured stale threshold classifies as stale ("last known location")', () => {
  const result = classifyStaleness(new Date(Date.now() - 5 * 60 * 1000), Date.now(), { staleAfterMs: 120000 });
  assert.equal(result.status, 'stale');
  assert.ok(result.staleMs >= 5 * 60 * 1000 - 1000);
});
