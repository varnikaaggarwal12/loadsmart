#!/usr/bin/env node
/**
 * scripts/verify-gps-tracking.js
 *
 * A ready-to-run end-to-end check for the GPS live-tracking system, driven
 * entirely over HTTP against a REAL running server + REAL MongoDB (this
 * cannot be run in a sandbox with no reachable database — see
 * GPS_TRACKING_SYSTEM.md §6 for why). It does everything a phone walking
 * around would do, without needing a phone: logs in as the driver (OTP
 * flow, same as the real app), confirms the load is actually assigned to
 * that driver and tracking is active, sends a short series of simulated
 * GPS points along a small moving path, and — if socket.io-client is
 * installed — listens on the same Socket.IO room a shipper/admin browser
 * would join, so you can see the 'tracking:location' push arrive in real
 * time in this terminal, independent of opening any browser at all.
 *
 * WHAT YOU NEED FIRST (this script does not create any of these):
 *   1. The server running against a real MongoDB (`npm start`).
 *   2. A verified, non-blocked Driver account (Admin > Drivers has an
 *      "onboard/verify" step in the existing app — do that once via the UI).
 *   3. A load (BookingRequest) assigned to that driver, with the trip
 *      started (the driver's existing "Start Trip" action, or the
 *      equivalent Admin action) — i.e. trackingSessionActive: true. This
 *      script checks that for you and tells you plainly if it's not true
 *      yet, rather than sending pings that will just get rejected with 409.
 *
 * USAGE (two steps, because OTP is a real two-step flow — same as the app):
 *
 *   node scripts/verify-gps-tracking.js --mobile 9876543210 --token LS4820193765
 *     -> requests an OTP. With no SMS provider configured (SMTP_* unset),
 *        the code is printed to the SERVER's own console as
 *        "[DEV SMS to ...] Your Load Smart driver OTP is ......" — go look
 *        at the terminal running `npm start` and copy it from there.
 *
 *   node scripts/verify-gps-tracking.js --mobile 9876543210 --token LS4820193765 --otp 123456
 *     -> logs in, checks tracking-status, sends simulated GPS points, prints
 *        every server response and every 'tracking:location' socket push it
 *        receives, then prints a final summary (stored count, last known
 *        location, staleness).
 *
 * OPTIONAL FLAGS:
 *   --base http://localhost:4000      (default; your server's URL)
 *   --count 6                         (how many simulated pings to send)
 *   --interval-ms 3000                (delay between pings)
 *   --lat 28.6139 --lng 77.2090       (starting point; defaults to Delhi)
 *   --step-meters 25                  (how far each simulated ping moves —
 *                                       keep this >= GPS_MIN_MOVEMENT_METERS,
 *                                       default 15, or pings will be throttled)
 *   --watch-only                      (skip sending pings — just log in,
 *                                       confirm access, and listen on the
 *                                       socket; use this while a REAL phone
 *                                       is sending pings, to independently
 *                                       confirm the live push side works)
 *
 * WHAT "IT'S WORKING" LOOKS LIKE:
 *   - Each simulated ping prints `{"ok":true,"stored":true,"point":{...}}`
 *     (or `stored:false` with a throttle reason, which is also correct
 *     behavior, not a failure).
 *   - If socket.io-client is installed, a matching `[socket] tracking:location`
 *     line appears within ~1s of each stored ping.
 *   - The final tracking-status call shows `"status":"live"` and a `lastGps`
 *     matching the last point sent.
 *   - Opening the shipper's Live Tracking page or the Admin Tracking page
 *     for that same Token No. in a browser WHILE this script is running
 *     shows the truck marker actually move — that's the real, final proof.
 */

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const BASE = String(args.base || 'http://localhost:4000').replace(/\/$/, '');
const MOBILE = String(args.mobile || '');
const TOKEN_NO = String(args.token || '');
const OTP = args.otp != null ? String(args.otp) : null;
const COUNT = Number(args.count || 6);
const INTERVAL_MS = Number(args['interval-ms'] || 3000);
const START_LAT = Number(args.lat != null ? args.lat : 28.6139);
const START_LNG = Number(args.lng != null ? args.lng : 77.2090);
const STEP_METERS = Number(args['step-meters'] || 25);
const WATCH_ONLY = !!args['watch-only'];

