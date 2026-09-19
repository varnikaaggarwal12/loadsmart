/**
 * lib/trustScore.js
 * Load Smart — Driver Trust Score.
 *
 * Pure, deterministic, DB-free. Given a driver's operational counters
 * (completed trips, cancellations) and a window of recent customer
 * feedback, computes a single 0-100 trust score plus the underlying
 * component breakdown shown on the Driver Profile screen.
 *
 * Deliberately NOT just the average star rating (see spec) — it blends
 * six weighted components, all tunable from ONE config object
 * (TRUST_WEIGHTS) below.
 *
 * Manipulation protection (spec §11): a single 5-star review from a
 * brand-new driver must not outscore a 200-trip driver with a 4.8
 * average. Two mechanisms enforce that:
 *   1. Confidence dampening — the raw weighted score is blended toward a
 *      neutral baseline (NEUTRAL_BASELINE) in proportion to how much
 *      trip history actually backs it up (see `confidence` below).
 *   2. Recency-weighted feedback window — only the most recent
 *      RECENT_FEEDBACK_WINDOW reviews are considered, and within that
 *      window the newest reviews are weighted more heavily than older
 *      ones (linear ramp), so a driver's score reflects how they're
 *      doing lately rather than an unmovable lifetime average.
 */
'use strict';

// One place to retune how the six factors combine — must sum to 100.
const TRUST_WEIGHTS = {
  rating: 35,       // customer star rating (1-5, normalized to 0-100)
  onTime: 20,       // % of recent feedback saying "yes, on time"
  completion: 15,   // % of recent feedback saying "yes, delivered successfully"
  cancellation: 10, // inverse of the driver's all-time cancellation rate
  recommend: 10,    // % of recent feedback saying "yes, would use again"
  complaints: 10,   // inverse of % of recent feedback that reads as a complaint (rating <= 2)
};

const NEUTRAL_BASELINE = 70; // score assigned to a driver with no track record yet
const MIN_TRIPS_FOR_FULL_CONFIDENCE = 8; // trip count at which dampening stops
const RECENT_FEEDBACK_WINDOW = 50; // only the most recent N reviews count toward scoring

