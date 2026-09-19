# GPS Live-Tracking System — Implementation Report

This document is the deliverable for the GPS/live-tracking upgrade made to the
existing Load Smart project (`server_load.js` monolith + `views/portal`,
`views/admin`, `lib/*`). Nothing was rewritten from scratch — every change
below extends code that already existed (the `TrackingPoint` collection,
`BookingRequest.lastGps`, the driver session store, the Socket.IO `load:update`
event, and the shipper's inline Leaflet map all pre-date this work).

---

## 1. Architecture summary — final data flow

```
Driver's phone/browser (driver-dashboard.js)
  -> logs in with phone/password -> authenticated driver session (bearer token,
     views/portal/driver-dashboard.js's driverFetch() attaches it)
  -> navigator.geolocation.watchPosition() (browser Geolocation API, permission-gated)
  -> client-side validation + time/distance throttle + bounded offline queue
  -> POST /api/driver/loads/:token/gps  (Authorization: Bearer <driver token>, NO phone
     number in the body — driver identity comes only from the session)
       -> getDriverSession(req)                              [auth]
       -> BookingRequest.findOne({ tokenNo, assignedDriverId: session.recordId })
                                                               [ownership — driver can only
                                                                post to their own assigned load]
       -> load.trackingSessionActive check                    [lifecycle gate]
       -> gpsValidation.validateGpsPoint()                    [server-side validation]
       -> gpsValidation.shouldAcceptPing()                    [time+distance throttle]
       -> BookingRequest.lastGps (current-location cache) + TrackingPoint (history) in MongoDB
       -> Truck.currentLat/currentLng updated
       -> emitLoadUpdate() (back-compat) + emitTrackingLocation() (new) via Socket.IO,
          room 'load:'+tokenNo
  -> Shipper's Live Tracking page / Admin's Tracking page (both joined that Socket.IO room)
       -> 'tracking:location' event -> LSLiveMap.updateCurrent() moves the existing
          Leaflet marker in place (no page/map reload)
       -> Leaflet + free OpenStreetMap tiles render the live position, with a
          bounded, on-demand GPS history polyline available via
          GET /api/orders/:token/tracking-history
```

No SIM/carrier/SS7/IMSI-based location technique is used anywhere in this
system. The only inputs are: (1) the browser's own Geolocation API on the
driver's device, explicitly permission-gated, and (2) the driver's
authenticated session. A phone number is stored only as a contact identifier
on the driver record — it is never used to derive or look up a location.

---

## 2. Files changed

### New files

| File | Purpose |
|---|---|
| `lib/gpsConfig.js` | Env-driven thresholds for the whole GPS system (interval, movement, accuracy, staleness, history limits, clock skew). Mirrors the existing `lib/matchConfig.js` pattern. |
| `lib/gpsValidation.js` | Pure, DB-free GPS logic: `validateGpsPoint()`, `haversineMeters()`, `shouldAcceptPing()` (time+distance throttle), `classifyStaleness()`. No Mongo/Express dependency, so it's fully unit-testable. |
| `test/gpsTracking.test.js` | 20 `node --test` unit tests for `lib/gpsValidation.js`. |
| `public/assets/live-map.js` | Shared Leaflet map module (`window.LSLiveMap`) used by both the shipper Live Tracking page and the Admin Tracking page — one implementation, incremental marker updates (`updateCurrent()`) instead of a full map rebuild per GPS ping, plus a bounded history-polyline renderer (`renderHistory()`). |
| `GPS_TRACKING_SYSTEM.md` | This document. |

### Modified files

| File | What changed | Why |
|---|---|---|
| `server_load.js` | See §3–§5 below in detail. Summary: extended `TrackingPoint` schema + indexes, extended `BookingRequest.lastGps` sub-schema, rewrote `POST /api/driver/loads/:token/gps` to validate/throttle/rate-limit/persist/broadcast, added `canAccessLoadTracking()` shared auth helper, added `attachLiveGpsSummary()` shared helper (used by both the shipper and admin order-detail routes), added `GET /api/loads/:token/tracking-status`, extended `GET /api/orders/:token/tracking-history` with `since`/`until`/`limit`, added `emitTrackingLocation()` Socket.IO emitter. | Core backend work — GPS validation, throttling, storage, authorization, real-time push. |
| `views/portal/driver-dashboard.js` | Replaced the placeholder GPS status block with a real `navigator.geolocation.watchPosition()` implementation: client-side plausibility check, time+distance throttle, a bounded offline queue that drains on reconnect, rich status states, and specific Geolocation error handling. Tracking now starts/stops off `trackingSessionActive` (server-authoritative) instead of `loadStage === 'IN_TRANSIT'`. | Requirement groups 1, 9, 10. |
| `views/portal/driver.css` | Added `.gps-dot.waiting/.offline/.error` and `.gps-substatus` styles for the new driver UI states. | Supports the above. |
| `views/portal/live-tracking.html` | Added `<script src="/assets/live-map.js">`. | Shipper page now uses the shared map module. |
| `views/portal/live-tracking.js` | Replaced the inline, full-rebuild-per-refresh Leaflet code with the shared `LSLiveMap` module; added a `tracking:location` Socket.IO handler that moves the marker in place; added a live-status badge and an on-demand, bounded route-history panel. | Requirement groups 6, 7. |
| `views/portal/live-tracking.css` | Added `.map-toolbar`, `.live-status-badge`, `.ls-btn-link`, `.history-status` styles. | Supports the above. |
| `views/admin/tracking.html` | Added Leaflet CSS/JS, `/assets/live-map.js`, and `socket.io.js` script tags (none of these were loaded on the admin tracking page before). | Admin previously had **no live map at all** — text fields only. |
| `views/admin/tracking.js` | Added a live-GPS map panel to `renderOrderDetail()` (reusing `LSLiveMap`), Socket.IO room join + `tracking:location`/`load:update` handlers, a live-status badge, and the same bounded route-history panel as the shipper page. | Requirement group 6 — "authorized dispatcher/admin ... views". |
| `views/admin/tracking.css` | Added the same map/badge/history styles as the shipper CSS (kept in each page's own stylesheet, matching this project's existing convention of not sharing CSS files between admin and portal). | Supports the above. |
| `.env.example` | Documented all 8 new `GPS_*` env vars with defaults and explanations. | Requirement: "use environment variables for configuration." |

### Files deliberately NOT changed

- `lib/opsModels.js` (`ops.TrackingEvent`) — this is the separate, pre-existing human-readable trip-timeline collection (checkpoints/status changes), distinct from raw GPS pings. Left untouched; the two systems are complementary, not merged.
- Email notifications, matching engine, trust score, invoices, POD workflow, portals — none of these were touched. Grepped for any caller of the one endpoint whose response shape changed (`GET /api/orders/:token/tracking-history`, bare array → object) and found none, so it's non-breaking.

---

## 3. Database changes

### `TrackingPoint` (raw GPS history — pre-existing collection, schema extended)

New fields added to the existing schema: `accuracy` (Number), `altitude`
(Number), `deviceTimestamp` (Date). `truckId` and `driverId` were given
`index: true`.

New indexes added:

```js
trackingPointSchema.index({ tokenNo: 1, createdAt: 1 });
trackingPointSchema.index({ truckId: 1, createdAt: -1 });
trackingPointSchema.index({ driverId: 1, createdAt: -1 });
```

Rationale: `{tokenNo, createdAt}` supports the bounded, chronological
`tracking-history` query (`since`/`until`/`limit`) efficiently; the
`truckId`/`driverId` + `createdAt` indexes support any future "this truck's"
or "this driver's" history query without a collection scan.

No TTL index was added — retention is a business decision, not something to
silently auto-delete. See §8 (Production notes) for how to add one safely if
the business wants it.

### `BookingRequest.lastGps` (current-location cache — pre-existing sub-schema, extended)

New fields: `accuracy` (Number), `altitude` (Number), `deviceTimestamp`
(Date), alongside the pre-existing `lat`, `lng`, `speedKph`, `headingDeg`,
`updatedAt`. This remains a single embedded sub-document (one "current
location" per load, overwritten on every accepted ping) — the design already
in place before this work; it wasn't converted to a separate collection
because the existing `TrackingPoint` collection already serves that role for
history.

No new top-level collections were introduced — `trackingSessionActive`,
`trackingStartedAt`, `trackingStoppedAt` on `BookingRequest` already existed
and are reused as the authoritative "is GPS tracking currently allowed for
this load" gate (see §5, lifecycle).

---

## 4. API documentation

All new/changed tracking endpoints below. Endpoints not listed here (e.g.
`POST /api/driver/loads/:token/checkpoint`, `GET /api/tracking/order/:token`
route registration, admin manual-update) were not changed in shape, only in
what they now additionally return (see `attachLiveGpsSummary` note under
`GET /api/tracking/order/:token`).

### `POST /api/driver/loads/:token/gps`

Submits one GPS reading for the calling driver's own active load.

- **Auth required:** driver session (`Authorization: Bearer <token>`, from `getDriverSession`).
- **URL param:** `:token` — the load's Token No.
- **Request body (JSON):**
  ```json
  {
    "lat": 12.9716, "lng": 77.5946,
    "accuracy": 12.5, "altitude": 920.3,
    "speedKph": 42, "headingDeg": 187,
    "deviceTimestamp": "2026-09-08T05:12:03.000Z"
  }
  ```
  `lat`/`lng` are required; everything else is optional. **No phone number,
  driver ID, or truck ID is accepted in the body** — all of that comes from
  the authenticated session and the load record it's scoped to.
- **Response 200 (stored):**
  ```json
  { "ok": true, "stored": true, "point": { "lat": 12.9716, "lng": 77.5946, "speedKph": 42, "headingDeg": 187, "accuracy": 12.5, "altitude": 920.3, "deviceTimestamp": "...", "updatedAt": "2026-09-08T05:12:04.112Z" } }
  ```
- **Response 202 (throttled, not an error):** `{ "ok": true, "stored": false, "reason": "too_soon" | "not_enough_movement" | "..." }` — the client should treat this as success and keep going; the point just wasn't different enough from the last accepted one to store.
- **Errors:**
  - `401` — no driver session (`{"error":"Please log in first."}`)
  - `404` — no load with that Token No. is assigned to the calling driver (`{"error":"No load found for that Token No. assigned to you."}`) — this is the ownership check: a driver cannot submit GPS for a load that isn't theirs.
  - `409` — the load exists and is theirs, but `trackingSessionActive` is false right now (`{"error":"Tracking is not active for this load right now."}`)
  - `400` — invalid GPS reading (out-of-range lat/lng, `(0,0)`, bad accuracy/speed/heading, clock-skewed device timestamp) — `{"error":"Invalid GPS reading: <reason>"}`
  - `429` — more than one request within `GPS_MIN_REQUEST_GAP_MS` (250ms default) for the same Token No. (`{"error":"Too many location updates — please slow down."}`)

### `GET /api/orders/:token/tracking-history`

Bounded, chronological GPS history for a load.

- **Auth required:** the owning shipper, the assigned carrier, an admin, or the assigned driver (`canAccessLoadTracking`).
- **Query params:** `since` (ISO timestamp, optional), `until` (ISO timestamp, optional), `limit` (optional, capped by `GPS_MAX_HISTORY_POINTS`, defaults to `GPS_DEFAULT_HISTORY_POINTS`).
- **Response 200:**
  ```json
  { "points": [{ "lat": ..., "lng": ..., "createdAt": "...", "speedKph": ..., "headingDeg": ..., "accuracy": ... }, ...], "totalCount": 842, "returned": 300, "truncated": true, "limit": 300 }
  ```
  (Previously returned a bare array — confirmed no existing frontend caller of this exact path, so this is non-breaking. The two frontend history viewers this project ships now read `data.points`.)
- **Errors:** `404` load not found; `403` not authorized.

### `GET /api/loads/:token/tracking-status`

Compact live-status summary (used for lightweight polling / status badges).

- **Auth required:** same as above (`canAccessLoadTracking`).
- **Response 200:**
  ```json
  { "tokenNo": "LS...", "loadStage": "IN_TRANSIT", "trackingSessionActive": true, "trackingStartedAt": "...", "trackingStoppedAt": null, "lastGps": { ... }, "status": "live" | "stale" | "no_data" | "not_active", "staleMs": 4231 }
  ```
- **Errors:** `404` load not found; `403` not authorized.

### `GET /api/loads/:token/tracking` (existing endpoint, unchanged shape, now authorized via the shared helper)

Human-readable `TrackingEvent` timeline (checkpoints/status changes — not raw
GPS). Now uses `canAccessLoadTracking()` instead of its own inline check, so
the assigned driver can see their own load's timeline too (previously only
shipper/carrier/admin could).

### `GET /api/tracking/order/:token` (shipper) and `GET /api/admin/tracking/order/:token` (admin)

Both unchanged in URL/auth/method. Both now additionally return, via the new
shared `attachLiveGpsSummary()` helper:

```json
{
  "...(all existing fields, unchanged)...": "...",
  "mapCoords": { "origin": {"lat":..,"lon":..}, "destination": {...}, "current": {...} },
  "hasLiveGps": true,
  "liveGps": {
    "lat": .., "lng": .., "speedKph": .., "headingDeg": .., "accuracy": .., "altitude": ..,
    "updatedAt": "...", "vehicleNumber": "DL01AB1234",
    "trackingSessionActive": true, "status": "live" | "stale" | "no_data" | "not_active",
    "staleMs": 4231
  }
}
```

This is purely additive — every field that existed before is still present,
unchanged.

---

## 5. Socket.IO documentation

One room per Token No. (`'load:' + tokenNo`), joined via
`socket.emit('join', { tokenNo })` — unchanged mechanism, now used by the
Admin Tracking page too (previously only the shipper page joined rooms).

### `load:update` (pre-existing event, unchanged payload shape)

Emitted on any load-record change (stage, POD, assignment, delay, checkpoint,
and — for back-compat — a `gps` key too). Payload: `{ tokenNo, ...whateverChanged }`.
Both the shipper and admin frontends now specifically ignore a payload whose
only extra key is `gps` (since `tracking:location` below already handles
that case), and do a full detail re-fetch for anything else.

### `tracking:location` (new event)

Emitted on every **accepted** (non-throttled) GPS point, same room.

```json
{
  "tokenNo": "LS4820193765",
  "lat": 12.9716, "lng": 77.5946,
  "speedKph": 42, "headingDeg": 187, "accuracy": 12.5, "altitude": 920.3,
  "deviceTimestamp": "...", "updatedAt": "2026-09-08T05:12:04.112Z",
  "vehicleNumber": "DL01AB1234"
}
```

Frontend handling (both shipper and admin pages): moves the existing Leaflet
marker in place via `LSLiveMap.updateCurrent()` — no map rebuild, no page
refresh, no re-fetch of the full order.

No GPS data is ever emitted outside a load's own room, and joining a room
requires knowing that load's Token No. (same trust model as the pre-existing
`load:update` event and the polling endpoints it complements — documented
in-code as an acceptable simplification for this project; a production
deployment should authenticate the socket handshake itself, e.g. by
validating the bearer token on `connection`, not just trusting whoever
supplies a Token No.).

