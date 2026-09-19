/**
 * test/brokerService.test.js
 *
 * Unit tests for lib/brokerService.js — the pure, DB-free rules behind the
 * Broker module's conditional GST/MSME registration validation, KYC
 * completeness checks, neutral-language Risk Indicators, Opportunity Radar
 * scoring, and KYC-status <-> legacy-status mapping.
 *
 * Run: node --test test/brokerService.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const brokerService = require('../lib/brokerService');

// A real, checksum-valid GSTIN and PAN (freely reused across GST validator
// test suites/documentation examples) so the format+checksum path is
// actually exercised rather than always hitting the "invalid" branch.
const VALID_GST = '27AAPFU0939F1ZV';
const VALID_PAN = 'AAPFU0939F';

function baseValidBroker(overrides = {}) {
  return {
    contactPerson: 'Asha Rao',
    brokerType: 'individual',
    address: { addressLine: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    hasGST: false,
    hasMSME: false,
    panNumber: VALID_PAN,
    panDocumentPath: '/admin/kyc-photo/panDocument-1.jpg',
    bankAccountHolder: 'Asha Rao',
    bankAccountNumber: '123456789012',
    bankIfsc: 'HDFC0001234',
    bankName: 'HDFC Bank',
    bankAccountType: 'savings',
    bankProofPhotoPath: '/admin/kyc-photo/bankProof-1.jpg',
    ...overrides,
  };
}

test('isValidGST / isValidPAN / isValidMsme / isValidPincode', () => {
  assert.equal(brokerService.isValidGST(VALID_GST), true);
  assert.equal(brokerService.isValidGST('not-a-gst'), false);
  assert.equal(brokerService.isValidGST('27AAPFU0939F1ZX'), false); // wrong checksum digit
  assert.equal(brokerService.isValidPAN(VALID_PAN), true);
  assert.equal(brokerService.isValidPAN('12345ABCDE'), false);
  assert.equal(brokerService.isValidMsme('UDYAM-MH-01-0012345'), true);
  assert.equal(brokerService.isValidMsme('short'), false);
  assert.equal(brokerService.isValidPincode('411001'), true);
  assert.equal(brokerService.isValidPincode('4110'), false);
});

test('registration is valid when both GST and MSME are false (spec: registration must work with neither)', () => {
  const result = brokerService.validateBrokerRegistration(baseValidBroker());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('GST=true requires a valid gstNumber AND a document — GST=false skips both checks entirely', () => {
  const missingBoth = brokerService.validateBrokerRegistration(baseValidBroker({ hasGST: true }));
  assert.equal(missingBoth.valid, false);
  const codes = missingBoth.errors.map((e) => e.code);
  assert.ok(codes.includes('invalid_gst'));
  assert.ok(codes.includes('gst_document_required'));

  const invalidNumber = brokerService.validateBrokerRegistration(baseValidBroker({
    hasGST: true, gstNumber: 'GARBAGE123', gstDocumentPath: '/admin/kyc-photo/gst-1.jpg',
  }));
  assert.equal(invalidNumber.valid, false);
  assert.ok(invalidNumber.errors.some((e) => e.code === 'invalid_gst'));

  const validGst = brokerService.validateBrokerRegistration(baseValidBroker({
    hasGST: true, gstNumber: VALID_GST, gstDocumentPath: '/admin/kyc-photo/gst-1.jpg',
  }));
  assert.equal(validGst.valid, true);

  // hasGST left false: an invalid/garbage gstNumber sitting in the payload
  // is simply ignored — never validated when the flag itself is false.
  const gstFalseIgnored = brokerService.validateBrokerRegistration(baseValidBroker({
    hasGST: false, gstNumber: 'GARBAGE',
  }));
  assert.equal(gstFalseIgnored.valid, true);
});

test('MSME=true requires a valid msmeNumber AND a document — MSME=false skips both checks entirely', () => {
  const missingBoth = brokerService.validateBrokerRegistration(baseValidBroker({ hasMSME: true }));
  assert.equal(missingBoth.valid, false);
  const codes = missingBoth.errors.map((e) => e.code);
  assert.ok(codes.includes('invalid_msme'));
  assert.ok(codes.includes('msme_document_required'));

  const validMsme = brokerService.validateBrokerRegistration(baseValidBroker({
    hasMSME: true, msmeNumber: 'UDYAM-MH-01-0012345', msmeDocumentPath: '/admin/kyc-photo/msme-1.jpg',
  }));
  assert.equal(validMsme.valid, true);

  const msmeFalseIgnored = brokerService.validateBrokerRegistration(baseValidBroker({
    hasMSME: false, msmeNumber: 'x',
  }));
  assert.equal(msmeFalseIgnored.valid, true);
});

test('GST and MSME can both be true at once and are validated independently of each other', () => {
  const result = brokerService.validateBrokerRegistration(baseValidBroker({
    hasGST: true, gstNumber: VALID_GST, gstDocumentPath: '/admin/kyc-photo/gst-1.jpg',
    hasMSME: true, msmeNumber: 'UDYAM-MH-01-0012345', msmeDocumentPath: '/admin/kyc-photo/msme-1.jpg',
  }));
  assert.equal(result.valid, true);
});

test('PAN is always mandatory, regardless of GST/MSME state', () => {
  const result = brokerService.validateBrokerRegistration(baseValidBroker({ panNumber: '', panDocumentPath: '' }));
  assert.equal(result.valid, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes('invalid_pan'));
  assert.ok(codes.includes('pan_document_required'));
});

test('company broker type requires a company/agency name; individual does not', () => {
  const companyMissingName = brokerService.validateBrokerRegistration(baseValidBroker({ brokerType: 'company' }));
  assert.equal(companyMissingName.valid, false);
  assert.ok(companyMissingName.errors.some((e) => e.code === 'company_name_required'));

  const companyWithName = brokerService.validateBrokerRegistration(baseValidBroker({ brokerType: 'company', companyName: 'Acme Logistics' }));
  assert.equal(companyWithName.valid, true);
});

test('invalid pincode / missing address fields are rejected', () => {
  const result = brokerService.validateBrokerRegistration(baseValidBroker({
    address: { addressLine: '', city: '', state: '', pincode: '123' },
  }));
  assert.equal(result.valid, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes('address_required'));
  assert.ok(codes.includes('city_required'));
  assert.ok(codes.includes('state_required'));
  assert.ok(codes.includes('invalid_pincode'));
});

test('missingKycDocuments reflects conditional GST/MSME requirements and flags optional docs distinctly', () => {
  const record = { panDocumentPath: '', hasGST: true, hasMSME: false, bankProofPhotoPath: '/x', addressProofPath: '', profilePhotoPath: '' };
  const missing = brokerService.missingKycDocuments(record);
  assert.ok(missing.includes('PAN card'));
  assert.ok(missing.includes('GST certificate'));
  assert.ok(!missing.some((m) => m.includes('MSME'))); // hasMSME false — never flagged
  assert.ok(missing.some((m) => m.includes('Address proof') && m.includes('optional')));
});

test('kycStatusToAccountStatus / accountStatusToKycStatus mapping never disagrees with itself', () => {
  assert.equal(brokerService.kycStatusToAccountStatus('APPROVED'), 'accepted');
  assert.equal(brokerService.kycStatusToAccountStatus('REJECTED'), 'rejected');
  assert.equal(brokerService.kycStatusToAccountStatus('SUBMITTED'), 'pending');
  assert.equal(brokerService.kycStatusToAccountStatus('PENDING_REVIEW'), 'pending');
  assert.equal(brokerService.kycStatusToAccountStatus('DRAFT'), 'pending');
  assert.equal(brokerService.accountStatusToKycStatus('accepted'), 'APPROVED');
  assert.equal(brokerService.accountStatusToKycStatus('rejected'), 'REJECTED');
  assert.equal(brokerService.accountStatusToKycStatus('pending'), 'PENDING_REVIEW');
});

test('computeRiskIndicators uses neutral, non-accusatory language and never the word "fraud"', () => {
  const record = { kycStatus: 'SUBMITTED', panDocumentPath: '/x', bankProofPhotoPath: '/x', hasGST: false, hasMSME: false };
  const indicators = brokerService.computeRiskIndicators(record, { cancelledCount: 3, completedCount: 1, delayedCount: 2, openComplaints: 1 });
  const allText = indicators.map((i) => i.message.toLowerCase()).join(' ');
  assert.ok(!allText.includes('fraud'));
  assert.ok(!allText.includes('criminal'));
  assert.ok(indicators.some((i) => i.key === 'KYC_NOT_APPROVED'));
  assert.ok(indicators.some((i) => i.key === 'REPEATED_CANCELLATIONS'));
  assert.ok(indicators.some((i) => i.key === 'DELAYED_LOADS'));
  assert.ok(indicators.some((i) => i.key === 'OPEN_COMPLAINTS'));
});

test('computeRiskIndicators returns a single ALL_CLEAR indicator when everything is fine — never fabricates a problem', () => {
  const record = { kycStatus: 'APPROVED', panDocumentPath: '/x', bankProofPhotoPath: '/x', hasGST: false, hasMSME: false, addressProofPath: '/x', profilePhotoPath: '/x' };
  const indicators = brokerService.computeRiskIndicators(record, {});
  assert.equal(indicators.length, 1);
  assert.equal(indicators[0].key, 'ALL_CLEAR');
});

test('scoreOpportunities scores real loads only, ranks preference matches higher, and always attaches an explainable reason', () => {
  const loads = [
    { tokenNo: 'LS1', pickup: 'Mumbai Port', destination: 'Delhi Hub', requiredTruckType: 'Open Body', material: 'Steel Coils', pickupDateTime: new Date(Date.now() + 86400000).toISOString() },
    { tokenNo: 'LS2', pickup: 'Chennai Yard', destination: 'Bangalore Depot', requiredTruckType: 'Container', material: 'Electronics', pickupDateTime: new Date(Date.now() + 86400000).toISOString() },
  ];
  const preferences = { preferredOrigins: ['mumbai'], preferredDestinations: ['delhi'], preferredTruckTypes: ['open body'], preferredLoadCategories: ['steel'] };
  const scored = brokerService.scoreOpportunities(preferences, loads);
  assert.equal(scored.length, 2);
  assert.equal(scored[0].tokenNo, 'LS1'); // matches every preference — ranked first
  assert.ok(scored[0].score > scored[1].score);
  scored.forEach((s) => assert.ok(s.reasons.length > 0));
  // Never invents an opportunity that wasn't in the input list.
  assert.deepEqual(scored.map((s) => s.tokenNo).sort(), ['LS1', 'LS2']);
});

test('scoreOpportunities returns an empty list (never fabricated opportunities) when there are no open loads', () => {
  assert.deepEqual(brokerService.scoreOpportunities({}, []), []);
});

test('buildActivityTimeline merges and sorts mixed event sources newest-first', () => {
  const timeline = brokerService.buildActivityTimeline([
    { at: new Date('2026-01-01T00:00:00Z'), action: 'BROKER_REGISTERED' },
    { createdAt: new Date('2026-01-03T00:00:00Z'), title: 'KYC approved', message: 'Welcome aboard' },
    { at: new Date('2026-01-02T00:00:00Z'), label: 'Bid submitted', notes: 'LS999' },
    { /* no timestamp at all — dropped, never guessed */ action: 'ORPHAN_EVENT' },
  ]);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].label, 'KYC approved');
  assert.equal(timeline[1].label, 'Bid submitted');
  assert.equal(timeline[2].label, 'BROKER_REGISTERED');
});