const TRUST_LABELS = [
  { max: 39, label: 'Poor' },
  { max: 59, label: 'Needs Improvement' },
  { max: 74, label: 'Good' },
  { max: 89, label: 'Very Good' },
  { max: 100, label: 'Excellent' },
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 0-100 -> the accessible label shown next to (never instead of) the score/color. */
function trustLabel(score) {
  const match = TRUST_LABELS.find((t) => score <= t.max);
  return match ? match.label : 'Excellent';
}

// Newest-first weighting: recentFeedbacks[0] is the most recent and gets
// the largest weight (n), the oldest in the window gets weight 1.
function weightedAverage(values, weights) {
  let sumV = 0;
  let sumW = 0;
  for (let i = 0; i < values.length; i++) {
    sumV += values[i] * weights[i];
    sumW += weights[i];
  }
  return sumW ? sumV / sumW : null;
}

/**
 * @param {object} metrics
 * @param {number} metrics.completedTrips - all-time count of trips this driver has completed (operational truth, independent of whether feedback was left)
 * @param {number} metrics.cancelledCount - all-time count of trips cancelled while assigned to this driver
 * @param {Array<{rating:number, onTime?:boolean, deliverySuccess?:boolean, cargoHandling?:boolean, communication?:boolean, recommend?:boolean, createdAt?:Date|string}>} metrics.recentFeedbacks
 *   Most-recent-first. Caller is expected to have already sorted/limited
 *   this (e.g. `Feedback.find({driverId}).sort({createdAt:-1}).limit(50)`)
 *   — this function will additionally re-cap to RECENT_FEEDBACK_WINDOW as
 *   a safety net.
 * @returns {{score:number, label:string, confidence:number, basedOnTrips:number, components:object}}
 */
function computeTrustScore(metrics) {
  const completedTrips = Math.max(0, Math.round(metrics.completedTrips || 0));
  const cancelledCount = Math.max(0, Math.round(metrics.cancelledCount || 0));
  const feedbacks = (metrics.recentFeedbacks || []).slice(0, RECENT_FEEDBACK_WINDOW);
  const n = feedbacks.length;
  // weights[0] (newest) = n, weights[n-1] (oldest in window) = 1.
  const weights = feedbacks.map((_, i) => n - i);

  const ratingPct = n
    ? weightedAverage(
        feedbacks.map((f) => clamp((Number(f.rating) || 0) / 5, 0, 1) * 100),
        weights
      )
    : null;
  const onTimePct = n
    ? weightedAverage(
        feedbacks.map((f) => (f.onTime ? 100 : 0)),
        weights
      )
    : null;
  const completionPct = n
    ? weightedAverage(
        feedbacks.map((f) => (f.deliverySuccess ? 100 : 0)),
        weights
      )
    : null;
  const recommendPct = n
    ? weightedAverage(
        feedbacks.map((f) => (f.recommend ? 100 : 0)),
        weights
      )
    : null;
  // A review reads as a "complaint" when the customer rated 2 stars or
  // below — cheap, deterministic proxy that needs no separate flag.
  const complaintPct = n
    ? weightedAverage(
        feedbacks.map((f) => ((Number(f.rating) || 5) <= 2 ? 100 : 0)),
        weights
      )
    : null;

  const totalAttempts = completedTrips + cancelledCount;
  const cancellationRatePct = totalAttempts ? (cancelledCount / totalAttempts) * 100 : null;

  const components = {
    rating: ratingPct != null ? ratingPct : NEUTRAL_BASELINE,
    onTime: onTimePct != null ? onTimePct : NEUTRAL_BASELINE,
    completion: completionPct != null ? completionPct : NEUTRAL_BASELINE,
    cancellation: cancellationRatePct != null ? 100 - cancellationRatePct : NEUTRAL_BASELINE,
    recommend: recommendPct != null ? recommendPct : NEUTRAL_BASELINE,
    complaints: complaintPct != null ? 100 - complaintPct : NEUTRAL_BASELINE,
  };

  let weightedSum = 0;
  let weightTotal = 0;
  for (const key of Object.keys(TRUST_WEIGHTS)) {
    weightedSum += components[key] * TRUST_WEIGHTS[key];
    weightTotal += TRUST_WEIGHTS[key];
  }
  const rawScore = weightTotal ? weightedSum / weightTotal : NEUTRAL_BASELINE;

  // Confidence dampening (spec §11) — blend the raw score toward the
  // neutral baseline until there's enough trip history to trust it.
  const sampleSize = Math.max(completedTrips, n);
  const confidence = clamp(sampleSize / MIN_TRIPS_FOR_FULL_CONFIDENCE, 0, 1);
  const finalScoreRaw = NEUTRAL_BASELINE + (rawScore - NEUTRAL_BASELINE) * confidence;
  const finalScore = Math.round(clamp(finalScoreRaw, 0, 100));

  return {
    score: finalScore,
    label: trustLabel(finalScore),
    confidence: Math.round(confidence * 100), // 0-100, for a "still learning this driver" UI hint
    basedOnTrips: completedTrips,
    components: {
      customerRating: ratingPct != null ? round1((ratingPct / 100) * 5) : null, // back to a /5 scale for display
      onTimeRate: onTimePct != null ? round1(onTimePct) : null,
      completionRate: completionPct != null ? round1(completionPct) : null,
      cancellationRate: cancellationRatePct != null ? round1(cancellationRatePct) : null,
      recommendRate: recommendPct != null ? round1(recommendPct) : null,
      complaintRate: complaintPct != null ? round1(complaintPct) : null,
    },
  };
}

module.exports = {
  TRUST_WEIGHTS,
  NEUTRAL_BASELINE,
  MIN_TRIPS_FOR_FULL_CONFIDENCE,
  RECENT_FEEDBACK_WINDOW,
  trustLabel,
  computeTrustScore,
};
