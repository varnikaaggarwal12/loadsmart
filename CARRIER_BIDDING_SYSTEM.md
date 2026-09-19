# Carrier Bidding System — Load Approval → Bidding → LoadSmart Margin → Shipper Selection

Delivered as `loadsmart-v11-carrier-bidding.zip`. This document is the full implementation record: architecture decision, files changed, DB changes, new API endpoints, new frontend pages, env vars, how to run, test coverage, and known limitations.

## 1. Architecture decision (made with you before any code was written)

Before touching any code, the existing admin-approval flow, the AI auto-match engine (`tryAutoAssignLoad`, `MATCHED`→`ASSIGNED`), `lib/matchingEngine.js`, `lib/trustScore.js`, the `User`/`Registration` model, and the notification/email infrastructure were re-inspected directly against the current source (not assumptions) to confirm nothing had drifted. That inspection confirmed there was **no existing bid concept anywhere** in the codebase (zero matches for "bid" outside `node_modules`).

The one genuinely pivotal, hard-to-reverse question — how the new open-bidding flow should relate to the existing single-carrier AI auto-match flow — was put to you directly. You chose **Additive per-load mode**: a new `assignmentMode` field (`'auto_match' | 'bidding'`) on each load. The entire existing `tryAutoAssignLoad` / `MATCHED` / `ASSIGNED` pipeline is **100% untouched** — not one line of its logic was changed — for `auto_match` loads. New loads default to `'bidding'` on the Post a Load screen (with an explicit toggle to fall back to the old instant AI auto-match), and that path converges into the exact same `ASSIGNED → DRIVER_ACCEPTED → … → COMPLETED` lifecycle Phase 1 already built, so nothing downstream of assignment needed to change either.

## 2. What already existed vs. what's genuinely new

Reused without modification: `BookingRequest` as the one Load/Trip entity, the full trip-lifecycle state machine from Phase 1, `lib/matchingEngine.js` (`scoreCandidate`, `checkTruckEligibility`) for AI Match %, `lib/trustScore.js`'s cached `driver.trustScore`, `lib/notificationService.js` / `lib/emailService.js` for every notification, `Truck`/`Driver`/`Registration` models, the atomic `findOneAndUpdate` truck-reservation idiom already used by `tryAutoAssignLoad`.

Newly built: the `Bid` collection, the `MarginConfiguration` collection (with audit history), a pure `lib/biddingEngine.js` (margin math + bid ranking — calls straight into `matchingEngine.scoreCandidate`, never re-implements it), the `BIDDING_OPEN` load stage, 13 new REST endpoints, 4 new frontend pages, and nav/toggle wiring on 2 existing pages.

## 3. Files changed

**New library files**
- `lib/biddingModels.js` — `Bid` model (with `BID_STATUSES`), `MarginConfiguration` model + `getMarginConfig()` helper.
- `lib/biddingEngine.js` — pure, DB-free: `calculateLoadSmartPricing()`, `priceScoreWithinSet()`, `rankBidsForShipper()` (calls `matchingEngine.scoreCandidate` directly, no duplicated scoring logic).

**Modified library files**
- `lib/loadStatusMachine.js` — added the `BIDDING_OPEN` stage (between `MATCHED` and `ASSIGNED`), its label, and its `TRACKING_STATUS_MAP` entry. `DRIVER_ACTION_TRANSITIONS` untouched.
- `lib/opsModels.js` — added 5 new `TrackingEvent` types: `BIDDING_OPEN`, `BID_SUBMITTED`, `BID_WITHDRAWN`, `CARRIER_SELECTED`, `BIDDING_CLOSED`.

