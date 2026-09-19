/**
 * lib/matchConfig.js
 *
 * Configurable thresholds for the Load<->Truck MATCH EMAIL system (spec:
 * "only trigger a Perfect Match email at a CONFIGURABLE threshold"). Kept
 * separate from lib/matchingEngine.js on purpose — that module is
 * explicitly documented as pure/deterministic/env-free (it's unit-tested
 * without any process.env involved); this tiny module is the one place
 * allowed to read env vars, so the pure engine never has to.
 *
 * Bands (all overridable via .env, matching the spec's example numbers):
 *   >= MATCH_PERFECT_THRESHOLD  (default 90) -> "Perfect Match"
 *   >= MATCH_STRONG_THRESHOLD   (default 75) -> "Strong Match"
 *   >= MATCH_POSSIBLE_THRESHOLD (default 60) -> "Possible Match"
 *   below MATCH_POSSIBLE_THRESHOLD           -> no match email at all
 */
function num(envVar, fallback) {
  const v = Number(process.env[envVar]);
  return Number.isFinite(v) ? v : fallback;
}

function getThresholds() {
  return {
    perfect: num('MATCH_PERFECT_THRESHOLD', 90),
    strong: num('MATCH_STRONG_THRESHOLD', 75),
    possible: num('MATCH_POSSIBLE_THRESHOLD', 60),
  };
}

/** Returns null (no email should be sent) or one of 'PERFECT'|'STRONG'|'POSSIBLE'. */
function classifyMatchScore(score) {
  const t = getThresholds();
  if (score >= t.perfect) return 'PERFECT';
  if (score >= t.strong) return 'STRONG';
  if (score >= t.possible) return 'POSSIBLE';
  return null;
}

const TIER_LABELS = {
  PERFECT: 'Perfect Match',
  STRONG: 'Strong Match',
  POSSIBLE: 'Possible Match',
};

module.exports = { getThresholds, classifyMatchScore, TIER_LABELS };
