/**
 * lib/brokerAiTools.js
 *
 * The Broker AI Operations Assistant's tool definitions + a safe tool
 * executor — the "structured tool/function-style logic" spec section 8
 * asks for, built on lib/aiService.js's existing completeWithTools() loop
 * (the exact same tool-calling machinery already used elsewhere in this
 * app — no second AI plumbing is created here).
 *
 * SECURITY MODEL (spec section 8 "AI Safety Rules"):
 *  - Every tool function below takes the already-authenticated broker's
 *    Registration record as its FIRST argument, resolved server-side from
 *    the request's session token before this module is ever called — never
 *    from anything the model or the client supplies. A tool's `input` can
 *    only ever narrow a query that is already scoped to that broker; it can
 *    never widen it to another user's data. There is no "brokerId" input
 *    parameter on any tool for exactly this reason — the identity is
 *    injected, never accepted as a tool argument.
 *  - No tool ever returns another user's private data, a password, a
 *    token, or a raw document file — only booleans/paths-present flags for
 *    documents, never the bytes or a guessable direct URL.
 *  - No tool can perform a write (approve KYC, accept a bid, change a
 *    price, assign a driver, change shipment status). Every tool here is
 *    read-only; the assistant can only explain/recommend, and directs the
 *    broker to the real authenticated API + UI confirmation for any action.
 *
 * This module is deliberately DB-access-agnostic: it's handed a small
 * `repo` of already-scoped async data functions (implemented in
 * server_load.js, where the real Mongoose models live) rather than importing
 * models directly — same "pure logic, injected data access" shape as
 * lib/biddingEngine.js, and it's what makes this module unit-testable with
 * fake in-memory repos (see test/brokerAiTools.test.js) instead of needing
 * a real MongoDB connection just to test tool-call plumbing.
 */

const aiService = require('./aiService');

/** Anthropic tool-use schema — one entry per safe tool listed in spec section 8. */
const BROKER_AI_TOOLS = [
  {
    name: 'get_my_broker_profile',
    description: "Get the logged-in broker's own profile: name, broker type (individual/company), company name, address, contact details. Never includes another broker's data.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_kyc_status',
    description: "Get the logged-in broker's own KYC status, which documents are on file, which are missing, and any admin rejection reason or requested-documents note.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_available_loads',
    description: "List loads currently open for bidding that the logged-in broker could act on, optionally filtered by origin/destination/truck type.",
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Filter by pickup location substring (optional).' },
        destination: { type: 'string', description: 'Filter by destination substring (optional).' },
        truckType: { type: 'string', description: 'Filter by required truck type substring (optional).' },
      },
    },
  },
  {
    name: 'get_my_bids',
    description: "List the logged-in broker's own submitted bids/load requests and their current status (Submitted, Shortlisted, Accepted, Rejected, Withdrawn, Expired).",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional status filter, e.g. "SUBMITTED" or "ACCEPTED".' },
      },
    },
  },
  {
    name: 'get_my_active_shipments',
    description: "List shipments the logged-in broker is currently involved in (assigned to them or from an accepted bid of theirs) and their tracking status.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_notifications',
    description: "Get the logged-in broker's own recent in-app notifications (unread first).",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_load_summary',
    description: 'Get full real details for one specific load by its Token No. — only returns data the broker is authorized to see (never another party\'s private bid amounts).',
    input_schema: {
      type: 'object',
      properties: { tokenNo: { type: 'string', description: 'The load Token No., e.g. LS1234567890.' } },
      required: ['tokenNo'],
    },
  },
  {
    name: 'get_bid_comparison',
    description: "Compare the ranked carrier offers on one of the broker's own loads/shipments (AI match score, trust score, and final price only — never a competitor's raw bid amount or margin).",
    input_schema: {
      type: 'object',
      properties: { tokenNo: { type: 'string', description: 'The load Token No. to compare offers for.' } },
      required: ['tokenNo'],
    },
  },
];