**`server_load.js`** (additive only — every existing route/function this touches was extended, none rewritten)
- New `require('./lib/biddingModels')` / `require('./lib/biddingEngine')`.
- `bookingRequestSchema`: new fields `assignmentMode`, `biddingDeadline`, `biddingOpenedAt`, `biddingClosedAt`, `winningBidId`; new indexes on `loadStage` and `shipperUsername`.
- `POST /api/estimate/book` and `POST /api/estimate/rate-request`: accept `assignmentMode`/`biddingWindowHours` from the shipper's request body.
- `applyLoadApprovalDecision()` and the shipper's counter-rate-accept handler (`POST /api/my-bookings/:id/counter-response`): now branch on `assignmentMode` — `'bidding'` calls the new `openLoadForBidding()`, anything else calls the pre-existing `tryAutoAssignLoad()` exactly as before.
- New `openLoadForBidding()` function.
- `syncTrackingStatusFromLoadStage()`'s inline status map: added `BIDDING_OPEN`.
- 13 new routes (full list in §5) inserted as a new "Carrier Bidding System" section, plus 4 new page-serving routes (`/admin/bidding`, `/admin/margin-settings`, `/portal/carrier/bidding`, `/portal/shipper/bids`).

**New frontend pages**
- `views/admin/bidding.{html,css,js}` — admin sees every open/recently-decided bidding load, drills into full bid detail (carrier bid amount + margin + final price — the only role that sees all three), can close bidding.
- `views/admin/margin-settings.{html,css,js}` — configure the margin rule (FIXED/PERCENTAGE, min/max bounds) with full audit history.
- `views/portal/carrier-bidding.{html,css,js}` — carriers browse open loads, submit/withdraw bids, see their own bid history.
- `views/portal/shipper-bids.{html,css,js}` — shippers see a ranked offer list (final price + AI Match % + Trust Score only) and accept one.

**Modified frontend files**
- `views/admin/dashboard.html` — 2 new nav cards ("Bidding", "Margin Settings").
- `views/portal/details.html` / `.js` — 2 new role-conditional nav buttons ("🎯 Bids" for shippers, "💰 Bid on Loads" for carriers).
- `views/portal/estimate.html` / `.js` — a persistent "Open for Carrier Bidding (Recommended)" vs. "Instant AI Auto-Match" toggle, wired into all 3 load-creation call sites.

**New test file**
- `test/bidding.test.js` — 15 pure unit tests (margin math incl. min/max clamping, price normalization, bid ranking, and the security-critical assertion that a shipper-facing ranked offer never contains `bidAmount`/`marginAmount`/`marginType`/`marginValue`).

## 4. Database changes

New collections: `bids` (see `Bid` schema in `lib/biddingModels.js` — `id`, `loadId`, `carrierUsername`, `carrierCompanyName`, `truckId`, `vehicleNumber`, `driverId`, `bidAmount`, `notes`, `status` [`SUBMITTED|SHORTLISTED|ACCEPTED|REJECTED|WITHDRAWN|EXPIRED`], plus a pricing snapshot [`marginType`, `marginValue`, `marginAmount`, `finalShipperPrice`] populated only once accepted, timestamps); `marginconfigurations` (single document, `MarginConfiguration` — `marginType`, `marginValue`, `minMargin`, `maxMargin`, `updatedBy`, `updatedAt`, and an append-only `history[]` array).

New indexes: `Bid.loadId+status` (compound), `Bid.carrierUsername+status` (compound), plus single-field indexes already implied by `index:true` on `loadId`/`carrierUsername`/`status`/`createdAt`; `BookingRequest.loadStage`, `BookingRequest.shipperUsername` (adapted from the spec's `Load.status`/`Load.shipperId` to this app's actual field names).

New fields on the existing `BookingRequest` collection: `assignmentMode`, `biddingDeadline`, `biddingOpenedAt`, `biddingClosedAt`, `winningBidId`. No existing field was renamed, retyped, or removed. **No migration script is required** — Mongoose applies schema defaults to new documents automatically, and existing documents simply read as `assignmentMode: 'auto_match'` (the schema default) with the other new fields empty/null, which is exactly the correct, safe interpretation for every load that already existed before this feature shipped.

