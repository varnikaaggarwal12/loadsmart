# Broker Portal, KYC, and Real AI Features — Complete Implementation Record

This document is the full implementation record for the Broker module: architecture decisions, files created/modified, database changes, new API endpoints, registration/KYC flow, admin review flow, AI features, security controls, test results, run commands, required `.env` variables, and migration notes.

## 1. Architecture decisions

Before writing any code, the existing codebase was inspected directly: the monolithic `server_load.js`, the shared `Registration` collection (`strict:false`, one collection for every role), the token-in-`sessionStorage` auth pattern (`/assets/auth.js`), the existing Carrier Bidding System (`lib/biddingModels.js`, `lib/biddingEngine.js`, `lib/matchingEngine.js`), the KYC document upload pipeline (`/api/kyc/upload`, disk + Mongo durable backup), the notification system (`lib/notificationService.js`), the email system (`lib/emailService.js` → `lib/emailQueue.js` → `lib/emailProvider.js`), and the existing real Anthropic Claude integration (`lib/aiService.js`).

Two decisions were made explicitly rather than left implicit:

**Broker bids reuse the exact same `Bid` model and bidding engine carriers use — no second bidding system.** A broker doesn't own trucks, so "submit a bid" for a broker means: pick any currently verified + available truck platform-wide (via the same `matchingEngine.checkTruckEligibility` eligibility check carriers use), and submit a `Bid` document against it. This only required three small additive fields on `Bid` (`submittedByRole`, `brokerUsername`, `brokerCompanyName`) — the pricing engine, margin math, transactional accept flow, and the strict "carrier bid amount is never shown to the shipper" privacy rule are all completely unmodified and apply identically to broker-submitted bids.

**PAN is the one mandatory identity document, since GST and MSME are each independently optional.** The spec requires that registration succeed with `hasGST=false` and `hasMSME=false`. Leaving a broker account with zero verifiable identity documents in that case would be a real gap, so — mirroring the Shipper role's existing "PAN is the sole mandatory identity document" pattern — PAN (number + document) is always required, regardless of GST/MSME state. GST and MSME remain validated *only* when their own `hasGST`/`hasMSME` flag is true.

A third, smaller decision: the new granular `kycStatus` (`DRAFT/SUBMITTED/PENDING_REVIEW/APPROVED/REJECTED`) is kept bidirectionally in sync with the pre-existing generic `status` (`pending/accepted/rejected`) field every other admin screen already reads, via `kycStatusToAccountStatus()` / `accountStatusToKycStatus()` in `lib/brokerService.js`. Either the new broker-specific admin endpoint or the old generic one can be used on a broker record without the two ever disagreeing.

## 2. Files created

**Library (pure, DB-free — same contract as `lib/biddingEngine.js`/`lib/trustScore.js`):**
- `lib/brokerService.js` — GST/PAN/MSME/pincode validators, `validateBrokerRegistration()` (conditional GST/MSME rules), `missingKycDocuments()`, KYC-status ↔ legacy-status mapping, `computeRiskIndicators()` (neutral-language Risk Indicators), `scoreOpportunities()` (Opportunity Radar), `buildActivityTimeline()`.
- `lib/brokerAiTools.js` — the 8 safe, read-only AI tool definitions + `createBrokerToolExecutor()` (broker identity injected server-side, never client-supplied) + `runBrokerAssistant()` (built on the existing `aiService.completeWithTools()`).
- `lib/brokerDocReview.js` — advisory-only AI Document Review (`reviewBrokerDocument()`) built on the existing `aiService.completeVision()`.

**Frontend — registration:**
- `public/register/broker.html`, `public/register/broker.js` — full registration form (Individual/Company type selector, GST Yes/No conditional section, MSME Yes/No conditional section, PAN + address proof + profile photo, bank details, email-OTP verification, pincode autofill).
- `public/assets/register.css` — appended new classes for the Yes/No toggle, type-card selector, and conditional-section pattern (existing rules untouched).

**Frontend — Broker Dashboard:**
- `views/portal/broker-dashboard.html`, `views/portal/broker-dashboard.css`, `views/portal/broker-dashboard.js` — the full dashboard (see §7).

