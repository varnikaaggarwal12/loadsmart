# LoadSmart Broker Portal — Real Modules + AI Error Fix

Implementation report for: *"LoadSmart Broker Portal — Implement Real Broker Modules and Fix AI Errors."*

This upgrade is additive on top of the existing Broker Portal (built in two prior sessions). It reuses the existing `BookingRequest` load model, `Registration` (role-discriminated) accounts, `Truck`/`Driver` fleet, `Bid` model, session auth, matching/bidding/trust-score engines, and the email notification architecture — nothing existing was rebuilt or removed.

## 1. What's new, end to end

| Spec section | Status | Notes |
|---|---|---|
| Real Load Board posting (`+ Post New Load`) | ✅ Done | New DRAFT → POSTED lifecycle on top of `BookingRequest` |
| Find Carrier from a load card | ✅ Done | Uses the weighted Load Matching engine |
| Load Matching tab (2 panels, deterministic) | ✅ Done | Works with or without the AI provider configured |
| Carrier Connect (search/filter/roster/My Connected Carriers) | ✅ Done | New `CarrierConnection` model, separate from last session's per-load `BrokerConnection` |
| My Shipments (renamed, filtered, timeline) | ✅ Done | Filter dropdown + expandable timeline per shipment |
| AI Assistant error-handling fix | ✅ Done | One-time config check, one clear banner, deterministic fallback for 5 questions |
| SMS notifications (Twilio) | ✅ Done | Built from scratch — no SMS infra existed before this |
| Backend ownership/RBAC/audit | ✅ Done | Every new route scoped to the logged-in broker's own session |
| Tests | ✅ 211/211 passing | 49 new tests across 3 files, 0 regressions |

## 2. New files

- **`lib/smsProvider.js`** — Twilio REST transport (raw `fetch`, no SDK), `console` fallback provider for local dev, mirrors `lib/emailProvider.js` exactly.
- **`lib/smsQueue.js`** — in-process async queue with idempotency keys (`eventType::entityId::recipient`) and retry (3 attempts, backoff), mirrors `lib/emailQueue.js` exactly. No Redis/BullMQ was added — the codebase has neither, and its own stated philosophy is not to add infra a queue this size doesn't need.
- **`lib/smsService.js`** — 14 named event functions (`sendLoadPostedSms`, `sendBidAcceptedSms`, `sendPodUploadedSms`, etc.), all fire-and-forget-safe, all no-op cleanly when a user has no phone number on file.
- **`lib/brokerLoadPosting.js`** — pure validation for the Post New Load form (`validateBrokerLoadPosting`) plus edit/cancel eligibility rules (`canEditBrokerLoad`, `canCancelBrokerLoad`).
- **`lib/brokerAiFallback.js`** — deterministic answers for the 5 supported AI questions, built on the *same* read-only data-access repo the real AI tool-calling path uses, so a fallback answer can never show different data than the real assistant would.
- **`test/brokerLoadPosting.test.js`** — 19 tests.
- **`test/brokerAiFallback.test.js`** — 21 tests.

## 3. Edited files