---

## 6. Testing

### Quick answer: "how do I check the tracking part is actually working?"

Once you have this running against a **real MongoDB** (locally or wherever
you deploy it), the fastest real check is:

```bash
cd "LOAD SMART COMPANY"
npm start
# in another terminal:
node scripts/verify-gps-tracking.js --mobile <driver's mobile> --token <load Token No.>
```

That script (`scripts/verify-gps-tracking.js`, new in this update) logs in
as the driver over the real OTP flow, confirms the load is really assigned
to that driver and that tracking is active, sends a short series of
simulated-but-real GPS pings through the actual `POST /api/driver/loads/:token/gps`
endpoint, listens on the same Socket.IO room a shipper/admin browser would
join so you see each `tracking:location` push arrive in the terminal, and
finishes by re-reading `tracking-status`/`tracking-history` to prove the
points were actually stored — all without needing a phone or GPS hardware.
Full usage/flags are documented in the comment block at the top of that
file (run it once with no `--otp` to see how the OTP step works, since it's
a real two-step login). The one thing it can't do for you is create the
test driver/load in the first place — that still goes through the app's
normal onboarding and assignment flow (or Admin's manual assignment) once,
same as any real driver.

For the actual visual proof — the truck marker moving on the map — open the
shipper's Live Tracking page or the Admin Tracking page for that same Token
No. in a browser while the script (or a real phone) is sending pings.

### Running the existing + new automated suite

```bash
cd "LOAD SMART COMPANY"
npm test
# equivalent to: node --test
```

This runs `test/*.test.js` — 69 tests total (49 pre-existing across
`matchingEngine.test.js`/`trustScore.test.js`/`emailNotificationSystem.test.js`,
plus 20 new in `test/gpsTracking.test.js`), all passing, 0 failures.

To run just the new GPS tests:

```bash
node --test test/gpsTracking.test.js
```

Coverage in `test/gpsTracking.test.js`:
- `validateGpsPoint()` — rejects non-finite/out-of-range lat/lng, rejects exact `(0,0)`, rejects negative/absurd accuracy, rejects out-of-range speed/heading, rejects a device timestamp too far from "now" (clock skew), accepts a well-formed point with and without optional fields.
- `haversineMeters()` — known-distance checks (e.g. ~0m for identical points, correct order-of-magnitude for a real city-pair distance).
- `shouldAcceptPing()` — always accepts the first point; rejects an out-of-order (older) timestamp; rejects a point that's neither far enough in time nor distance from the last accepted one; accepts once either threshold is crossed.
- `classifyStaleness()` — `no_data` for a null timestamp, `live` within the staleness window, `stale` beyond it.

### What is NOT covered by automated tests, and why

This sandbox has no reachable MongoDB (confirmed by attempting to spin up
`mongodb-memory-server` — its binary download is blocked by network egress
rules here) and no Socket.IO client library installed by default, so
**route-level tests (authorization failures, driver-to-load ownership at the
HTTP layer, and live Socket.IO event delivery) cannot be executed
end-to-end in this environment.** What was verified instead:

1. **Code-level verification of ownership/authorization** (by inspection,
   cross-checked against the actual route code quoted in §4): the GPS
   submission route's ownership check is enforced by the Mongo query itself
   — `BookingRequest.findOne({ tokenNo, assignedDriverId: session.recordId })`
   — so a driver session simply cannot retrieve, let alone update, a load
   that isn't assigned to them; there is no code path where a supplied
   phone number, tokenNo alone, or truck ID substitutes for that check.
   `canAccessLoadTracking()` is the single shared gate for every
   tracking-read endpoint (history, status, timeline), reused across the
   shipper, admin, and driver access paths, so there's exactly one place to
   audit "who can see this load's location."
2. **A live boot + curl smoke test** (this session): started the server
   with SMTP env vars stripped (no real emails sent) and an intentionally
   unreachable `MONGODB_URI`, confirming: the server boots cleanly with no
   startup errors; `POST /api/driver/loads/:token/gps` with no
   `Authorization` header correctly returns `401` before ever touching the
   database (auth check precedes the DB query in this specific route); all
   new static assets (`live-map.js`, Leaflet CSS/JS) and all three touched
   HTML pages (`/portal/shipper/live-tracking`, `/admin/tracking`,
   `/portal/driver`) serve `200`.
3. **A headless-browser console-error pass** (Playwright/Chromium) on the
   shipper Live Tracking and Admin Tracking pages: no uncaught JS exceptions
   (`pageerror`) and no `liveStatusBadge is not defined`-type reference
   errors from the refactor — the only console noise was expected
   resource-load aborts from the unauthenticated-session redirect and a
   blocked external font request, neither related to this feature.
4. `node -c` syntax verification on every modified/created `.js` file
   (`server_load.js`, both `driver-dashboard.js`, both `live-tracking.js`,
   `tracking.js`, `live-map.js`, `gpsConfig.js`, `gpsValidation.js`) — all
   pass.

**§7's manual testing checklist is the required way to verify the full,
real, end-to-end flow** (a live MongoDB, a real browser with GPS permission,
two simultaneous sessions) — it cannot be replaced by anything run inside
this sandbox.

---

## 7. Manual testing checklist

1. Driver logs in (phone/password) on `/portal/driver` and lands on the driver dashboard.
2. Driver receives and accepts an assigned load (existing assignment flow — unchanged).
3. Driver starts the trip (existing `start_trip` action) — this sets `trackingSessionActive = true` server-side.
4. Driver's browser prompts for GPS permission; driver grants it.
5. A GPS update reaches MongoDB — confirm via `BookingRequest.lastGps` and a new `TrackingPoint` document for that `tokenNo`.
6. The load's "current location" updates — confirm on the driver dashboard's GPS status block (dot goes green/"Live") and via `GET /api/loads/:token/tracking-status`.
7. GPS history is stored — open the shipper's or admin's "Show route history" panel after a few pings and confirm a polyline with more than one point appears.
8. An authorized dispatcher/admin/shipper watching the Live Tracking / Admin Tracking page sees the truck marker move live, without the page or map reloading (watch for the marker sliding, not the whole map flashing).
9. An unauthorized user (e.g. a different shipper, or a broker with no assignment on this load) is denied — `GET /api/tracking/order/:token` for a load they don't own returns 404 (scoped query), and `GET /api/orders/:token/tracking-history` / `tracking-status` for a load they have no relation to returns `403`.
10. Disconnect the driver device's internet mid-trip, let a few position updates queue locally (bounded queue, oldest points visible in the console log if inspected), then reconnect — confirm the queued points are sent in chronological order and appear in history without gaps or duplicates.
11. Driver marks the load delivered/completed (existing `deliver`/`complete` action) — confirm `trackingSessionActive` becomes `false`, the driver dashboard calls `stopGpsWatch()` (no more `watchPosition` callbacks firing — check the browser's location indicator turns off), and a further `POST /api/driver/loads/:token/gps` for that load now returns `409`.

---

## 8. Production notes

- **HTTPS is required.** `navigator.geolocation` is only available in a
  [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
  in production (HTTPS or `localhost`). The driver dashboard already checks
  `window.isSecureContext` and shows a clear error instead of silently
  failing if served over plain HTTP in production.
- **Browser background-tracking limitations are real and were not
  papered over.** A mobile browser tab that is backgrounded or the phone
  screen-locked will throttle or fully suspend `watchPosition()` callbacks —
  this is OS/browser policy, not something any web app can override. The
  driver dashboard surfaces a Page Visibility warning when the tab goes
  background, and nothing in this system claims guaranteed tracking after
  the browser is closed. If the business needs guaranteed background
  tracking (screen off, app closed), that requires a native app with a
  foreground service / background location permission (Android) or a
  background location capability (iOS) — a genuinely different platform,
  not a web-app configuration change. The current web implementation is the
  correct, honest baseline; a native app would reuse the same
  `POST /api/driver/loads/:token/gps` endpoint and the same auth/session
  model, just with a different location-collection mechanism client-side.
- **MongoDB index requirements:** the three new `TrackingPoint` indexes
  (§3) should exist before this goes live with real traffic — Mongoose
  creates them automatically on first connect in a dev/staging environment,
  but for a sharded/replica-set production cluster, verify with
  `db.trackingpoints.getIndexes()` and build them explicitly during a
  maintenance window if the collection is already large.
- **Location-data retention and privacy:** raw GPS history
  (`TrackingPoint`) currently has no expiry — every accepted point is kept
  indefinitely. This was a deliberate choice (never auto-delete without an
  explicit decision), but it means retention is now a business/legal
  decision that should be made explicitly, not left as "whatever Mongo
  happens to do." If/when a retention policy is decided, it's a one-line
  addition: `trackingPointSchema.index({ createdAt: 1 }, { expireAfterSeconds: <N> })`.
  Also worth deciding: does a driver's location get deleted (or
  anonymized) when they leave the company, per applicable data-protection
  law in the jurisdictions this operates in.
- **OpenStreetMap tile usage:** both the shipper and admin maps pull tiles
  from the public `{s}.tile.openstreetmap.org` endpoint (unchanged — this
  predates this work). OSM's [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  asks for a maximum of ~2 requests/second per app and discourages heavy
  production traffic against the free public server. At real fleet scale,
  budget for either a paid tile provider (e.g. MapTiler, Mapbox, Stadia —
  all Leaflet-compatible, so no frontend rewrite needed) or self-hosting
  tiles.
- **Scaling considerations for many simultaneously tracked trucks:**
  today, throttling state (`lastAcceptedGpsByToken`, `lastGpsRequestAtByToken`)
  lives in a plain in-process `Map`, and Socket.IO runs on a single
  in-memory `io` instance — both fine for one server process, but neither
  survives a multi-instance/horizontally-scaled deployment as-is. Scaling
  beyond one Node process would need: (1) a shared store for the throttle
  state (Redis, with a short TTL per tokenNo) so two app instances don't
  both accept a ping the other just throttled, and (2) the
  [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/) so a
  `tracking:location` emitted by the instance that received the HTTP POST
  still reaches a browser connected to a different instance. Neither is
  needed at the traffic level this project currently operates at, but both
  are documented here so they're not a surprise later.