**Tests:**
- `test/brokerService.test.js` — 15 tests covering GST/MSME/PAN/pincode validators, conditional registration validation (both flags true/false in every combination), KYC-completeness checks, risk indicators, opportunity scoring, activity timeline, and status mapping.
- `test/brokerAiTools.test.js` — 7 tests covering the tool schema (no tool accepts a `brokerId`), that every tool call is scoped to the server-injected broker (never a client/model-supplied id), cross-broker data isolation on `get_load_summary`/`get_bid_comparison`, unknown-tool and malformed-input handling, and AI fail-soft behavior.
- `test/brokerDocReview.test.js` — 8 tests covering PDF-skip behavior, not-configured fail-soft, clean/fenced JSON parsing, unparseable-output fail-soft, thrown-error fail-soft, and value clamping.

**Documentation:**
- `BROKER_PORTAL_SYSTEM.md` (this file).

## 3. Files modified

- **`server_load.js`** — extended `registrationSchema` with ~15 new broker fields/subdocuments and 5 new indexes; added `'withdrawn'` to the `BookingRequest.status` enum; added `getBrokerSession()`; modified the bid-accept transactional handler to stamp `brokerUsername`/`brokerCompanyName` and send broker-specific win/loss notifications; extended `/api/kyc/upload`'s type lists (`profilePhoto`, `panDocument`, `addressProof`) and `SELF_VIEWABLE_DOC_FIELDS`; fully rewrote `POST /register/broker`; added a ~20-route "Broker Portal" section (broker-facing APIs) and an "Admin: Broker management" section (5 admin routes); added the `GET /broker-dashboard` page route.
- **`lib/biddingModels.js`** — added `submittedByRole` (enum `carrier`/`broker`), `brokerUsername`, `brokerCompanyName` to the `Bid` schema (fully additive; `carrierUsername` stays required for both roles since a broker bid still rides on a real carrier's truck).
- **`lib/emailService.js`** — added `sendBrokerKycStatusEmail()` and `sendBrokerDocumentsRequestedEmail()`, following the project's existing per-event-function convention.
- **`public/assets/auth.js`** — `/broker-dashboard` is outside the generic `/portal/:role` tree, so it needed two small, additive fixes: `isUserPage()` and `roleFromPath()` now also recognize `/broker-dashboard` (so the session guard and the auto-attached bearer token work there), and `LS.Auth.loginUser()` now sends a broker to `/broker-dashboard` instead of the generic `/portal/broker` account page after login.
- **`views/admin/list.html`** — added a "Request additional documents" modal (broker-only; every other role's markup is untouched).
- **`views/admin/list.js`** — added a full Broker card/detail view (`renderBrokerView`/`renderBrokerDetail`), mirroring the existing Shipper card/detail pattern exactly, but reading from the richer `/api/admin/brokers` endpoints. Purely additive — the Shipper and Carrier/generic-table code paths are untouched.

## 4. Database (Mongoose) changes

All changes are additive to the existing shared `Registration` collection (`strict:false`) — no existing field was renamed, retyped, or removed, so no destructive migration is needed.

New fields on `Registration` (used only when `role: 'broker'`; every other role's documents simply never set them):
`mobileNumber`, `gstNumber`, `gstVerified`, `gstPhotoPath`, `hasGST`, `hasMSME`, `msmeNumber`, `msmePhotoPath`, `brokerType`, `companyName` (shared with other roles), `address {addressLine, city, state, pincode}`, `panNumber`, `panVerified`, `panDocumentPath`, `addressProofPath`, `profilePhotoPath`, `loadPreferences {preferredOrigins[], preferredDestinations[], preferredTruckTypes[], preferredLoadCategories[]}`, `kycStatus` (enum `DRAFT|SUBMITTED|PENDING_REVIEW|APPROVED|REJECTED`, default `DRAFT`), `kycRejectionReason`, `kycDocumentsRequested`, `kycSubmittedAt`, `kycReviewedAt`, `aiDocumentReviews[] {documentType, looksReadable, looksLikeExpectedDocument, confidence, concerns[], summary, reviewedAt}`, `aiKycReview {status, confidence, summary, concerns[], reviewedAt}`.

New indexes: `role` (shared), `mobileNumber`, `kycStatus`, `gstNumber` (sparse), `msmeNumber` (sparse) — plus the pre-existing `email` unique-sparse index continues to enforce no-duplicate-email across every role including Broker, and `username` uniqueness is enforced the same way every other role already uses.

`Bid` collection (`lib/biddingModels.js`) — additive fields: `submittedByRole` (enum `carrier|broker`, default `carrier`), `brokerUsername` (indexed), `brokerCompanyName`. `carrierUsername` remains required for both roles.

**Migration:** none required. Every existing (pre-broker-module) `Registration` document simply reads back with `kycStatus: 'DRAFT'` (the schema default) and empty/false values for every other new field — which is the correct, safe interpretation. If you want existing broker records (registered before this module shipped) to reflect their real KYC state immediately rather than waiting for their next status change, run a one-time backfill that sets `kycStatus` from each record's existing generic `status` field, e.g.:

```js
// One-time, optional backfill — safe to skip; every broker record will
// self-correct the next time an admin touches its KYC status anyway.
db.registrations.updateMany(
  { role: 'broker', status: 'accepted' },
  { $set: { kycStatus: 'APPROVED' } }
);
db.registrations.updateMany(
  { role: 'broker', status: 'rejected' },
  { $set: { kycStatus: 'REJECTED' } }
);
```

## 5. New API endpoints

**Broker-facing (session-scoped to the authenticated broker via `getBrokerSession()` — ownership is enforced server-side on every route, never trusting a client-supplied id):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/broker/profile` | Own profile |
| PATCH | `/api/broker/profile` | Edit contact/address/company/`loadPreferences` |
| GET | `/api/broker/kyc` | KYC status, missing docs, AI review results |
| POST | `/api/broker/documents` | Attach an uploaded document (gst/msme/pan/address/bank/profile) |
| POST | `/api/broker/kyc/submit` | Submit KYC for admin review |
| GET | `/api/broker/documents/:id` | Resolve a document's protected view path |
| GET | `/api/broker/dashboard` | Cards, Opportunity Radar, Risk Indicators, Activity Timeline |
| GET | `/api/broker/loads` | Browse open loads (origin/destination/truckType/weight/date filters) |
| GET | `/api/broker/loads/:token` | Load detail + eligible carrier/truck options |
| GET | `/api/broker/bids` | Own bids (status filter) |
| POST | `/api/broker/bids` | Submit a bid (requires `kycStatus: APPROVED`) |
| PATCH | `/api/broker/bids/:id/withdraw` | Withdraw an active bid |
| GET | `/api/broker/shipments` | Loads attached to this broker |
| GET | `/api/broker/notifications` | In-app notifications |
| POST | `/api/broker/ai/chat` | AI Broker Operations Assistant |
| POST | `/api/broker/ai/document-review` | Re-run advisory AI review on a document |

**Admin-facing (`requireAdmin`):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/brokers` | List/search/filter brokers |
| GET | `/api/admin/brokers/:id` | Full broker detail + dashboard (incl. timeline) |
| PATCH | `/api/admin/brokers/:id/kyc-status` | Approve / Reject (reason required) / Pending review |
| POST | `/api/admin/brokers/:id/request-documents` | Request additional documents |
| GET | `/api/admin/brokers/:id/documents/:documentId` | Resolve a broker's document view path |

**Pages:** `GET /register/broker`, `POST /register/broker`, `GET /broker-dashboard`, `GET /login/broker` (pre-existing generic route, already covered brokers).

## 6. Broker registration flow

1. Broker selects **Individual** or **Company/Agency** (company name required only for Company/Agency).
2. Fills in contact details, business address (with pincode autofill), and completes email OTP verification.
3. **GST section** — a Yes/No toggle with the exact copy *"GST is optional. Select Yes only if you have a GST registration."* Selecting **No** hides and un-requires the GST number/document fields entirely; selecting **Yes** requires a valid GSTIN (format + ISO-7064 mod-36 checksum) and the certificate upload.
4. **MSME section** — the same independently-optional pattern, labeled *"Do you have MSME/Udyam registration?"*
5. **Identity & KYC** — PAN number + PAN card upload are always mandatory (the one identity document that's never optional); address proof and profile photo are optional.
6. **Bank details & bank KYC** — unchanged, mandatory (existing pattern reused as-is).
7. On submit, the server re-validates every rule server-side via `brokerService.validateBrokerRegistration()` (client-side mirrors are a convenience, never the source of truth), rejects duplicate email/username, and — only once every mandatory document is on file — creates the account with `kycStatus: 'SUBMITTED'`. The GST/MSME/PAN documents are queued for advisory AI review in the background (never blocking the response).

**Conditional validation behavior, explicitly:** `hasGST=false` + `hasMSME=false` → registration succeeds with no GST/MSME fields at all. `hasGST=true` → `gstNumber` and a GST document become mandatory; an invalid GSTIN or a missing document is rejected with a field-specific error code (`invalid_gst` / `gst_document_required`). The same independently applies to MSME (`invalid_msme` / `msme_document_required`). GST and MSME can be any combination of true/false, all four combinations tested.

## 7. Broker Dashboard (`/broker-dashboard`)

A tabbed, single-page dashboard showing **only real API data** — every card shows `0` or an explicit "No data yet" note rather than any invented number (e.g. brokerage/commission tracking, which isn't part of the existing pricing engine, is shown as an honest "not available yet" rather than a fabricated figure).

- **Overview** — stat cards (total loads handled, active, pending requests, accepted, completed, brokerage/commission, KYC status, reliability score), the **Broker Opportunity Radar** (real open loads scored against the broker's own preferred routes/truck types/categories, with a plain-language explanation per load — never an invented opportunity), **Risk Indicators** (neutral copy — "Needs review", "Missing document", "Verification pending" — never an accusation), and the **Activity Timeline** (registration → KYC → bids → notifications, chronological).
- **Load Board** — filterable list of open loads; a detail view shows eligible carrier/truck options (via the same `matchingEngine.checkTruckEligibility` carriers use) and lets the broker submit a bid once KYC is approved.
- **My Bids** — status-filterable list with withdraw support for active bids.
- **Shipments** — loads the broker is attached to, with tracking/delay status.
- **KYC & Documents** — status, missing-document checklist, per-document upload with inline AI advisory review results, and a "Submit KYC for review" action.
- **AI Assistant** — a chat widget backed by `POST /api/broker/ai/chat`, with suggested-question chips.
- **Profile** — editable contact/address fields and Opportunity Radar preferences.

The page uses a purely decorative **"Logistics Market Network"** animated canvas background (connected shipper/broker/carrier nodes, moving route/bid-signal particles, pulsing load nodes) — `pointer-events:none`, entirely original (no copied assets/designs), and skipped outright when `prefers-reduced-motion: reduce` is set.

## 8. Admin review flow

The Admin panel's existing role-list page (`/admin/broker`) now renders a Broker-specific card grid (mirroring the existing Shipper card/detail pattern) instead of the old generic table. Opening a broker shows: contact/address/GST/MSME detail, PAN + address proof + profile photo + bank proof documents (each with its AI advisory review inline where available), bank details, and the full activity timeline.

From there, an admin can: **Approve** KYC, **Reject** KYC (a reason is mandatory and shown to the broker), set **Pending Review**, or **Request additional documents** (free-text message). Every KYC status change: saves the new status, logs an `ActivityLog` entry, creates an in-app notification, sends an email if SMTP/Resend/SendGrid is configured, and — critically — **skips re-notifying on a no-op** (setting the same status/message twice) so duplicate notifications are never sent. Visibility can be toggled the same way every other role's account can (`Active`/`Inactive`).

## 9. AI features implemented

**AI Broker Operations Assistant** (`lib/brokerAiTools.js` + `POST /api/broker/ai/chat`) — a real, tool-calling assistant built on the existing `aiService.completeWithTools()` (the same machinery already used elsewhere in this app; no second AI plumbing). 8 read-only tools (`get_my_broker_profile`, `get_my_kyc_status`, `get_my_available_loads`, `get_my_bids`, `get_my_active_shipments`, `get_my_notifications`, `get_load_summary`, `get_bid_comparison`), each bound to the server-authenticated broker record at executor-creation time — no tool accepts a broker-id input, so the model can never widen its own query to another broker's data. The assistant is strictly read-only: it can explain and recommend, but can never approve KYC, accept a bid, change a price, assign a driver, or change a shipment's status — those require the real, authorized API + the broker's own confirmation in the UI. It never invents load numbers, prices, carrier names, or statuses — an unavailable answer is always "I could not find that information," never a guess. Fails soft with a clear 503 (`AiNotConfiguredError`) when `ANTHROPIC_API_KEY` isn't set, and is rate-limited (10 requests/minute/broker, in-memory).

**AI Document Review** (`lib/brokerDocReview.js` + `POST /api/broker/ai/document-review`, also triggered automatically on every GST/MSME/PAN upload) — advisory only, built on the existing `aiService.completeVision()` (the same vision integration already used for POD checks). Returns `{documentType, looksReadable, looksLikeExpectedDocument, confidence, concerns[], summary, reviewedAt}`. PDFs are explicitly skipped (vision only accepts images) with a clear "waiting for manual review" note rather than a fake result. This is explicitly **not** official government verification and can **never** auto-approve or auto-reject KYC — only a human admin changes `kycStatus`.

## 10. Security controls

- Server-side re-validation of every registration/KYC rule (client-side checks are a UX convenience only).
- File uploads validated by decoded MIME signature (`data:image/...` / `data:application/pdf...` prefix, not filename/extension), size-capped at 8MB, stored outside the public web root, durably backed up in MongoDB, and served only through authorization-gated routes (`/api/my-documents/:filename` for the owning broker, `/admin/kyc-photo/:filename` for admin) — never a public URL.
- Ownership checks on every `/api/broker/*` route via `getBrokerSession()` — a broker's token can only ever resolve to their own `Registration` record; every query is scoped to `session.recordId`/`broker.username`.
- Duplicate-email and duplicate-username prevention (existing app-wide pattern, reused unchanged).
- GST (format + mod-36 checksum) / PAN (format) / MSME (presence+length) / pincode (6-digit) format validation.
- AI endpoints: in-memory rate limiting (10/min/broker) and full fail-soft behavior (a misconfigured or unreachable AI provider degrades to a clear error message, never a crash or a hang).
- AI tools are read-only by construction — no tool in `lib/brokerAiTools.js` can write anything; every "action" the assistant might suggest routes the broker back to the real, authenticated UI/API.
- No password, token, or raw document content is ever logged or echoed back by any broker/admin endpoint (`brokerRecordSafe()` strips `password`/`confirmPassword` from every response).
- Cross-broker data isolation is enforced both at the route level (every query includes the authenticated broker's own id/username) and inside the AI tool executor (verified directly in `test/brokerAiTools.test.js`).

## 11. Test results

```
$ npm install && npm test
...
# tests 139
# pass 139
# fail 0
```

139 tests pass across the full suite (existing Shipper/Carrier/Driver/Admin/bidding/matching/trust-score/GPS-tracking/email-notification tests, all unchanged and all still green) plus the 30 new broker tests:

- `test/brokerService.test.js` — 15/15 passing (conditional GST/MSME validation in every true/false combination, invalid GST/MSME/pincode rejection, KYC-completeness checks, neutral-language risk indicators, opportunity scoring, activity timeline, status mapping).
- `test/brokerAiTools.test.js` — 7/7 passing (tool schema has no broker-id input, every tool call scoped server-side to the injected broker, cross-broker data isolation on load/bid lookups, unknown-tool/malformed-input handling, AI fail-soft).
- `test/brokerDocReview.test.js` — 8/8 passing (PDF skip, not-configured fail-soft, clean/fenced JSON parsing, unparseable-output fail-soft, thrown-error fail-soft, value clamping).

`node -c server_load.js` and every touched/created `lib/*.js` file all pass a syntax check, and `node server_load.js` boots cleanly (verified: MongoDB-dependent routes aside, the process starts and listens without throwing).

Manually verified via code review (not executable without a live MongoDB in this environment): registration/login/role-authorization wiring, admin KYC review + notification/no-duplicate-notification logic, dashboard API shape, and the bid-submission flow's reuse of the existing eligibility/pricing engine.

## 12. How to run

```
npm install
npm test              # full suite, including the 30 new broker tests
npm start              # starts server_load.js on the port in .env (default shown by the server on boot)
```

## 13. Required `.env` variables

No new variables were introduced beyond what the existing AI/email infrastructure already documents in `.env.example`:

- `ANTHROPIC_API_KEY` — enables the AI Broker Assistant and AI Document Review. Without it, both fail soft (503 for chat; an honest "not configured" advisory note for document review) — the rest of the Broker module works fully without it.
- `CHAT_AI_PROVIDER`, `ANTHROPIC_MODEL` — existing AI configuration, reused as-is.
- `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` (or the Resend/SendGrid equivalents already documented) — enables `sendBrokerKycStatusEmail`/`sendBrokerDocumentsRequestedEmail`. Without them, the in-app notification still fires; only the email is skipped (logged as "not configured," matching every other email in this app).
- `MONGODB_URI` — unchanged, already required by the whole app.

## 14. Migration notes

No destructive migration is required — see §4. The optional one-time backfill script for pre-existing broker records is included there.
