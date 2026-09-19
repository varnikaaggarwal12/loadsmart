# Real AI Features — Load Smart

Four genuinely different uses of a real LLM (Claude, via the Anthropic API), all built on top of this app's *existing, deterministic* AI Match Score and Trust Score — never replacing or duplicating that math. Pricing and trust stay auditable and formula-based; the LLM's job everywhere below is to **explain, synthesize, or converse** on top of numbers the app already computed, not to invent new numbers.

All four fail soft. With no `ANTHROPIC_API_KEY` set, the app runs exactly as it did before this work — the chatbot uses its original rule-based responder, and the other three routes return a clear "AI isn't configured yet" (503) instead of an error page. Nothing about the existing matching, bidding, or trust-score systems changes.

## 1. Admin Risk & Recommendation Copilot

**What it does:** on a bid (Bidding admin screen) or a rate request (Rate Requests screen), admin can click **"🤖 AI Assessment"**. The LLM is handed the app's own already-computed structured data — the AI Match breakdown, Trust Score breakdown, price, distance, truck compatibility — and asked to synthesize it into a short recommendation (`ACCEPT`/`REVIEW`/`CAUTION` for bids, `APPROVE`/`REVIEW`/`CAUTION` for load rate requests) plus a plain-English narrative explaining *why*. It is explicitly instructed to never invent a number that wasn't given to it.

- `POST /api/admin/ai/bid-assessment/:token/:bidId` (requireAdmin)
- `POST /api/admin/ai/load-assessment/:token` (requireAdmin)
- Cached client-side per bid/load id so re-opening a screen doesn't re-spend an API call.

## 2. POD AI Vision Check

**What it does:** the moment a carrier or driver uploads a Proof of Delivery photo, the app automatically (no button — this is the one feature that's on-demand-per-upload rather than on-demand-per-click, since it's bounded to exactly once per upload) asks Claude's vision model whether the photo looks like a genuine, legible POD — a signed/stamped delivery document — or looks blank, unrelated, or unreadable. Result (`looksValid`, `confidence`, `concerns[]`, `summary`) is stored on the load (`podAiCheck`) and shown as a small note to the admin (Tracking screen) and the driver (dashboard: "✅ Looks good!" / "⚠️ you may want to re-upload a clearer photo").

- This is advisory only — it never blocks the upload or changes `podVerified`/`podStatus`, which stay a human decision.
- Only jpg/jpeg/png are vision-checked; PDFs are skipped (documented limitation).

## 3. Conversational Ops Assistant (public chatbot upgrade)

**What it does:** the existing public homepage chatbot (`POST /api/chat`) — previously pure keyword/regex matching — now, when an API key is configured, hands the conversation to Claude with one real tool: `track_shipment` (look up an order by Token No. or the last-4-digits phone match, the same privacy rule the existing public tracking-by-phone endpoint already enforces). Claude decides when to call it and turns the result into a natural reply. Falls back to the original rule-based responder on any error, or when unconfigured — so nothing regresses for a deployment without a key.

- Deliberately does **not** touch the separate, already-DB-grounded **admin** fleet chatbot (`resolveAdminChatReply`), which stays untouched and out of scope — that system already has its own "never mutates without a human" rule and isn't what this feature is about.

## 4. Delay Risk Narrator

**What it does:** for a load that's in progress, admin (Tracking screen) or the shipper themselves (Live Tracking portal) can click **"🤖 Check Delay Risk"**. Claude is given the load's stage, timeline, and tracking-event history (again, all data the app already has) and asked for a `LOW`/`MEDIUM`/`HIGH` risk read plus a short plain-English narrative of what's driving that read (e.g., "no GPS update in 6 hours while status is still 'In Transit'").

- `POST /api/admin/ai/delay-risk/:token` (requireAdmin)
- `POST /api/tracking/order/:token/ai-delay-risk` (shipper session, ownership-checked — a shipper can only run this on their own order)

## Setup

In `.env`:

```
CHAT_AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# Optional — defaults to a current Claude Sonnet model.
ANTHROPIC_MODEL=
```

No new npm dependency — `lib/aiService.js` uses Node's built-in `fetch`.

## Architecture

- **`lib/aiService.js`** is the *only* place that ever calls a provider's HTTP API. Every feature above calls through it — `complete()`, `completeJson()`, `completeVision()`, `completeWithTools()`. One typed `AiNotConfiguredError` (503) is the universal "no key set" signal every route catches.
- A 20-second timeout on every request surfaces as a 504, not a hung request.
- `completeWithTools()` implements the tool-calling loop for the Conversational Assistant, including a hard `maxIterations` cap so a confused model can't loop forever.

## Testing

- `test/aiService.test.js` — 14 tests covering the unconfigured fail-soft path, JSON parsing (including markdown-fence stripping), the tool-calling loop (including a thrown tool and the iteration cap), and timeout handling — all against a mocked `global.fetch`, no real API key needed.
- Full suite: **109/109 passing**, zero regressions in the existing matching/trust-score/bidding/GPS/trip-lifecycle/email test suites.
- Live-booted the server against an unreachable MongoDB (this sandbox has no live DB) and confirmed: the app starts cleanly, every new AI route correctly 401s when hit without an admin session (never a 500), and the public chatbot still answers normally via its rule-based fallback with no key configured.

## Known limitations

- No real Anthropic API call has been exercised against the live API in this environment (no key was available) — the request/response plumbing is verified against a mocked API, and the fail-soft path is fully tested, but a live smoke test with a real key is worth doing once you add one.
- OpenAI/Gemini are reserved `.env` slots for a future second provider — only Anthropic is actually implemented today.
- The Conversational Assistant's one tool is shipment tracking only; it doesn't (and shouldn't) get access to anything the admin chatbot already restricts to admins.