## 5. New API endpoints

Carrier: `GET /api/carrier/loads/available`, `POST /api/carrier/loads/:token/bids`, `GET /api/carrier/bids`, `DELETE /api/carrier/bids/:bidId`.
Shipper: `GET /api/shipper/loads/:token/bids` (ranked, price/margin-safe), `POST /api/shipper/loads/:token/bids/:bidId/accept` (the transactional accept flow).
Admin: `GET /api/admin/loads/:token/bids` (full detail — carrier amount + margin + final price), `POST /api/admin/loads/:token/close-bidding`, `GET /api/admin/bidding/loads` (queue list), `GET /api/admin/margin-config`, `POST /api/admin/margin-config`.

All 11 require the matching role session (carrier/shipper via the existing `userSessions` bearer-token map, admin via `requireAdmin`) — confirmed with live 401 smoke tests against every one of them (§7).

## 6. Security enforcement (backend is the sole pricing authority)

`carrierBidAmount` is never returned to the shipper — not in `GET /api/shipper/loads/:token/bids`, not anywhere. `marginAmount`/`marginType`/`marginValue` are never returned to the shipper or the carrier — only `GET /api/admin/loads/:token/bids` includes them. `finalShipperPrice` is always computed server-side by `calculateLoadSmartPricing()`; no route accepts a client-supplied price/margin and persists it. This is enforced by construction (those fields are simply never placed on the response object) and verified by a dedicated unit test (`rankBidsForShipper: NEVER leaks carrierBidAmount or margin fields...`) that asserts the forbidden keys are absent with `Object.prototype.hasOwnProperty`.

Every write route re-validates ownership/role/status server-side: a carrier can only bid with a truck from their own fleet (checked against `carrierUsername`) and only if `matchingEngine.checkTruckEligibility` passes; a carrier can only withdraw/see their own bids; a shipper can only view/accept bids on a load where `load.shipperUsername === shipper.username`; every mutating route re-checks `loadStage`/bid `status` server-side rather than trusting the frontend's last-known state.

**Double-accept prevention**: the accept-bid route wraps its writes in a Mongo multi-document session transaction (`mongoose.startSession()` + `withTransaction()`), and — as the actual concurrency guarantee, not just the transaction wrapper — atomically claims the load first (`findOneAndUpdate({tokenNo, loadStage:'BIDDING_OPEN'}, {loadStage:'ASSIGNED', ...})`), then atomically claims the winning bid, then atomically reserves the truck — the exact same race-safe idiom already trusted elsewhere in this codebase for truck reservation in `tryAutoAssignLoad`. If any step's conditional match fails (someone else already accepted, the bid was withdrawn, the truck was taken), the whole transaction aborts and a clear 409 is returned. **Requires MongoDB running as a replica set** (standard on MongoDB Atlas and any modern managed deployment) — a standalone `mongod` does not support multi-document transactions; the route detects that specific failure and returns an actionable error rather than a generic 500.

## 7. Testing performed

