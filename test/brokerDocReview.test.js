/**
 * test/brokerDocReview.test.js
 *
 * Unit tests for lib/brokerDocReview.js — the ADVISORY-ONLY AI Document
 * Review feature (spec section 9) for Broker GST/MSME/PAN uploads. Covers:
 *  - PDFs are skipped (never sent to the vision model) with a clear note.
 *  - Not-configured (no ANTHROPIC_API_KEY) fails soft with an honest note.
 *  - A configured, mocked vision call parses a clean/fenced JSON reply.
 *  - Any AI failure (bad JSON, thrown error) resolves — never rejects —
 *    with a "waiting for manual admin review" result, so a document upload
 *    can never be blocked by this feature.
 *
 * Run: node --test test/brokerDocReview.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// A 1x1 PNG, base64-encoded — a tiny but structurally valid image data URL.
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjQK';

// ---------- Not configured ----------
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CHAT_AI_PROVIDER;
const brokerDocReviewUnconfigured = require('../lib/brokerDocReview');

test('PDF (or any non-image) upload is skipped entirely — never sent to the vision model, never blocks the upload', async () => {
  const result = await brokerDocReviewUnconfigured.reviewBrokerDocument({ documentType: 'GST', imageBase64DataUrl: PDF_DATA_URL });
  assert.equal(result.documentType, 'GST');
  assert.equal(result.looksReadable, null);
  assert.equal(result.looksLikeExpectedDocument, null);
  assert.match(result.summary, /PDF/i);
  assert.ok(result.concerns.some((c) => /skipped/i.test(c)));
  assert.ok(result.reviewedAt instanceof Date);
});

test('not configured (no ANTHROPIC_API_KEY): resolves (never rejects) with an honest "waiting for manual review" note', async () => {
  const result = await brokerDocReviewUnconfigured.reviewBrokerDocument({ documentType: 'PAN', imageBase64DataUrl: TINY_PNG_DATA_URL });
  assert.equal(result.documentType, 'PAN');
  assert.equal(result.looksReadable, null);
  assert.match(result.summary, /not configured/i);
});

// ---------- Configured (fake key) — exercise the vision request/response plumbing ----------
test('configured behavior: parses clean JSON, strips markdown fences, and fails soft on bad output', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'fake-test-key-not-real';
  process.env.CHAT_AI_PROVIDER = 'anthropic';
  delete require.cache[require.resolve('../lib/aiService')];
  delete require.cache[require.resolve('../lib/brokerDocReview')];
  const brokerDocReview = require('../lib/brokerDocReview');

  await t.test('clean JSON reply is parsed into the advisory shape', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '{"looksReadable":true,"looksLikeExpectedDocument":true,"confidence":0.87,"concerns":[],"summary":"Looks like a clear GST certificate."}' }] }),
    });
    t.after(() => { global.fetch = originalFetch; });
    const result = await brokerDocReview.reviewBrokerDocument({ documentType: 'GST', imageBase64DataUrl: TINY_PNG_DATA_URL });
    assert.equal(result.looksReadable, true);
    assert.equal(result.looksLikeExpectedDocument, true);
    assert.equal(result.confidence, 0.87);
    assert.equal(result.summary, 'Looks like a clear GST certificate.');
  });

  await t.test('```json-fenced reply is stripped before parsing', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '```json\n{"looksReadable":false,"looksLikeExpectedDocument":false,"confidence":0.2,"concerns":["blurry"],"summary":"Too blurry to confirm."}\n```' }] }),
    });
    t.after(() => { global.fetch = originalFetch; });
    const result = await brokerDocReview.reviewBrokerDocument({ documentType: 'MSME', imageBase64DataUrl: TINY_PNG_DATA_URL });
    assert.equal(result.looksReadable, false);
    assert.deepEqual(result.concerns, ['blurry']);
  });

  await t.test('unparseable model output fails soft: resolves with a manual-review note, never throws', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'I cannot help with that.' }] }) });
    t.after(() => { global.fetch = originalFetch; });
    const result = await brokerDocReview.reviewBrokerDocument({ documentType: 'GST', imageBase64DataUrl: TINY_PNG_DATA_URL });
    assert.equal(result.looksReadable, null);
    assert.match(result.summary, /manual admin review/i);
  });

  await t.test('a thrown/network error from the AI call fails soft — resolves, never rejects, never blocks the upload', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('network down'); };
    t.after(() => { global.fetch = originalFetch; });
    await assert.doesNotReject(async () => {
      const result = await brokerDocReview.reviewBrokerDocument({ documentType: 'PAN', imageBase64DataUrl: TINY_PNG_DATA_URL });
      assert.match(result.summary, /manual admin review/i);
    });
  });

  await t.test('confidence is clamped to [0,1] and concerns/summary are length-capped', async (t) => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ looksReadable: true, looksLikeExpectedDocument: true, confidence: 5, concerns: ['a'], summary: 'x'.repeat(1000) }) }] }),
    });
    t.after(() => { global.fetch = originalFetch; });
    const result = await brokerDocReview.reviewBrokerDocument({ documentType: 'GST', imageBase64DataUrl: TINY_PNG_DATA_URL });
    assert.equal(result.confidence, 1);
    assert.ok(result.summary.length <= 600);
  });
});