/**
 * Builds an executeTool(name, input) closure bound to one already-
 * authenticated broker + a `repo` of scoped data-access functions.
 * @param {object} broker the broker's own Registration.lean() record (never trust a client-supplied id instead of this)
 * @param {object} repo {
 *   getProfile(broker) -> object,
 *   getKycStatus(broker) -> object,
 *   getAvailableLoads(broker, filters) -> array,
 *   getBids(broker, filters) -> array,
 *   getActiveShipments(broker) -> array,
 *   getNotifications(broker) -> array,
 *   getLoadSummary(broker, tokenNo) -> object|null,
 *   getBidComparison(broker, tokenNo) -> object|null,
 * }
 */
function createBrokerToolExecutor(broker, repo) {
  return async function executeTool(name, input) {
    const safeInput = input && typeof input === 'object' ? input : {};
    switch (name) {
      case 'get_my_broker_profile':
        return await repo.getProfile(broker);
      case 'get_my_kyc_status':
        return await repo.getKycStatus(broker);
      case 'get_my_available_loads':
        return await repo.getAvailableLoads(broker, {
          origin: safeInput.origin, destination: safeInput.destination, truckType: safeInput.truckType,
        });
      case 'get_my_bids':
        return await repo.getBids(broker, { status: safeInput.status });
      case 'get_my_active_shipments':
        return await repo.getActiveShipments(broker);
      case 'get_my_notifications':
        return await repo.getNotifications(broker);
      case 'get_load_summary': {
        if (!safeInput.tokenNo) return { error: 'A tokenNo is required.' };
        const result = await repo.getLoadSummary(broker, String(safeInput.tokenNo));
        return result || { error: 'I could not find that information.' };
      }
      case 'get_bid_comparison': {
        if (!safeInput.tokenNo) return { error: 'A tokenNo is required.' };
        const result = await repo.getBidComparison(broker, String(safeInput.tokenNo));
        return result || { error: 'I could not find that information.' };
      }
      default:
        return { error: `Unknown tool "${name}".` };
    }
  };
}

const SYSTEM_PROMPT = `You are the Load Smart Broker AI Operations Assistant.

You help ONE broker — the person currently logged in — understand their own account, loads, bids, shipments and notifications. You have read-only tools that fetch this broker's REAL data from the application's own database. You must call a tool before answering any question about their account, loads, bids, KYC, or shipments — never guess or invent details.

Hard rules:
- Never invent load numbers, prices, carrier names, tracking statuses, or document statuses. If a tool returns no data or an error, say plainly: "I could not find that information."
- You can only ever see this one broker's own data — you have no way to access anyone else's, and you must never claim otherwise.
- You cannot approve KYC, accept or reject bids, change prices, assign drivers, or change shipment status. You can only explain and recommend — tell the broker to use the relevant screen/button in their dashboard to actually take an action, and that any action requires their own confirmation there.
- Never repeat back a password, token, or raw document file content — you don't have access to any of those anyway.
- Keep answers concise, concrete, and grounded only in tool results.`;

/**
 * Runs the Broker AI Assistant for one message given the recent conversation
 * history. Fails soft in the SAME way every other AI feature in this app
 * does — the caller (server_load.js route) is expected to catch
 * aiService.AiNotConfiguredError and turn it into a clear 503, never a crash.
 * @param {{broker:object, repo:object, history:Array<{role:string, text:string}>, message:string}} args
 */
async function runBrokerAssistant({ broker, repo, history = [], message }) {
  const messages = [
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text || '') })),
    { role: 'user', content: String(message || '') },
  ];
  const executeTool = createBrokerToolExecutor(broker, repo);
  return aiService.completeWithTools({
    system: SYSTEM_PROMPT,
    messages,
    tools: BROKER_AI_TOOLS,
    executeTool,
    maxIterations: 5,
    maxTokens: 700,
  });
}

module.exports = { BROKER_AI_TOOLS, createBrokerToolExecutor, runBrokerAssistant, SYSTEM_PROMPT };