- `node -c` on every new/modified `.js` file (backend and frontend) — all clean.
- `node --test test/bidding.test.js test/tripLifecycle.test.js` — **26/26 passing**, including all pre-existing Phase 1 tests (confirms nothing broke) and 15 new tests covering: PERCENTAGE/FIXED margin math, min/max margin clamping, malformed-config safety defaults, invalid-bid-amount rejection, price normalization within a bid set (cheapest=100, priciest=0, single/equal bids=100), bid ranking (cheaper+better-matched ranks first), the security assertion that ranked offers never leak bid amounts or margins, a missing-trust-score fallback, and structural checks that `BIDDING_OPEN` sits correctly in the stage list with a label and tracking-status mapping.
- Live server boot against an intentionally unreachable MongoDB URI, then smoke-tested with `curl --max-time 5`: all 4 new pages serve 200; all 11 new/changed API routes correctly return 401 without a session and **without hanging** on the unreachable DB (confirming auth checks run before any DB access, matching the existing codebase's convention).
- Headless Playwright pass on all 4 new pages: zero `pageerror` events; the only console noise is the expected Google Fonts CDN block (this sandbox has no internet access to `fonts.googleapis.com` — every existing page in this app shows the same thing offline) and the expected redirect to the role's login page when unauthenticated (identical behavior to every other portal/admin page in this app).

## 8. How to run / try it

1. Point `MONGODB_URI` at a **replica-set** MongoDB (required for the transactional accept flow — MongoDB Atlas satisfies this automatically) and start the server as usual (`node server_load.js`).
2. As a shipper: Post a Load (`/portal/shipper/estimate`) — the "Open for Carrier Bidding" option is pre-selected. Submit and wait for (or trigger, as admin) approval.
3. As admin: approve the load from Rate Requests / the Fleet approval screens exactly as before — approving a `bidding`-mode load now opens it for bidding automatically (`BIDDING_OPEN`) instead of running the AI auto-match.
4. As a carrier: visit `/portal/carrier/bidding`, find the load under "Available Loads", pick one of your fleet's trucks, enter a bid amount, submit.
5. As admin: `/admin/margin-settings` to set/confirm the margin rule; `/admin/bidding` to see the incoming bid(s) with full pricing detail.
6. As the shipper: `/portal/shipper/bids` shows the ranked offer(s) — final price, AI Match %, Trust Score only — and an "Accept" button. Accepting locks in the price, rejects every other active bid, reserves the truck, and moves the load straight into the existing `ASSIGNED → driver accepts → …` flow you already have, with live tracking, POD, and everything else working unmodified.

No new environment variables are required — the feature reuses `MONGODB_URI` and every existing email/notification configuration.

## 9. Assumptions made & limitations (honestly, not glossed over)

- **`CARRIER_SELECTED` is an audit event, not a resting load stage.** Rather than adding a second transient `loadStage` value that every downstream screen (driver visibility filters, cancellable-stage lists, the trip-timeline ladder) would then need to explicitly exclude — the same extra bookkeeping `MATCHED` already required — a winning bid moves the load straight to `ASSIGNED` in one atomic step, with a `CARRIER_SELECTED` `TrackingEvent` fired for the timeline/audit trail. This was a deliberate simplification to minimize invasive changes to already-shipped, tested code; functionally the shipper still sees "Carrier Selected" in their activity log.
- **Bidding deadlines are not auto-enforced by a background job.** A load whose `biddingDeadline` has passed is flagged (`biddingExpired`) to carriers and blocks new bid submission, but the load itself stays `BIDDING_OPEN` until admin explicitly calls "Close Bidding" (or the shipper accepts an offer). A scheduled job to auto-close expired bidding rounds would be a natural Phase 2 addition, mirroring the existing 60-second auto-match retry loop's pattern.
- **Bid ranking does not re-validate truck/driver eligibility at view time**, only at bid-submission time. If a carrier's truck is later marked unverified or put into maintenance while a bid is still active, `scoreCandidate` will still score it (it doesn't itself assert eligibility) — a low but non-zero-risk gap; the truck-reservation step at accept-time (`Truck.findOneAndUpdate({status:'available'})`) is the actual hard backstop that prevents an unavailable truck from ever being assigned.
- **No broker role in this flow**, matching the confirmed, pre-existing state of the rest of the app (no `getBrokerSession`, no broker-specific matching/bidding participation anywhere).
- **The margin config is a single global rule**, not per-load or per-carrier-tier. Per-load margin overrides would be a straightforward follow-up (add an optional `marginOverride` on `BookingRequest`, checked first in `calculateLoadSmartPricing`'s caller) but weren't part of the given spec.
- Frontend pages were built to be functional and consistent with the existing visual language, not pixel-polished — same "runs before it shines" priority applied throughout.