function fail(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

if (!MOBILE || !TOKEN_NO) {
  fail('Usage: node scripts/verify-gps-tracking.js --mobile <driver mobile> --token <load Token No.> [--otp <code>] [options]\nSee the comment block at the top of this file for the full flow.');
}

function metersToLatLngDelta(meters, bearingDeg, atLat) {
  // Small-distance approximation — fine for a short simulated walk/drive.
  const bearing = (bearingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(bearing)) / 111320;
  const dLng = (meters * Math.sin(bearing)) / (111320 * Math.cos((atLat * Math.PI) / 180));
  return { dLat, dLng };
}

async function main() {
  console.log(`\n== Load Smart GPS tracking verification ==`);
  console.log(`Server: ${BASE}`);
  console.log(`Driver mobile: ${MOBILE}`);
  console.log(`Load Token No.: ${TOKEN_NO}\n`);

  // ---- 1. OTP login (same real flow the driver app uses) ----
  if (!OTP) {
    console.log('Step 1: requesting OTP...');
    const r = await fetch(`${BASE}/api/driver/login/send-otp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: MOBILE }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) fail(`send-otp failed (${r.status}): ${body.error || JSON.stringify(body)}`);
    console.log('✓ OTP requested.');
    console.log('  With no SMS provider configured, the code was printed to the SERVER\'s');
    console.log('  own console (look for a line like "[DEV SMS to ' + MOBILE + '] Your Load Smart');
    console.log('  driver OTP is ......").');
    console.log('\nRe-run this command with --otp <code> to continue.\n');
    return;
  }

  console.log('Step 1: verifying OTP...');
  const loginRes = await fetch(`${BASE}/api/driver/login/verify-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile: MOBILE, otp: OTP }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok) fail(`verify-otp failed (${loginRes.status}): ${loginBody.error || JSON.stringify(loginBody)}`);
  const driverToken = loginBody.token;
  console.log(`✓ Logged in as ${loginBody.driver && loginBody.driver.name} (driver id ${loginBody.driver && loginBody.driver.id}).\n`);

  const authHeaders = { Authorization: `Bearer ${driverToken}`, 'Content-Type': 'application/json' };

  // ---- 2. Confirm ownership + tracking is actually active ----
  console.log('Step 2: checking tracking-status for this load...');
  const statusRes = await fetch(`${BASE}/api/loads/${encodeURIComponent(TOKEN_NO)}/tracking-status`, { headers: authHeaders });
  const statusBody = await statusRes.json().catch(() => ({}));
  if (statusRes.status === 404) fail(`No load found for Token No. "${TOKEN_NO}" (check it's correct — this also 404s if it exists but isn't accessible to you).`);
  if (statusRes.status === 403) fail(`This driver is NOT authorized to see/track load "${TOKEN_NO}" — either the mobile number is wrong, or (correctly!) this load isn't assigned to this driver. That's the ownership check working as intended.`);
  if (!statusRes.ok) fail(`tracking-status failed (${statusRes.status}): ${statusBody.error || JSON.stringify(statusBody)}`);
  console.log('✓ Access confirmed. Current status:', JSON.stringify(statusBody, null, 2));
  if (!statusBody.trackingSessionActive) {
    fail(`trackingSessionActive is false — GPS tracking is not enabled for this load right now.\nHave the driver tap "Start Trip" in the app (or use the equivalent Admin action) first, then re-run this script.`);
  }
  console.log('');

  // ---- 3. Open a socket and listen, same room a shipper/admin browser joins ----
  let socket = null;
  let receivedCount = 0;
  try {
    const { io } = require('socket.io-client');
    socket = io(BASE, { transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      socket.emit('join', { tokenNo: TOKEN_NO });
      console.log(`[socket] connected and joined room for ${TOKEN_NO}`);
    });
    socket.on('tracking:location', (point) => {
      receivedCount++;
      console.log(`[socket] tracking:location #${receivedCount} ->`, JSON.stringify(point));
    });
    socket.on('connect_error', (err) => console.log('[socket] connect_error:', err.message));
  } catch (e) {
    console.log('(socket.io-client not installed — skipping live socket verification.');
    console.log(' Run: npm install --no-save socket.io-client   and re-run this script to also');
    console.log(' see the real-time push confirmed here, independent of opening a browser.)\n');
  }

  if (WATCH_ONLY) {
    console.log('--watch-only: not sending any simulated pings. Listening for real pings from a');
    console.log('phone/browser actually running the driver dashboard against this same load...');
    console.log('(Ctrl+C to stop.)\n');
    return; // process stays alive because of the open socket
  }

  // ---- 4. Send a short series of simulated GPS pings ----
  console.log(`Step 3: sending ${COUNT} simulated GPS pings, ${STEP_METERS}m apart, ${INTERVAL_MS}ms apart...\n`);
  let lat = START_LAT, lng = START_LNG;
  for (let i = 0; i < COUNT; i++) {
    if (i > 0) {
      const { dLat, dLng } = metersToLatLngDelta(STEP_METERS, 45, lat); // walk northeast
      lat += dLat; lng += dLng;
    }
    const point = {
      lat, lng,
      accuracy: 8 + Math.round(Math.random() * 10),
      speedKph: 30 + Math.round(Math.random() * 20),
      headingDeg: 45,
      altitude: 210,
      deviceTimestamp: new Date().toISOString(),
    };
    const r = await fetch(`${BASE}/api/driver/loads/${encodeURIComponent(TOKEN_NO)}/gps`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify(point),
    });
    const body = await r.json().catch(() => ({}));
    console.log(`  ping ${i + 1}/${COUNT} (${lat.toFixed(6)}, ${lng.toFixed(6)}) -> HTTP ${r.status}:`, JSON.stringify(body));
    if (i < COUNT - 1) await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }

  // Give the socket a moment to catch the last event before we check status/history.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // ---- 5. Final verification: status + history reflect what we just sent ----
  console.log('\nStep 4: re-checking tracking-status and tracking-history...');
  const finalStatus = await (await fetch(`${BASE}/api/loads/${encodeURIComponent(TOKEN_NO)}/tracking-status`, { headers: authHeaders })).json();
  console.log('Final tracking-status:', JSON.stringify(finalStatus, null, 2));

  const historyRes = await fetch(`${BASE}/api/orders/${encodeURIComponent(TOKEN_NO)}/tracking-history?limit=${COUNT + 5}`, { headers: authHeaders });
  const history = await historyRes.json().catch(() => ({}));
  console.log(`\nHistory now has ${history.totalCount != null ? history.totalCount : '?'} total point(s) recorded for this load` +
    ` (returned ${history.returned != null ? history.returned : (history.points || []).length} in this request).`);

  console.log(`\n== Summary ==`);
  console.log(`Sent: ${COUNT} simulated ping(s).`);
  console.log(`Socket pushes received in this terminal: ${receivedCount}${socket ? '' : ' (socket.io-client not installed, so this stayed 0 — see note above)'}`);
  console.log(finalStatus.status === 'live'
    ? '✓ tracking-status reports "live" — the pipeline is working end to end.'
    : `⚠ tracking-status reports "${finalStatus.status}" — check GPS_STALE_AFTER_MS if this is unexpected, or that the pings above were actually accepted (stored:true) rather than throttled.`);
  console.log('\nFor final visual confirmation: open the shipper Live Tracking page or the Admin');
  console.log(`Tracking page for Token No. ${TOKEN_NO} in a browser and re-run this script (or a real`);
  console.log('phone) — the truck marker should visibly move without the page reloading.\n');

  if (socket) socket.disconnect();
}

main().catch((err) => {
  if (err && (err.cause && err.cause.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message))) {
    fail(`Could not reach ${BASE} — is the server actually running there (npm start), and reachable from wherever this script runs?`);
  }
  fail(err.stack || err.message);
});
