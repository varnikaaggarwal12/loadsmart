/**
 * test/brokerLoadPosting.test.js
 *
 * Unit tests for lib/brokerLoadPosting.js — the pure, DB-free validation and
 * edit/cancel eligibility rules behind the Broker Portal's "+ Post New Load"
 * feature (POST /api/broker/loads and friends in server_load.js).
 *
 * Run: node --test test/brokerLoadPosting.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBrokerLoadPosting, canEditBrokerLoad, canCancelBrokerLoad } = require('../lib/brokerLoadPosting');

function baseBody(overrides = {}) {
  return {
    pickup: 'Chandigarh', destination: 'Delhi', material: 'Steel coils', weight: 5000,
    requiredTruckType: '32 FT', numberOfTrucks: 1,
    pickupDateTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    deliveryDeadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    budgetRate: 25000, contactPerson: 'Ramesh Kumar', contactPhone: '9876543210',
    ...overrides,
  };
}

// ---------- validateBrokerLoadPosting: happy path ----------
test('validateBrokerLoadPosting: a fully-filled, valid form passes with no errors', () => {
  const { valid, errors } = validateBrokerLoadPosting(baseBody());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateBrokerLoadPosting: advance payment percent is only required/validated when advance payment is requested', () => {
  const { valid } = validateBrokerLoadPosting(baseBody({ advancePaymentPercent: 500 })); // out of range, but advancePaymentRequired is falsy
  assert.equal(valid, true);
  const withAdvance = validateBrokerLoadPosting(baseBody({ advancePaymentRequired: true, advancePaymentPercent: 25 }));
  assert.equal(withAdvance.valid, true);
});

// ---------- Required fields ----------
for (const field of ['pickup', 'destination', 'material', 'contactPerson']) {
  test(`validateBrokerLoadPosting: rejects a missing/blank "${field}"`, () => {
    const { valid, errors } = validateBrokerLoadPosting(baseBody({ [field]: '   ' }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.field === field));
  });
}

test('validateBrokerLoadPosting: rejects zero or negative weight', () => {
  assert.equal(validateBrokerLoadPosting(baseBody({ weight: 0 })).valid, false);
  assert.equal(validateBrokerLoadPosting(baseBody({ weight: -10 })).valid, false);
});

test('validateBrokerLoadPosting: rejects a missing required truck type', () => {
  const { valid, errors } = validateBrokerLoadPosting(baseBody({ requiredTruckType: '' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.field === 'requiredTruckType'));
});

test('validateBrokerLoadPosting: numberOfTrucks defaults to 1 when omitted, but rejects 0 or a fraction below 1 when explicitly given', () => {
  assert.equal(validateBrokerLoadPosting(baseBody({ numberOfTrucks: undefined })).valid, true);
  assert.equal(validateBrokerLoadPosting(baseBody({ numberOfTrucks: 0 })).valid, false);
});

test('validateBrokerLoadPosting: rejects a missing pickup date', () => {
  const { valid, errors } = validateBrokerLoadPosting(baseBody({ pickupDateTime: '' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.field === 'pickupDateTime'));
});

test('validateBrokerLoadPosting: rejects an unparseable pickup date', () => {
  const { valid, errors } = validateBrokerLoadPosting(baseBody({ pickupDateTime: 'not-a-date' }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.code === 'invalid_pickup_date'));
});

test('validateBrokerLoadPosting: rejects a delivery deadline before the pickup date', () => {
  const { valid, errors } = validateBrokerLoadPosting(baseBody({
    pickupDateTime: new Date('2026-06-10T10:00:00Z').toISOString(),
    deliveryDeadline: new Date('2026-06-05T10:00:00Z').toISOString(),
  }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.code === 'delivery_before_pickup'));
});

test('validateBrokerLoadPosting: delivery deadline is optional', () => {
  const { valid } = validateBrokerLoadPosting(baseBody({ deliveryDeadline: undefined }));
  assert.equal(valid, true);
});

test('validateBrokerLoadPosting: rejects a negative budget rate but allows it to be omitted entirely', () => {
  assert.equal(validateBrokerLoadPosting(baseBody({ budgetRate: -100 })).valid, false);
  assert.equal(validateBrokerLoadPosting(baseBody({ budgetRate: undefined })).valid, true);
});

test('validateBrokerLoadPosting: rejects an invalid contact phone but accepts common real-world formats', () => {
  assert.equal(validateBrokerLoadPosting(baseBody({ contactPhone: 'abc' })).valid, false);
  assert.equal(validateBrokerLoadPosting(baseBody({ contactPhone: '123' })).valid, false); // too short
  assert.equal(validateBrokerLoadPosting(baseBody({ contactPhone: '+91 98765 43210' })).valid, true);
});

test('validateBrokerLoadPosting: advance payment percent must be between 1 and 100 when advance payment is required', () => {
  assert.equal(validateBrokerLoadPosting(baseBody({ advancePaymentRequired: true, advancePaymentPercent: 0 })).valid, false);
  assert.equal(validateBrokerLoadPosting(baseBody({ advancePaymentRequired: true, advancePaymentPercent: 150 })).valid, false);
  assert.equal(validateBrokerLoadPosting(baseBody({ advancePaymentRequired: true, advancePaymentPercent: 50 })).valid, true);
});

test('validateBrokerLoadPosting: collects every failing field in one pass rather than stopping at the first error', () => {
  const { valid, errors } = validateBrokerLoadPosting({});
  assert.equal(valid, false);
  const fields = errors.map((e) => e.field);
  assert.ok(fields.includes('pickup'));
  assert.ok(fields.includes('destination'));
  assert.ok(fields.includes('material'));
  assert.ok(fields.includes('weight'));
  assert.ok(fields.includes('requiredTruckType'));
  assert.ok(fields.includes('contactPerson'));
  assert.ok(fields.includes('contactPhone'));
});

// ---------- canEditBrokerLoad ----------
test('canEditBrokerLoad: true only while the load is still a private DRAFT', () => {
  assert.equal(canEditBrokerLoad({ brokerLoadStatus: 'DRAFT' }), true);
  assert.equal(canEditBrokerLoad({ brokerLoadStatus: 'POSTED' }), false);
  assert.equal(canEditBrokerLoad({ brokerLoadStatus: 'CANCELLED' }), false);
});

// ---------- canCancelBrokerLoad ----------
test('canCancelBrokerLoad: false once already cancelled', () => {
  assert.equal(canCancelBrokerLoad({ brokerLoadStatus: 'CANCELLED', loadStage: 'POSTED' }), false);
});

test('canCancelBrokerLoad: true while the load has not yet reached a committed stage', () => {
  assert.equal(canCancelBrokerLoad({ brokerLoadStatus: 'DRAFT', loadStage: 'POSTED' }), true);
  assert.equal(canCancelBrokerLoad({ brokerLoadStatus: 'POSTED', loadStage: 'BIDDING_OPEN' }), true);
});

test('canCancelBrokerLoad: false once a carrier/driver has actually committed to the load', () => {
  for (const stage of ['ASSIGNED', 'DRIVER_ACCEPTED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED']) {
    assert.equal(canCancelBrokerLoad({ brokerLoadStatus: 'POSTED', loadStage: stage }), false, `expected ${stage} to block cancellation`);
  }
});