- **`lib/opsModels.js`** — added `SmsLog` model (mirrors `EmailLog`: status `PENDING/PROCESSING/SENT/FAILED/RETRYING`, idempotency key, attempts, error message).
- **`lib/brokerAutomationModels.js`** — added `CarrierConnection` (general broker↔carrier roster relationship, `PENDING/ACCEPTED/REJECTED/CANCELLED`, DB-level unique-pair guard for active requests) and `LoadCarrierInvite` (idempotent "invited this carrier to bid on this load" record).
- **`lib/brokerAutomation.js`** — added the exact weighted Load Matching engine: `BROKER_LOAD_MATCH_WEIGHTS = { origin: 25, destination: 25, truckType: 15, capacity: 15, availability: 10, verification: 5, trust: 5 }`, `computeBrokerLoadMatchScore()`, `buildBrokerMatchExplanation()` (produces sentences like *"89% match — pickup location is compatible, truck type matches what the load requires, and capacity is sufficient."*, built only from real breakdown values, never templated fluff).
- **`server_load.js`** — the bulk of the work. New sections:
  - **Broker-posted loads**: `bookingRequestSchema` extended additively with `postedByRole`, `postedByBrokerUsername`, `postedByBrokerCompanyName`, `numberOfTrucks`, `budgetRate`, `loadingInstructions`, `unloadingInstructions`, `specialRequirements`, `contactPerson`, `contactPhone`, `advancePaymentRequired/Percent/ReceivedAt`, `requiredDocuments`, `brokerLoadStatus` (`DRAFT/POSTED/CANCELLED`), `cancelledAt/Reason`. Deliberately **separate** from the pre-existing `brokerUsername` field (which means "who brokered the winning deal," set only at bid-acceptance) — no existing query's behavior changed.
  - Routes: `POST /api/broker/loads`, `GET /api/broker/loads/mine`, `PATCH /api/broker/loads/:token`, `POST /api/broker/loads/:token/open-bidding` (reuses the exact same `openLoadForBidding()` helper the shipper flow uses), `PATCH /api/broker/loads/:token/cancel`, `GET /api/broker/loads/:token/bids` (read-only ranked view).
  - **Carrier Connect**: `GET /api/broker/carriers` (extended with `truckType`, `minCapacity`, `route`, `availableOnly`, `minTrustScore`, `includeUnverified` filters), `GET /api/broker/carriers/:id`, `POST/GET/PATCH /api/broker/carrier-connections`, `POST /api/broker/loads/:token/invite-carrier`.
  - **Load Matching**: `GET /api/broker/load-matching/loads` (Panel A — reuses `brokerService.scoreOpportunities`, the same engine already powering the Overview tab's Opportunity Radar, so the two views can never disagree), `GET /api/broker/load-matching/carriers/:loadId` (Panel B — the weighted engine above, run against every real truck platform-wide).
  - **AI Assistant fix**: `GET /api/broker/ai/status` (cheap, no rate limit — lets the frontend check config *once* instead of learning it from a failed chat call) and a rewritten `POST /api/broker/ai/chat` that checks `aiService.isConfigured()` **up front** and routes straight to the deterministic fallback (HTTP 200, not a 503) rather than ever entering a retry loop. A live AI call that fails mid-request degrades to the same fallback instead of surfacing a raw error.
  - **My Shipments**: `BROKER_SHIPMENT_FILTERS` (9 filter predicates), enriched response (driver name, vehicle number, payment/advance-payment/POD status, per-load timeline).
  - **SMS wiring** at 13 real event points: load posted, load approved (opened for bidding), carrier connection requested/accepted/rejected, carrier invited to bid, bid submitted, bid accepted (both winning carrier and winning broker), advance payment received, driver assigned, shipment dispatched, shipment delivered, POD uploaded, admin requested documents. Every call is `.catch(() => {})`-guarded so a Twilio failure never rolls back the business transaction it followed, and every call fires **only after** the triggering DB write already succeeded.
  - `PATCH /api/admin/loads/:token/advance-payment` — new admin action so "advance payment received" is a real, explicit event.
- **`.env.example`** — added the 5 Twilio env vars (`SMS_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID`).
- **`views/portal/broker-dashboard.html` / `.js` / `.css`** — the full frontend build:
  - Nav reordered to Overview → **Load Matching** (new) → Load Board → Carrier Connect → **My Shipments** (renamed from "Shipments") → My Bids → KYC & Documents → AI Assistant → Profile.
  - **Load Board**: new "My Posted Loads" section with the `+ Post New Load` modal (all spec fields), and per-load actions: Edit (DRAFT only), Open for bidding, Find Carrier, View bids, Cancel.
  - **Load Matching tab**: Panel A (loads ranked against saved preferences) and Panel B (pick a load → ranked carriers, showing the weighted score and plain-language explanation).
  - **Carrier Connect**: new search/filter carrier cards (Connect / View profile / Invite to load) plus a "My Connected Carriers" list with Cancel; the prior session's per-carrier workflow (Select Carrier → Find Loads → Save → Request Shipper Connection) is kept intact under "Advanced: Per-Carrier Load Workflow" — nothing removed.
  - **My Shipments**: status filter dropdown (9 statuses) + expandable per-shipment timeline.
  - **AI Assistant**: one-time `/api/broker/ai/status` check on tab open, a single unavailability banner, Ask button disabled during a request, duplicate-question debounce (4s), distinct handling of 429/503/401 responses, never shows a raw error.

## 4. Database changes

No migration script was needed — every change is an additive Mongoose schema field or a brand-new collection (`SmsLog`, `CarrierConnection`, `LoadCarrierInvite`); existing documents are unaffected and don't need backfilling. New indexes added: `registrationSchema.index({status:1})`, `truckSchema.index({truckType:1})`, `truckSchema.index({status:1})`, plus indexes on the new `BookingRequest` fields (`postedByBrokerUsername`, `pickup`, `destination`, `requiredTruckType`) and the two new automation models' own compound/unique indexes (see `lib/brokerAutomationModels.js`).

## 5. Test results

```
npm test
# tests 211
# pass 211
# fail 0
```

162 pre-existing tests still pass unchanged (no regressions). 49 new tests added:
- `test/brokerLoadPosting.test.js` (19) — required-field validation, phone/date/budget/advance-percent edge cases, edit/cancel eligibility across every load stage.
- `test/brokerAiFallback.test.js` (21) — question classification (including rephrasings), all 5 canonical answers using only real fake-repo data (never invented), the "unsupported question" path, and a repo-failure path that degrades safely instead of throwing.
- `test/brokerAutomation.test.js` (+7) — the weighted Load Matching engine: exact weight percentages, a strong-match case, a wrong-truck-type case, insufficient capacity, unavailable truck, trust-score fallback chain, and score clamping.

## 6. Known, deliberate limitations (called out rather than hidden)

- **`GET /api/broker/loads/:token/bids` is read-only.** Actually accepting a bid on a broker's own posted load still goes exclusively through the existing, carefully transactional `POST /api/shipper/loads/:token/bids/:bidId/accept` — extending that transaction to also accept a broker-as-shipper caller was judged too risky to fold into this pass. A broker today opens bidding and views ranked offers, but the accept action itself isn't yet exposed to them.
- **"Why is my account pending" only maps to states this app actually tracks** (documents not submitted, under review, rejected + reason, admin requested a specific document). The spec's suggested list also included "physical verification pending" and "contract/signature pending" — this app has no such states today, so the fallback never claims them.
- **SMS is Twilio-shaped but untested against a live account** — there's no Twilio credential in this environment. The provider, queue, idempotency, and retry logic are unit-testable and mirror the already-working email path exactly, but a real end-to-end send was not (and could not be) verified here.
- No live MongoDB is available in this environment either, so every new route was verified by code review + `node -c` syntax checks + the full pure-function test suite, not by an end-to-end HTTP request against a running server.
