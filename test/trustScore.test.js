'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTrustScore, trustLabel, TRUST_WEIGHTS } = require('../lib/trustScore');

function feedback(overrides) {
  return Object.assign(
    { rating: 5, onTime: true, deliverySuccess: true, cargoHandling: true, communication: true, recommend: true },
    overrides
  );
}

test('TRUST_WEIGHTS sums to 100', () => {
  const total = Object.values(TRUST_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test('brand-new driver with no history gets the neutral baseline, not 0 or 100', () => {
  const result = computeTrustScore({ completedTrips: 0, cancelledCount: 0, recentFeedbacks: [] });
  assert.equal(result.score, 70);
  assert.equal(result.basedOnTrips, 0);
});

test('a driver with many trips and excellent feedback scores in the "Excellent" range', () => {
  const feedbacks = Array.from({ length: 40 }, () => feedback());
  const result = computeTrustScore({ completedTrips: 127, cancelledCount: 2, recentFeedbacks: feedbacks });
  assert.ok(result.score >= 90, `expected excellent score, got ${result.score}`);
  assert.equal(result.label, 'Excellent');
  assert.equal(trustLabel(result.score), 'Excellent');
});

test('a driver with consistently poor feedback scores low', () => {
  const feedbacks = Array.from({ length: 20 }, () =>
    feedback({ rating: 1, onTime: false, deliverySuccess: false, recommend: false })
  );
  const result = computeTrustScore({ completedTrips: 20, cancelledCount: 6, recentFeedbacks: feedbacks });
  assert.ok(result.score <= 40, `expected a poor score, got ${result.score}`);
});

test('cancellations reduce the score', () => {
  const feedbacks = Array.from({ length: 20 }, () => feedback());
  const lowCancel = computeTrustScore({ completedTrips: 40, cancelledCount: 1, recentFeedbacks: feedbacks });
  const highCancel = computeTrustScore({ completedTrips: 40, cancelledCount: 20, recentFeedbacks: feedbacks });
  assert.ok(lowCancel.score > highCancel.score);
});

test('mixed ratings land between the all-good and all-bad extremes', () => {
  const mixed = Array.from({ length: 20 }, (_, i) => feedback({ rating: i % 2 === 0 ? 5 : 2, onTime: i % 2 === 0 }));
  const allGood = Array.from({ length: 20 }, () => feedback());
  const allBad = Array.from({ length: 20 }, () => feedback({ rating: 1, onTime: false, deliverySuccess: false, recommend: false }));

  const mixedScore = computeTrustScore({ completedTrips: 20, cancelledCount: 0, recentFeedbacks: mixed }).score;
  const goodScore = computeTrustScore({ completedTrips: 20, cancelledCount: 0, recentFeedbacks: allGood }).score;
  const badScore = computeTrustScore({ completedTrips: 20, cancelledCount: 0, recentFeedbacks: allBad }).score;

  assert.ok(mixedScore < goodScore);
  assert.ok(mixedScore > badScore);
});

test('manipulation protection: 1 trip + 5 stars does NOT outrank 200 trips at a strong 4.8-equivalent average', () => {
  const oneTrip = computeTrustScore({
    completedTrips: 1,
    cancelledCount: 0,
    recentFeedbacks: [feedback({ rating: 5 })],
  });
  const longHistory = Array.from({ length: 50 }, (_, i) =>
    // a realistic 4.8/5-ish driver: mostly 5s, occasional 4, always on-time/recommended
    feedback({ rating: i % 6 === 0 ? 4 : 5 })
  );
  const twoHundredTrips = computeTrustScore({
    completedTrips: 200,
    cancelledCount: 3,
    recentFeedbacks: longHistory,
  });

  assert.ok(
    twoHundredTrips.score > oneTrip.score,
    `expected the 200-trip driver (${twoHundredTrips.score}) to outrank the 1-trip driver (${oneTrip.score})`
  );
  // and the 1-trip driver should show low confidence, surfaced in the UI
  // as "based on 1 completed trip" rather than presented at face value
  assert.ok(oneTrip.confidence < 50, `expected low confidence for a 1-trip driver, got ${oneTrip.confidence}`);
  assert.equal(oneTrip.basedOnTrips, 1);
});

test('confidence rises toward 100 as completed trips approach the full-confidence threshold', () => {
  const few = computeTrustScore({ completedTrips: 1, cancelledCount: 0, recentFeedbacks: [feedback()] });
  const many = computeTrustScore({
    completedTrips: 30,
    cancelledCount: 0,
    recentFeedbacks: Array.from({ length: 30 }, () => feedback()),
  });
  assert.ok(many.confidence > few.confidence);
  assert.equal(many.confidence, 100);
});

test('recency weighting: a recent slump outweighs old excellent history', () => {
  // Most-recent-first, per the documented contract.
  const recentSlump = [
    feedback({ rating: 2, onTime: false, deliverySuccess: false, recommend: false }),
    feedback({ rating: 2, onTime: false, deliverySuccess: false, recommend: false }),
    feedback({ rating: 2, onTime: false, deliverySuccess: false, recommend: false }),
    ...Array.from({ length: 20 }, () => feedback()), // older, excellent
  ];
  const steady = Array.from({ length: 23 }, () => feedback());

  const slumpScore = computeTrustScore({ completedTrips: 23, cancelledCount: 0, recentFeedbacks: recentSlump }).score;
  const steadyScore = computeTrustScore({ completedTrips: 23, cancelledCount: 0, recentFeedbacks: steady }).score;

  assert.ok(slumpScore < steadyScore);
});

test('component breakdown reflects the underlying rates for the driver profile UI', () => {
  const feedbacks = [
    feedback({ rating: 5, onTime: true }),
    feedback({ rating: 5, onTime: true }),
    feedback({ rating: 4, onTime: false }),
    feedback({ rating: 5, onTime: true }),
  ];
  const result = computeTrustScore({ completedTrips: 127, cancelledCount: 2, recentFeedbacks: feedbacks });
  assert.ok(result.components.customerRating > 4 && result.components.customerRating <= 5);
  assert.ok(result.components.onTimeRate > 0 && result.components.onTimeRate <= 100);
  assert.ok(result.components.cancellationRate != null);
});

test('score is always clamped to the 0-100 range', () => {
  const extreme = computeTrustScore({
    completedTrips: 500,
    cancelledCount: 500,
    recentFeedbacks: Array.from({ length: 50 }, () => feedback({ rating: 1, onTime: false, deliverySuccess: false, recommend: false })),
  });
  assert.ok(extreme.score >= 0 && extreme.score <= 100);
});
