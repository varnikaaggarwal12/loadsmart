/**
 * lib/gpsValidation.js
 *
 * Pure, deterministic, DB-free GPS logic — same design convention as
 * lib/matchingEngine.js (see its header comment): every function here
 * takes plain values/objects and returns plain data, no network/DB calls,
 * no reliance on process.env (thresholds are passed in, with sane
 * defaults from lib/gpsConfig.js at the call site), so it's fully
 * unit-testable (see test/gpsTracking.test.js).
 */
'use strict';

const { getGpsConfig } = require('./gpsConfig');

/**
 * Validates one raw GPS reading from a driver's browser BEFORE it is ever
 * persisted or broadcast. Returns { valid: boolean, reason?: string,
 * point?: object } — `point` is the cleaned/normalized reading, safe to
 * store, only present when valid.
 */
function validateGpsPoint(raw, opts = {}) {
  const cfg = { ...getGpsConfig(), ...opts };
  const lat = Number(raw && raw.lat);
  const lng = Number(raw && raw.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { valid: false, reason: 'lat/lng must be finite numbers.' };
  }
  if (lat < -90 || lat > 90) return { valid: false, reason: 'lat must be between -90 and 90.' };
  if (lng < -180 || lng > 180) return { valid: false, reason: 'lng must be between -180 and 180.' };
  // (0,0) is "Null Island" — a real device essentially never legitimately
  // reports this exact pair; it's the classic sign of an unset/placeholder
  // coordinate slipping through as if it were real.
  if (lat === 0 && lng === 0) return { valid: false, reason: 'lat/lng of exactly (0,0) is treated as an invalid/placeholder reading.' };

  const accuracy = raw.accuracy != null ? Number(raw.accuracy) : null;
  if (accuracy != null) {
    if (!Number.isFinite(accuracy) || accuracy < 0) return { valid: false, reason: 'accuracy must be a non-negative number.' };
    if (accuracy > cfg.maxAcceptableAccuracyMeters) {
      return { valid: false, reason: `accuracy (${accuracy}m) exceeds the maximum acceptable radius (${cfg.maxAcceptableAccuracyMeters}m).` };
    }
  }

  const speedKph = raw.speedKph != null ? Number(raw.speedKph) : null;
  if (speedKph != null) {
    if (!Number.isFinite(speedKph) || speedKph < 0) return { valid: false, reason: 'speedKph must be a non-negative number.' };
    if (speedKph > 300) return { valid: false, reason: 'speedKph is implausibly high (>300 km/h) — rejected as a bad reading.' };
  }

  const headingDeg = raw.headingDeg != null ? Number(raw.headingDeg) : null;
  if (headingDeg != null) {
    if (!Number.isFinite(headingDeg) || headingDeg < 0 || headingDeg >= 360) {
      return { valid: false, reason: 'headingDeg must be a number in [0, 360).' };
    }
  }

  const altitude = raw.altitude != null ? Number(raw.altitude) : null;
  if (altitude != null && !Number.isFinite(altitude)) {
    return { valid: false, reason: 'altitude must be a finite number when provided.' };
  }

  let deviceTimestamp = null;
  if (raw.deviceTimestamp != null) {
    const ts = new Date(raw.deviceTimestamp);
    if (Number.isNaN(ts.getTime())) return { valid: false, reason: 'deviceTimestamp is not a valid date/time.' };
    const skew = Math.abs(Date.now() - ts.getTime());
    if (skew > cfg.maxClockSkewMs) {
      return { valid: false, reason: `deviceTimestamp is ${Math.round(skew / 1000)}s away from server time — likely a bad device clock.` };
    }
    deviceTimestamp = ts;
  }

  return {
    valid: true,
    point: { lat, lng, accuracy, speedKph, headingDeg, altitude, deviceTimestamp },
  };
}

/** Great-circle distance in meters between two {lat,lng} points (haversine). */
function haversineMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Server-side accept/reject decision for a new ping given the previous
 * accepted one — defense-in-depth throttling independent of whatever the
 * client already does. A ping is always accepted if enough TIME has
 * passed; between that, it's only accepted if the truck actually MOVED a
 * meaningful distance, so a stationary truck sending pings every second
 * doesn't fill the history collection with near-duplicate points.
 */
function shouldAcceptPing({ prevPoint, prevAt, nextPoint, nextAt }, opts = {}) {
  const cfg = { ...getGpsConfig(), ...opts };
  if (!prevPoint || !prevAt) return { accept: true, reason: 'first point for this load' };
  const elapsedMs = nextAt - prevAt;
  if (elapsedMs < 0) return { accept: false, reason: 'out-of-order timestamp' };
  if (elapsedMs < cfg.minIntervalMs) {
    const distance = haversineMeters(prevPoint, nextPoint);
    if (distance < cfg.minMovementMeters) {
      return { accept: false, reason: `too soon (${elapsedMs}ms) and too little movement (${Math.round(distance)}m)` };
    }
  }
  return { accept: true };
}

/** Classifies how "live" a load's last-known position is for the UI (spec: "online/live status" + "last known location if updates stop"). */
function classifyStaleness(lastUpdatedAt, now = Date.now(), opts = {}) {
  const cfg = { ...getGpsConfig(), ...opts };
  if (!lastUpdatedAt) return { status: 'no_data', staleMs: null };
  const staleMs = now - new Date(lastUpdatedAt).getTime();
  if (staleMs < 0) return { status: 'live', staleMs: 0 };
  return { status: staleMs > cfg.staleAfterMs ? 'stale' : 'live', staleMs };
}

module.exports = { validateGpsPoint, haversineMeters, shouldAcceptPing, classifyStaleness };
