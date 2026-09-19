/**
 * test/aiService.test.js
 *
 * Unit tests for lib/aiService.js — the one gateway every real-AI feature
 * (public chatbot, Admin Risk Copilot, POD vision check, Delay Risk
 * Narrator) calls through. Covers the two things that matter most for a
 * feature that depends on an external API key nobody can guarantee is set
 * in every environment: (1) it fails soft and predictably with NO key
 * configured, and (2) its request/response plumbing (JSON parsing with a
 * markdown-fence fallback, the tool-calling loop) is correct in isolation,
 * using a mocked global.fetch rather than a real network call.
 *
 * Run: node --test test/aiService.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------- Not configured (no ANTHROPIC_API_KEY set) ----------
// Must be the first requires in the file: aiService.js reads
// process.env.ANTHROPIC_API_KEY once, at module-load time.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CHAT_AI_PROVIDER;
const aiServiceUnconfigured = require('../lib/aiService');

test('isConfigured() is false with no API key set', () => {
  assert.equal(aiServiceUnconfigured.isConfigured(), false);
});

test('complete() throws AiNotConfiguredError (status 503) when no key is set — never a raw network error', async () => {
  await assert.rejects(
    () => aiServiceUnconfigured.complete({ prompt: 'hello' }),
    (err) => {
      assert.ok(err instanceof aiServiceUnconfigured.AiNotConfiguredError);
      assert.equal(err.status, 503);
      assert.equal(err.code, 'AI_NOT_CONFIGURED');
      return true;
    },
  );
});

test('completeJson() and completeVision() and completeWithTools() all throw the same AiNotConfiguredError when unconfigured', async () => {
  await assert.rejects(() => aiServiceUnconfigured.completeJson({ prompt: 'x' }), aiServiceUnconfigured.AiNotConfiguredError);
  await assert.rejects(() => aiServiceUnconfigured.completeVision({ prompt: 'x', imageBase64: 'abc', mediaType: 'image/jpeg' }), aiServiceUnconfigured.AiNotConfiguredError);
  await assert.rejects(() => aiServiceUnconfigured.completeWithTools({ system: 's', messages: [], tools: [], executeTool: async () => ({}) }), aiServiceUnconfigured.AiNotConfiguredError);
});

// ---------- Configured (fake key) — exercise request/response plumbing against a mocked fetch ----------
test('configured behavior: JSON parsing, markdown-fence stripping, and the tool-calling loop', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'fake-test-key-not-real';
  process.env.CHAT_AI_PROVIDER = 'anthropic';
  delete require.cache[require.resolve('../lib/aiService')];
  const aiService = require('../lib/aiService');

  await t.test('isConfigured() is true once a key is present', () => {
    assert.equal(aiService.isConfigured(), true);
  });

  await t.test('complete() extracts the text block from a mocked Anthropic response', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Hello from the mock model.' }] }),
    });
    t.after(() => { global.fetch = originalFetch; });
    const text = await aiService.complete({ prompt: 'hi' });
    assert.equal(text, 'Hello from the mock model.');
  });

  await t.test('completeJson() parses a clean JSON reply', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"riskLevel":"LOW","narrative":"all good"}' }] }) });
    t.after(() => { global.fetch = originalFetch; });
    const result = await aiService.completeJson({ prompt: 'assess' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { riskLevel: 'LOW', narrative: 'all good' });
  });

  await t.test('completeJson() strips ```json fences before parsing', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }] }) });
    t.after(() => { global.fetch = originalFetch; });
    const result = await aiService.completeJson({ prompt: 'assess' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { ok: true });
  });

  await t.test('completeJson() fails soft (ok:false, not a throw) on unparseable output', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'not json at all' }] }) });
    t.after(() => { global.fetch = originalFetch; });
    const result = await aiService.completeJson({ prompt: 'assess' });
    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.equal(result.raw, 'not json at all');
  });

  await t.test('a non-2xx provider response becomes a thrown Error with a safe status, not a crash', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
    t.after(() => { global.fetch = originalFetch; });
    await assert.rejects(() => aiService.complete({ prompt: 'hi' }), (err) => {
      assert.match(err.message, /invalid x-api-key/);
      assert.equal(err.status, 502); // never surfaces the provider's own 401 as if it were this app's client's fault
      return true;
    });
  });

  await t.test('completeWithTools(): executes a requested tool and feeds the result back, then returns the final text', async (t) => {
    const originalFetch = global.fetch;
    let call = 0;
    global.fetch = async (url, opts) => {
      call += 1;
      if (call === 1) {
        // First turn: the model asks to call track_shipment.
        return {
          ok: true,
          json: async () => ({
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tool_1', name: 'track_shipment', input: { tokenNo: 'LS123' } }],
          }),
        };
      }
      // Second turn: after receiving the tool result, the model answers in plain text.
      const body = JSON.parse(opts.body);
      const lastMsg = body.messages[body.messages.length - 1];
      assert.equal(lastMsg.role, 'user');
      assert.equal(lastMsg.content[0].type, 'tool_result');
      assert.equal(lastMsg.content[0].tool_use_id, 'tool_1');
      return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Your shipment LS123 is In Transit.' }] }) };
    };
    t.after(() => { global.fetch = originalFetch; });

    const executed = [];
    const { text, toolCalls } = await aiService.completeWithTools({
      system: 'test',
      messages: [{ role: 'user', content: 'where is LS123' }],
      tools: [{ name: 'track_shipment', description: 'x', input_schema: { type: 'object', properties: {} } }],
      executeTool: async (name, input) => { executed.push({ name, input }); return { found: true, orders: [{ tokenNo: 'LS123', status: 'In Transit' }] }; },
    });
    assert.equal(text, 'Your shipment LS123 is In Transit.');
    assert.equal(executed.length, 1);
    assert.equal(executed[0].name, 'track_shipment');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].result.orders[0].status, 'In Transit');
  });

  await t.test('completeWithTools(): a tool that throws is reported back as an error result, not a crashed request', async (t) => {
    const originalFetch = global.fetch;
    let call = 0;
    global.fetch = async () => {
      call += 1;
      if (call === 1) return { ok: true, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'track_shipment', input: {} }] }) };
      return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry, I could not look that up.' }] }) };
    };
    t.after(() => { global.fetch = originalFetch; });
    const { text } = await aiService.completeWithTools({
      system: 's', messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'track_shipment', description: 'x', input_schema: { type: 'object', properties: {} } }],
      executeTool: async () => { throw new Error('DB is down'); },
    });
    assert.equal(text, 'Sorry, I could not look that up.');
  });

  await t.test('completeWithTools(): hits maxIterations and returns a safe fallback instead of looping forever', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'track_shipment', input: {} }] }) });
    t.after(() => { global.fetch = originalFetch; });
    const { text, toolCalls } = await aiService.completeWithTools({
      system: 's', messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'track_shipment', description: 'x', input_schema: { type: 'object', properties: {} } }],
      executeTool: async () => ({ found: false }),
      maxIterations: 2,
    });
    assert.match(text, /wasn't able to finish/);
    assert.equal(toolCalls.length, 2); // one tool call attempted per iteration, capped
  });

  await t.test('a request that times out surfaces as a clear 504, not a hung promise', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = () => new Promise((resolve, reject) => {
      // Simulate an abort firing (as REQUEST_TIMEOUT_MS would trigger in production)
      // without actually waiting 20 real seconds in this test.
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
    t.after(() => { global.fetch = originalFetch; });
    await assert.rejects(() => aiService.complete({ prompt: 'hi' }), (err) => {
      assert.equal(err.status, 504);
      return true;
    });
  });
});
