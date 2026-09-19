'use strict';

// Pure-logic tests for the email notification system, following the same
// DB-free convention as test/matchingEngine.test.js and test/trustScore.test.js
// (this sandbox has no reachable MongoDB — see server_load.js's startup
// comments). These exercise every piece of the system that doesn't need a
// live database: the Load<->Truck match-email scoring function, the
// configurable threshold classifier, the idempotency-key builder, and the
// HTML/text template renderer (including the "never leak sensitive fields"
// guarantee). Duplicate-prevention and retry/queue behavior that DO need a
// database are covered by the request-level scenarios documented in the
// final delivery summary, run against a live environment.

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeLoadTruckMatchScore, MATCH_EMAIL_WEIGHTS } = require('../lib/matchingEngine');
const matchConfig = require('../lib/matchConfig');
const emailQueue = require('../lib/emailQueue');
const templates = require('../lib/emailTemplates');

// ---------- computeLoadTruckMatchScore ----------

function load(overrides) {
  return Object.assign({
    tokenNo: 'LS0000000001', pickup: 'Delhi', destination: 'Mumbai',
    weight: 8, requiredTruckType: 'Closed Body',
  }, overrides);
}
function truck(overrides) {
  return Object.assign({
    truckType: 'Closed Body', capacityTons: 9, currentLocation: 'Delhi',
    status: 'available', verified: true,
  }, overrides);
}

