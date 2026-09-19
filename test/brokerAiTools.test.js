/**
 * test/brokerAiTools.test.js
 *
 * Unit tests for lib/brokerAiTools.js — the Broker AI Operations
 * Assistant's tool executor. The critical property under test is the
 * security model itself (spec section 8): every tool call is bound to the
 * already-authenticated broker record injected at executor-creation time,
 * NEVER to anything the model or a client could supply as an argument —
 * so these tests use fake in-memory repos (no live MongoDB needed, same
 * DB-free philosophy as lib/biddingEngine.js's own tests) and assert on
 * exactly which broker object each repo function actually received.
 *
 * Run: node --test test/brokerAiTools.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.ANTHROPIC_API_KEY;
delete process.env.CHAT_AI_PROVIDER;
const brokerAiTools = require('../lib/brokerAiTools');
const aiService = require('../lib/aiService');

const BROKER_A = { id: 'broker-A', username: 'broker_a', companyName: 'Alpha Logistics' };
const BROKER_B = { id: 'broker-B', username: 'broker_b', companyName: 'Beta Freight' };

function fakeRepo() {
  const calls = [];
  return {
    calls,
    async getProfile(broker) { calls.push(['getProfile', broker]); return { companyName: broker.companyName }; },
    async getKycStatus(broker) { calls.push(['getKycStatus', broker]); return { kycStatus: 'APPROVED' }; },
    async getAvailableLoads(broker, filters) { calls.push(['getAvailableLoads', broker, filters]); return [{ tokenNo: 'LS1' }]; },
    async getBids(broker, filters) { calls.push(['getBids', broker, filters]); return [{ id: 'BID-1', status: 'SUBMITTED' }]; },
    async getActiveShipments(broker) { calls.push(['getActiveShipments', broker]); return [{ tokenNo: 'LS1' }]; },
    async getNotifications(broker) { calls.push(['getNotifications', broker]); return [{ title: 'hi' }]; },
    async getLoadSummary(broker, tokenNo) {
      calls.push(['getLoadSummary', broker, tokenNo]);
      // Simulates the real repo's ownership check in server_load.js: a
      // load belonging to a different broker resolves to null, never data.
      if (broker.id !== 'broker-A') return null;
      return { tokenNo, pickup: 'Mumbai', destination: 'Delhi' };
    },
    async getBidComparison(broker, tokenNo) {
      calls.push(['getBidComparison', broker, tokenNo]);
      if (broker.id !== 'broker-A') return null;
      return { offers: [{ rank: 1, finalShipperPrice: 50000 }] };
    },
  };
}

test('BROKER_AI_TOOLS defines exactly the 8 safe, read-only tools from spec section 8 — none accept a brokerId input', () => {
  const names = brokerAiTools.BROKER_AI_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'get_bid_comparison', 'get_load_summary', 'get_my_active_shipments', 'get_my_available_loads',
    'get_my_bids', 'get_my_broker_profile', 'get_my_kyc_status', 'get_my_notifications',
  ].sort());
  brokerAiTools.BROKER_AI_TOOLS.forEach((tool) => {
    const propNames = Object.keys(tool.input_schema.properties || {});
    assert.ok(!propNames.some((p) => /broker.?id/i.test(p)), `${tool.name} must never accept a broker id as input`);
  });
});

test('every tool call is scoped to the injected broker — the executor never accepts an id override', async () => {
  const repo = fakeRepo();
  const executeTool = brokerAiTools.createBrokerToolExecutor(BROKER_A, repo);

  await executeTool('get_my_broker_profile', {});
  await executeTool('get_my_kyc_status', {});
  await executeTool('get_my_available_loads', { origin: 'Mumbai', brokerId: 'broker-B' }); // extra/forged field is simply ignored
  await executeTool('get_my_bids', { status: 'SUBMITTED' });
  await executeTool('get_my_active_shipments', {});
  await executeTool('get_my_notifications', {});

  assert.equal(repo.calls.length, 6);
  repo.calls.forEach(([, broker]) => assert.equal(broker.id, 'broker-A'));
  const loadsCall = repo.calls.find((c) => c[0] === 'getAvailableLoads');
  assert.equal(loadsCall[2].origin, 'Mumbai');
  assert.equal(loadsCall[2].brokerId, undefined); // forged field never reaches the filters object
});

test('get_load_summary / get_bid_comparison: a broker can read their own load, but a different broker gets "could not find" — never leaked data', async () => {
  const repo = fakeRepo();
  const ownerTool = brokerAiTools.createBrokerToolExecutor(BROKER_A, repo);
  const otherTool = brokerAiTools.createBrokerToolExecutor(BROKER_B, repo);

  const ownResult = await ownerTool('get_load_summary', { tokenNo: 'LS1' });
  assert.equal(ownResult.pickup, 'Mumbai');

  const otherResult = await otherTool('get_load_summary', { tokenNo: 'LS1' });
  assert.equal(otherResult.error, 'I could not find that information.');
  assert.equal(otherResult.pickup, undefined);

  const missingTokenResult = await ownerTool('get_load_summary', {});
  assert.equal(missingTokenResult.error, 'A tokenNo is required.');

  const bidCompOther = await otherTool('get_bid_comparison', { tokenNo: 'LS1' });
  assert.equal(bidCompOther.error, 'I could not find that information.');
});

test('an unknown tool name is reported as an error, never thrown', async () => {
  const repo = fakeRepo();
  const executeTool = brokerAiTools.createBrokerToolExecutor(BROKER_A, repo);
  const result = await executeTool('delete_everything', {});
  assert.match(result.error, /Unknown tool/);
});

test('a non-object input (null/string/number) never crashes the executor', async () => {
  const repo = fakeRepo();
  const executeTool = brokerAiTools.createBrokerToolExecutor(BROKER_A, repo);
  await assert.doesNotReject(() => executeTool('get_my_available_loads', null));
  await assert.doesNotReject(() => executeTool('get_my_available_loads', 'not-an-object'));
});

test('runBrokerAssistant fails soft with AiNotConfiguredError when no ANTHROPIC_API_KEY is set — same contract as every other AI feature', async () => {
  assert.equal(aiService.isConfigured(), false);
  await assert.rejects(
    () => brokerAiTools.runBrokerAssistant({ broker: BROKER_A, repo: fakeRepo(), history: [], message: 'which loads match my routes?' }),
    aiService.AiNotConfiguredError,
  );
});

test('SYSTEM_PROMPT enforces the write-action ban and the "never invent data" rule in plain language', () => {
  const prompt = brokerAiTools.SYSTEM_PROMPT.toLowerCase();
  assert.match(prompt, /never invent/);
  assert.match(prompt, /cannot approve kyc/);
  assert.match(prompt, /only ever see this one broker/);
});
