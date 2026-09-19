/**
 * lib/aiService.js
 *
 * The ONE gateway to a real LLM (Anthropic Claude by default — this app's
 * .env.example already reserved CHAT_AI_PROVIDER / ANTHROPIC_API_KEY /
 * OPENAI_API_KEY / GEMINI_API_KEY for exactly this, per the comment on the
 * old rule-based chatbot: "swapping the body of resolveChatReply() for a
 * call to Claude / OpenAI / Gemini later is a one-function change"). Every
 * AI feature in this app — the conversational assistant, the admin Risk &
 * Recommendation Copilot, the POD vision check, the delay-risk narrator —
 * calls through this ONE module. No route handler ever calls a provider's
 * HTTP API directly. That gives this app exactly one place that holds the
 * API key, one place that enforces a timeout, and one place to add a
 * second provider later.
 *
 * FAILS SOFT, ALWAYS: if no API key is configured, every exported function
 * throws the same typed `AiNotConfiguredError`, and every route that calls
 * this module catches that specific error and returns a clear "AI isn't
 * configured yet" response instead of a 500 — the same fail-soft
 * philosophy this codebase already applies to email
 * (lib/emailProvider.js: "sent": false / "skipped_no_smtp" rather than a
 * crash). No AI feature can ever break the app for a deployment that
 * hasn't set up a key.
 *
 * Uses Node's built-in global fetch() (Node 18+) — deliberately no new npm
 * dependency, consistent with this project's "reuse over add" philosophy.
 */

const PROVIDER = (process.env.CHAT_AI_PROVIDER || 'anthropic').toLowerCase();
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// A real, current Claude model id — override via env if your account should
// use a different one. (Anthropic periodically ships newer model ids; check
// docs.claude.com if this default ever needs bumping.)
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 20000; // never let a hung AI call hang an Express request indefinitely

class AiNotConfiguredError extends Error {
  constructor() {
    super('AI is not configured on this server — set CHAT_AI_PROVIDER and ANTHROPIC_API_KEY (or OPENAI_API_KEY/GEMINI_API_KEY once those providers are wired up) in the environment.');
    this.status = 503;
    this.code = 'AI_NOT_CONFIGURED';
  }
}

/** True once a real provider + API key are both present. Only 'anthropic' is actually wired up today — the others are reserved slots (see .env.example). */
function isConfigured() {
  return PROVIDER === 'anthropic' && !!ANTHROPIC_API_KEY;
}

async function anthropicRequest(body) {
  if (!isConfigured()) throw new AiNotConfiguredError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `Anthropic API returned HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status >= 400 && res.status < 500 ? 502 : 503; // never leak the provider's own 4xx as if it were the caller's fault
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('The AI request timed out. Please try again.');
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Plain text-in, text-out completion — the workhorse for the Risk &
 * Recommendation Copilot and the Delay Risk Narrator: give it a system
 * prompt (the persona/task) and a single user message (the structured
 * context, already computed by this app's own deterministic logic), get
 * back the model's text.
 * @param {{system?:string, prompt:string, maxTokens?:number}} args
 * @returns {Promise<string>}
 */
async function complete({ system, prompt, maxTokens = 700 }) {
  const data = await anthropicRequest({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = (data.content || []).find((b) => b.type === 'text');
  return block ? block.text : '';
}

/**
 * Same as complete(), but asks the model to answer as strict JSON matching
 * a described shape, and safely falls back to a plain-text wrapper if the
 * model's output isn't valid JSON (never throws on a malformed response —
 * the caller always gets a usable object).
 * @param {{system?:string, prompt:string, maxTokens?:number}} args
 * @returns {Promise<{ok:boolean, data:object|null, raw:string}>}
 */
async function completeJson({ system, prompt, maxTokens = 700 }) {
  const raw = await complete({
    system: `${system || ''}\n\nRespond with ONLY a single valid JSON object — no markdown code fences, no prose before or after it.`.trim(),
    prompt,
    maxTokens,
  });
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  try {
    return { ok: true, data: JSON.parse(cleaned), raw };
  } catch (err) {
    return { ok: false, data: null, raw };
  }
}

/**
 * A single image + a text question — the Vision Verifier's workhorse.
 * @param {{system?:string, prompt:string, imageBase64:string, mediaType:string, maxTokens?:number}} args
 * @returns {Promise<string>}
 */
async function completeVision({ system, prompt, imageBase64, mediaType, maxTokens = 500 }) {
  const data = await anthropicRequest({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  const block = (data.content || []).find((b) => b.type === 'text');
  return block ? block.text : '';
}

/**
 * The tool-calling loop behind the Conversational Ops Assistant: sends the
 * conversation + a list of tool definitions; if Claude decides to call a
 * tool, `executeTool(name, input)` is invoked to actually run it against
 * this app's real data, the result is fed back, and the loop continues
 * until Claude gives a final text answer (or `maxIterations` is hit, as a
 * hard safety cap against a runaway loop).
 * @param {{system:string, messages:Array<{role:string, content:any}>, tools:Array<object>, executeTool:(name:string, input:object)=>Promise<object>, maxIterations?:number, maxTokens?:number}} args
 * @returns {Promise<{text:string, toolCalls:Array<{name:string, input:object, result:object}>}>}
 */
async function completeWithTools({ system, messages, tools, executeTool, maxIterations = 4, maxTokens = 600 }) {
  let convo = messages.slice();
  const toolCalls = [];
  for (let i = 0; i < maxIterations; i++) {
    const data = await anthropicRequest({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: convo,
      tools,
    });
    const content = data.content || [];
    const toolUseBlocks = content.filter((b) => b.type === 'tool_use');
    if (!toolUseBlocks.length || data.stop_reason !== 'tool_use') {
      const textBlock = content.find((b) => b.type === 'text');
      return { text: textBlock ? textBlock.text : '', toolCalls };
    }
    convo = [...convo, { role: 'assistant', content }];
    const toolResults = [];
    for (const block of toolUseBlocks) {
      let result;
      try {
        result = await executeTool(block.name, block.input || {});
      } catch (err) {
        result = { error: err.message || 'Tool call failed.' };
      }
      toolCalls.push({ name: block.name, input: block.input, result });
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    convo = [...convo, { role: 'user', content: toolResults }];
  }
  return { text: "I wasn't able to finish looking that up — please try rephrasing, or use the quick options below.", toolCalls };
}

module.exports = {
  AiNotConfiguredError,
  isConfigured,
  complete,
  completeJson,
  completeVision,
  completeWithTools,
  ANTHROPIC_MODEL,
};