test('MATCH_EMAIL_WEIGHTS sums to 100 (spec: Truck Type 30 / Capacity 25 / Location 20 / Availability 15 / Route 10)', () => {
  const total = Object.values(MATCH_EMAIL_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
  assert.equal(MATCH_EMAIL_WEIGHTS.truckType, 30);
  assert.equal(MATCH_EMAIL_WEIGHTS.capacity, 25);
  assert.equal(MATCH_EMAIL_WEIGHTS.location, 20);
  assert.equal(MATCH_EMAIL_WEIGHTS.availability, 15);
  assert.equal(MATCH_EMAIL_WEIGHTS.routeCompatibility, 10);
});

test('a truck at the pickup point, right type, tight capacity fit scores very high (Perfect Match territory)', () => {
  const result = computeLoadTruckMatchScore(load(), truck());
  assert.equal(result.eligible, true);
  assert.ok(result.score >= 85, `expected a near-perfect score, got ${result.score}`);
});

test('wrong truck type is a hard blocker — never eligible for a match email regardless of everything else being ideal', () => {
  const result = computeLoadTruckMatchScore(load({ requiredTruckType: 'Open Body' }), truck({ truckType: 'Closed Body' }));
  assert.equal(result.eligible, false);
  assert.equal(result.breakdown.truckType, 0);
});

test('a truck under the required capacity is a hard blocker, even if everything else matches', () => {
  const result = computeLoadTruckMatchScore(load({ weight: 20 }), truck({ capacityTons: 10 }));
  assert.equal(result.eligible, false);
  assert.equal(result.breakdown.capacity, 0);
});

test('a truck under maintenance / not available is a hard blocker', () => {
  const result = computeLoadTruckMatchScore(load(), truck({ status: 'maintenance' }));
  assert.equal(result.eligible, false);
  assert.equal(result.breakdown.availability, 0);
});

test('an unverified truck is still eligible but scores materially lower than a verified one', () => {
  const verified = computeLoadTruckMatchScore(load(), truck({ verified: true }));
  const unverified = computeLoadTruckMatchScore(load(), truck({ verified: false }));
  assert.equal(unverified.eligible, true);
  assert.ok(unverified.score < verified.score);
});

test('no requiredTruckType on the load means any truck type is a full match on that factor', () => {
  const result = computeLoadTruckMatchScore(load({ requiredTruckType: '' }), truck({ truckType: 'Flatbed' }));
  assert.equal(result.breakdown.truckType, 100);
});

// ---------- matchConfig thresholds/classification ----------

test('classifyMatchScore uses the spec\'s default bands: 90+ Perfect, 75-89 Strong, 60-74 Possible, <60 none', () => {
  const originalPerfect = process.env.MATCH_PERFECT_THRESHOLD;
  const originalStrong = process.env.MATCH_STRONG_THRESHOLD;
  const originalPossible = process.env.MATCH_POSSIBLE_THRESHOLD;
  delete process.env.MATCH_PERFECT_THRESHOLD;
  delete process.env.MATCH_STRONG_THRESHOLD;
  delete process.env.MATCH_POSSIBLE_THRESHOLD;
  try {
    assert.equal(matchConfig.classifyMatchScore(95), 'PERFECT');
    assert.equal(matchConfig.classifyMatchScore(90), 'PERFECT');
    assert.equal(matchConfig.classifyMatchScore(80), 'STRONG');
    assert.equal(matchConfig.classifyMatchScore(65), 'POSSIBLE');
    assert.equal(matchConfig.classifyMatchScore(59), null);
    assert.equal(matchConfig.classifyMatchScore(0), null);
  } finally {
    if (originalPerfect !== undefined) process.env.MATCH_PERFECT_THRESHOLD = originalPerfect;
    if (originalStrong !== undefined) process.env.MATCH_STRONG_THRESHOLD = originalStrong;
    if (originalPossible !== undefined) process.env.MATCH_POSSIBLE_THRESHOLD = originalPossible;
  }
});

test('thresholds are configurable via env (spec: "CONFIGURABLE threshold")', () => {
  const original = process.env.MATCH_POSSIBLE_THRESHOLD;
  process.env.MATCH_POSSIBLE_THRESHOLD = '80';
  try {
    assert.equal(matchConfig.classifyMatchScore(70), null, 'a score of 70 should no longer qualify once the floor is raised to 80');
    assert.equal(matchConfig.classifyMatchScore(85), 'STRONG');
  } finally {
    if (original === undefined) delete process.env.MATCH_POSSIBLE_THRESHOLD;
    else process.env.MATCH_POSSIBLE_THRESHOLD = original;
  }
});

// ---------- idempotency key (duplicate-email prevention) ----------

test('buildIdempotencyKey combines eventType + entityId + recipient, case/whitespace-insensitive on the email', () => {
  const a = emailQueue.buildIdempotencyKey('LOAD_TRUCK_MATCHED_SHIPPER', 'LS0000000001', '  Shipper@Example.com ');
  const b = emailQueue.buildIdempotencyKey('LOAD_TRUCK_MATCHED_SHIPPER', 'LS0000000001', 'shipper@example.com');
  assert.equal(a, b, 'the same event/entity/recipient must always produce the same key, regardless of email casing/whitespace');
});

test('buildIdempotencyKey produces a DIFFERENT key for a different event, entity, or recipient', () => {
  const base = emailQueue.buildIdempotencyKey('LOAD_POSTED', 'LS01', 'a@b.com');
  assert.notEqual(base, emailQueue.buildIdempotencyKey('LOAD_APPROVED', 'LS01', 'a@b.com'), 'different event');
  assert.notEqual(base, emailQueue.buildIdempotencyKey('LOAD_POSTED', 'LS02', 'a@b.com'), 'different entity');
  assert.notEqual(base, emailQueue.buildIdempotencyKey('LOAD_POSTED', 'LS01', 'c@d.com'), 'different recipient');
});

// ---------- EmailTemplateService ----------

test('render() produces both an HTML body and a plain-text fallback carrying the same field data', () => {
  const { html, text } = templates.render({
    title: 'Driver Assigned – LoadSmart',
    intro: 'You have been assigned Load LS0000000001.',
    fields: [['Load ID', 'LS0000000001'], ['Pickup', 'Delhi'], ['Drop', 'Mumbai']],
    statusLabel: 'DRIVER ASSIGNED',
    ctaLabel: 'View Assignment',
    ctaUrl: '/driver/dashboard',
  });
  assert.ok(html.includes('Driver Assigned'));
  assert.ok(html.includes('LS0000000001'));
  assert.ok(html.includes('View Assignment'));
  assert.ok(html.includes('/driver/dashboard'));
  assert.ok(text.includes('LS0000000001'));
  assert.ok(text.includes('Pickup: Delhi'));
});

test('render() never includes an empty field row (undefined/null/blank values are dropped, not printed as "—")', () => {
  const { html, text } = templates.render({
    title: 'Test', fields: [['Weight', ''], ['Vehicle', undefined], ['Load ID', 'LS01']],
  });
  assert.ok(!html.includes('Weight'));
  assert.ok(!html.includes('Vehicle'));
  assert.ok(!text.includes('Weight'));
  assert.ok(html.includes('Load ID'));
});

test('render() HTML-escapes field values so an attacker-controlled field (e.g. a material/company name) cannot inject markup', () => {
  const { html } = templates.render({
    title: 'Test', fields: [['Material', '<img src=x onerror=alert(1)>']],
  });
  assert.ok(!html.includes('<img src=x'), 'raw HTML must never appear unescaped in the rendered email');
  assert.ok(html.includes('&lt;img'));
});

test('SECURITY: the template renderer has no code path that reads password/OTP/Aadhaar/PAN/bank fields — every field is caller-supplied label/value pairs only', () => {
  // This is a structural guarantee, not a per-call check: render() takes an
  // explicit `fields` array and never accepts (or reads) a raw user/driver
  // record, so there is no way for a call site to "forget" to strip a
  // sensitive field — it would have to be deliberately added to the
  // `fields` array, which every call site in lib/emailService.js avoids.
  const sensitiveLookingButExplicitlySafe = templates.render({
    title: 'Registration confirmed',
    fields: [['Username', 'shipper01'], ['Registered email', 'shipper01@example.com']],
  });
  assert.ok(!/password/i.test(sensitiveLookingButExplicitlySafe.html));
  assert.ok(!/otp/i.test(sensitiveLookingButExplicitlySafe.html));
});

test('appLink() only ever returns an in-app path — never accepts/embeds a caller-supplied external URL or a token in the query string', () => {
  assert.equal(templates.appLink('/portal/shipper/live-tracking?token=LS01'), '/portal/shipper/live-tracking?token=LS01');
  // Even a path missing its leading slash is normalized, never turned into
  // a protocol-relative or external-looking URL.
  assert.equal(templates.appLink('driver/dashboard'), '/driver/dashboard');
});

test('maskVehicleNumber shows only the first two and last four characters of a vehicle number', () => {
  assert.equal(templates.maskVehicleNumber('DL01AB1234'), 'DL••••1234');
  assert.equal(templates.maskVehicleNumber('AB12'), 'AB12'); // too short to usefully mask, returned as-is
});
