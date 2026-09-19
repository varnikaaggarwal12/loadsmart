/**
 * lib/gpsConfig.js
 *
 * Configurable thresholds for the driver GPS tracking system. Kept
 * separate from lib/gpsValidation.js (which stays pure/env-free and is
 * unit-tested without any process.env involved) — same split already used
 * for lib/matchConfig.js vs lib/matchingEngine.js.
 */
function num(envVar, fallback) {
  const v = Number(process.env[envVar]);
  return Number.isFinite(v) ? v : fallback;
}

function getGpsConfig() {
  return {
    // Server-side floor on how often ONE load's GPS ping is accepted,
    // regardless of what the driver's browser sends — defense in depth
    // behind the client's own throttling (a buggy/compromised client
    // hammering the endpoint can't flood the database).
    minIntervalMs: num('GPS_MIN_INTERVAL_MS', 2000),
    // A point closer than this to the previous one AND sooner than
    // minIntervalMs is considered redundant and skipped (still 200s OK,
    // just not persisted) — keeps a stationary truck from filling the
    // history collection with identical points.
    minMovementMeters: num('GPS_MIN_MOVEMENT_METERS', 15),
    // Accuracy worse than this (meters) is still stored (better a rough
    // point than a gap) but flagged so the UI can show "weak GPS signal"
    // rather than trusting it as precise.
    weakAccuracyMeters: num('GPS_WEAK_ACCURACY_METERS', 100),
    // A ping is rejected outright above this accuracy radius — likely a
    // bogus/very-low-quality fix (e.g. IP-based geolocation fallback).
    maxAcceptableAccuracyMeters: num('GPS_MAX_ACCURACY_METERS', 2000),
    // No live position update in longer than this is shown to authorized
    // viewers as "last known location — tracking may have stopped"
    // instead of implying the truck is still actively reporting.
    staleAfterMs: num('GPS_STALE_AFTER_MS', 120000), // 2 minutes
    // Hard cap on how many raw history points a single API response can
    // return — the browser must never be asked to render an unbounded
    // number of points.
    maxHistoryPoints: num('GPS_MAX_HISTORY_POINTS', 1000),
    defaultHistoryPoints: num('GPS_DEFAULT_HISTORY_POINTS', 300),
    // Device-reported timestamps further than this from "now" (past or
    // future) are rejected — protects against a wildly wrong device clock
    // silently corrupting the trip history's chronology.
    maxClockSkewMs: num('GPS_MAX_CLOCK_SKEW_MS', 10 * 60 * 1000), // 10 minutes
  };
}

module.exports = { getGpsConfig };
