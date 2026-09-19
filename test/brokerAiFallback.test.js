/**
 * test/brokerAiFallback.test.js
 *
 * Unit tests for lib/brokerAiFallback.js — the deterministic, rule-based
 * answers the Broker AI Assistant falls back to whenever the real LLM isn't
 * configured or a live call to it fails (server_load.js's POST
 * /api/broker/ai/chat). Uses a fake in-memory repo with the exact same
 * shape buildBrokerAiRepo() gives the real AI tool-calling path, so these
 * tests never touch Mongo/Express and never invent data the real repo
 * wouldn't actually return.
 *
 * Run: node --test test/brokerAiFallback.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, answerDeterministically, SUPPORTED_QUESTIONS } = require('../lib/brokerAiFallback');

function fakeRepo(overrides = {}) {
  return {
    getProfile: async () => ({ loadPreferences: {} }),
    getAvailableLoads: async () => [],
    getKycStatus: async () => ({ kycStatus: 'APPROVED', kycRejectionReason: '', kycDocumentsRequested: '', missingDocuments: [] }),
    getBids: async () => [],
    getActiveShipments: async () => [],
    ...overrides,
  };
}
const broker = { username: 'broker1', companyName: 'Acme Logistics' };

// ---------- classify ----------
test('classify: recognizes all 5 supported canonical questions', () => {
  assert.equal(classify('Which loads match my routes?'), 'LOADS_FOR_ROUTES');
  assert.equal(classify('What documents are missing?'), 'MISSING_DOCUMENTS');
  assert.equal(classify('Why is my account pending?'), 'ACCOUNT_PENDING');
  assert.equal(classify('Which bids are active?'), 'ACTIVE_BIDS');
  assert.equal(classify('What should I do next?'), 'NEXT_STEPS');
});

test('classify: is tolerant of rephrasing, not just the exact suggestion-chip text', () => {
  assert.equal(classify('any loads matching my route?'), 'LOADS_FOR_ROUTES');
  assert.equal(classify('do I need more documents?'), 'MISSING_DOCUMENTS');
  assert.equal(classify('why is my account still pending review'), 'ACCOUNT_PENDING');
  assert.equal(classify('what is the status of my active bids'), 'ACTIVE_BIDS');
});

test('classify: returns null for an unrelated/unsupported question rather than guessing', () => {
  assert.equal(classify('What is the weather in Delhi?'), null);
  assert.equal(classify(''), null);
});

test('SUPPORTED_QUESTIONS lists exactly the 5 questions the spec requires', () => {
  assert.deepEqual(SUPPORTED_QUESTIONS, [
    'Which loads match my routes?',
    'What documents are missing?',
    'Why is my account pending?',
    'Which bids are active?',
    'What should I do next?',
  ]);
});

// ---------- answerDeterministically: unsupported question ----------
test('answerDeterministically: an unsupported question comes back unmatched, never a fabricated answer', async () => {
  const result = await answerDeterministically({ broker, repo: fakeRepo(), message: 'Can you place a bid for me?' });
  assert.equal(result.matched, false);
});

// ---------- LOADS_FOR_ROUTES ----------
test('LOADS_FOR_ROUTES: reports no open loads plainly when the board is empty', async () => {
  const result = await answerDeterministically({ broker, repo: fakeRepo(), message: 'Which loads match my routes?' });
  assert.equal(result.matched, true);
  assert.match(result.reply, /no open loads/i);
});

test('LOADS_FOR_ROUTES: ranks and lists only loads matching saved preferences, using real load data', async () => {
  const repo = fakeRepo({
    getProfile: async () => ({ loadPreferences: { preferredOrigins: ['Chandigarh'], preferredDestinations: [], preferredTruckTypes: [] } }),
    getAvailableLoads: async () => [
      { tokenNo: 'LS-1', pickup: 'Chandigarh', destination: 'Mumbai', requiredTruckType: '32 FT' },
      { tokenNo: 'LS-2', pickup: 'Kolkata', destination: 'Pune', requiredTruckType: '20 FT' },
    ],
  });
  const result = await answerDeterministically({ broker, repo, message: 'Which loads match my routes?' });
  assert.match(result.reply, /LS-1/);
  assert.ok(!result.reply.includes('LS-2'), 'a non-matching load must not be listed as a match');
});

test('LOADS_FOR_ROUTES: with no saved preferences, lists general open loads rather than saying "no match"', async () => {
  const repo = fakeRepo({ getAvailableLoads: async () => [{ tokenNo: 'LS-9', pickup: 'Delhi', destination: 'Agra', requiredTruckType: '' }] });
  const result = await answerDeterministically({ broker, repo, message: 'Which loads match my routes?' });
  assert.match(result.reply, /LS-9/);
  assert.match(result.reply, /haven't saved route preferences/i);
});

// ---------- MISSING_DOCUMENTS ----------
test('MISSING_DOCUMENTS: says nothing is missing when the real KYC record has no gaps', async () => {
  const result = await answerDeterministically({ broker, repo: fakeRepo(), message: 'What documents are missing?' });
  assert.match(result.reply, /no missing required documents/i);
});

test('MISSING_DOCUMENTS: lists only the real missing documents, never an invented one', async () => {
  const repo = fakeRepo({ getKycStatus: async () => ({ kycStatus: 'DRAFT', missingDocuments: ['GST certificate', 'Bank proof'] }) });
  const result = await answerDeterministically({ broker, repo, message: 'What documents are missing?' });
  assert.match(result.reply, /GST certificate/);
  assert.match(result.reply, /Bank proof/);
});

// ---------- ACCOUNT_PENDING ----------
test('ACCOUNT_PENDING: an approved account is reported as not pending', async () => {
  const result = await answerDeterministically({ broker, repo: fakeRepo(), message: 'Why is my account pending?' });
  assert.match(result.reply, /not pending/i);
});

test('ACCOUNT_PENDING: a DRAFT account correctly attributes the reason to documents not yet submitted', async () => {
  const repo = fakeRepo({ getKycStatus: async () => ({ kycStatus: 'DRAFT', missingDocuments: ['PAN card'] }) });
  const result = await answerDeterministically({ broker, repo, message: 'Why is my account pending?' });
  assert.match(result.reply, /documents have not been submitted/i);
  assert.match(result.reply, /PAN card/);
});

test('ACCOUNT_PENDING: SUBMITTED/PENDING_REVIEW correctly attributes the reason to admin review, not document submission', async () => {
  const repo = fakeRepo({ getKycStatus: async () => ({ kycStatus: 'PENDING_REVIEW', missingDocuments: [] }) });
  const result = await answerDeterministically({ broker, repo, message: 'Why is my account pending?' });
  assert.match(result.reply, /under admin review/i);
});

test('ACCOUNT_PENDING: a REJECTED KYC surfaces the real rejection reason and never a fabricated one', async () => {
  const repo = fakeRepo({ getKycStatus: async () => ({ kycStatus: 'REJECTED', kycRejectionReason: 'Blurry PAN photo' }) });
  const result = await answerDeterministically({ broker, repo, message: 'Why is my account pending?' });
  assert.match(result.reply, /rejected/i);
  assert.match(result.reply, /Blurry PAN photo/);
});

test('ACCOUNT_PENDING: admin-requested extra documents takes priority when present', async () => {
  const repo = fakeRepo({ getKycStatus: async () => ({ kycStatus: 'PENDING_REVIEW', kycDocumentsRequested: 'Updated GST certificate' }) });
  const result = await answerDeterministically({ broker, repo, message: 'Why is my account pending?' });
  assert.match(result.reply, /requested an additional document/i);
  assert.match(result.reply, /Updated GST certificate/);
});

// ---------- ACTIVE_BIDS ----------
test('ACTIVE_BIDS: reports no active bids when there are none', async () => {
  const result = await answerDeterministically({ broker, repo: fakeRepo(), message: 'Which bids are active?' });
  assert.match(result.reply, /no active bids/i);
});

test('ACTIVE_BIDS: lists only SUBMITTED/SHORTLISTED bids, excluding REJECTED/WITHDRAWN ones', async () => {
  const repo = fakeRepo({
    getBids: async () => [
      { loadId: 'LS-1', bidAmount: 20000, status: 'SUBMITTED' },
      { loadId: 'LS-2', bidAmount: 18000, status: 'REJECTED' },
      { loadId: 'LS-3', bidAmount: 22000, status: 'SHORTLISTED' },
    ],
  });
  const result = await answerDeterministically({ broker, repo, message: 'Which bids are active?' });
  assert.match(result.reply, /LS-1/);
  assert.match(result.reply, /LS-3/);
  assert.ok(!result.reply.includes('LS-2'));
});

// ---------- NEXT_STEPS ----------
test('NEXT_STEPS: points to completing KYC first when documents are missing', async () => {
  const repo = fakeRepo({ getKycStatus: async () => ({ kycStatus: 'DRAFT', missingDocuments: ['PAN card'] }) });
  const result = await answerDeterministically({ broker, repo, message: 'What should I do next?' });
  assert.match(result.reply, /complete your KYC/i);
});

test('NEXT_STEPS: once approved with no bids, points to browsing open loads', async () => {
  const repo = fakeRepo({ getAvailableLoads: async () => [{ tokenNo: 'LS-1' }] });
  const result = await answerDeterministically({ broker, repo, message: 'What should I do next?' });
  assert.match(result.reply, /open load/i);
});

test('NEXT_STEPS: with active bids pending, points to My Bids rather than suggesting new loads', async () => {
  const repo = fakeRepo({ getBids: async () => [{ loadId: 'LS-1', status: 'SUBMITTED' }] });
  const result = await answerDeterministically({ broker, repo, message: 'What should I do next?' });
  assert.match(result.reply, /active bid/i);
});

// ---------- Never throws ----------
test('answerDeterministically: a repo failure degrades to a safe apology, never an unhandled throw', async () => {
  const repo = fakeRepo({ getKycStatus: async () => { throw new Error('DB down'); } });
  const result = await answerDeterministically({ broker, repo, message: 'What documents are missing?' });
  assert.equal(result.matched, true);
  assert.match(result.reply, /could not find that information/i);
});
