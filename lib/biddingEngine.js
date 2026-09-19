/**
 * lib/biddingEngine.js
 *
 * Pure, DB-free functions for the two hardest pieces of logic in the
 * Carrier Bidding system: LoadSmart's margin pricing, and ranking
 * competing carrier bids for the shipper. Deliberately does NOT
 * re-implement any AI-matching or trust scoring — it calls straight into
 * the existing lib/matchingEngine.js (`scoreCandidate`) so a bid's "AI
 * Match %" is computed by the exact same engine used everywhere else in
 * this app, never a second copy of that logic. Same "pure, deterministic,
 * no I/O" contract as matchingEngine.js/trustScore.js — every function
 * here takes plain objects and returns plain objects, so it's trivially
 * unit-testable with `node --test` and safe to call from any route.
 */
const matchingEngine = require('./matchingEngine');

const MARGIN_TYPES = ['FIXED', 'PERCENTAGE'];

/**
 * Computes LoadSmart's margin and the shipper's final price for one
 * carrier bid, given the current (or a snapshotted) margin configuration.
 * This is the ONLY place that formula lives — every route that needs a
 * price (the shipper's ranked list, the admin's full-detail bid list, and
 * the accept-bid transaction that locks it in) calls this same function so
 * none of them can ever disagree with each other.
 *
 * @param {{carrierBidAmount:number, marginConfig:{marginType:string, marginValue:number, minMargin?:number|null, maxMargin?:number|null}}} args
 * @returns {{marginType:string, marginValue:number, marginAmount:number, finalShipperPrice:number, carrierBidAmount:number}}
 */
function calculateLoadSmartPricing({ carrierBidAmount, marginConfig }) {
  const bid = Number(carrierBidAmount);
  if (!Number.isFinite(bid) || bid <= 0) {
    const err = new Error('carrierBidAmount must be a positive number.');
    err.status = 400;
    throw err;
  }
  const type = marginConfig && MARGIN_TYPES.includes(marginConfig.marginType) ? marginConfig.marginType : 'PERCENTAGE';
  const value = Number(marginConfig && marginConfig.marginValue);
  const safeValue = Number.isFinite(value) ? value : 0;
  let marginAmount = type === 'FIXED' ? safeValue : bid * (safeValue / 100);
  if (marginConfig && marginConfig.minMargin != null && Number.isFinite(Number(marginConfig.minMargin))) {
    marginAmount = Math.max(marginAmount, Number(marginConfig.minMargin));
  }
  if (marginConfig && marginConfig.maxMargin != null && Number.isFinite(Number(marginConfig.maxMargin))) {
    marginAmount = Math.min(marginAmount, Number(marginConfig.maxMargin));
  }
  marginAmount = Math.round(marginAmount * 100) / 100;
  const finalShipperPrice = Math.round((bid + marginAmount) * 100) / 100;
  return { marginType: type, marginValue: safeValue, marginAmount, finalShipperPrice, carrierBidAmount: bid };
}

/**
 * Normalizes one bid's final price into a 0-100 "cheaper is better" score
 * relative to every other bid currently competing for the same load — a
 * bid can only be judged cheap/expensive relative to its own load's other
 * offers, not against some fixed global scale.
 */
function priceScoreWithinSet(finalPrice, allFinalPrices) {
  const prices = (allFinalPrices || []).filter((p) => Number.isFinite(p));
  if (!prices.length) return 100;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (max === min) return 100;
  return Math.round((100 * (max - finalPrice)) / (max - min));
}

/**
 * Ranks a load's competing bids for the SHIPPER's eyes — the composite
 * score blends three things, per spec ("must not auto-select cheapest bid
 * only — must rank using AI Match Score + Trust Score + price + distance +
 * truck compatibility + historical performance + availability"):
 *   - aiMatchScore (50%): matchingEngine.scoreCandidate(load, truck, driver)
 *     — its own breakdown already covers routeCompatibility, availability,
 *     truckCompatibility, capacity, onTimePerformance and tripHistory, so
 *     every one of those named factors is genuinely used, not just listed.
 *   - priceScore (35%): this bid's finalShipperPrice, normalized against
 *     the other bids on the SAME load (see priceScoreWithinSet).
 *   - trustScore (15%): the driver's cached lib/trustScore.js score. (Trust
 *     is also one of the 7 weighted inputs INSIDE aiMatchScore already —
 *     it gets a second, smaller, explicit weight here on top of that
 *     because the spec asks for Trust Score to be a distinct, visible
 *     ranking factor in its own right, not just a hidden component of a
 *     single blended number.)
 *
 * @param {object} load plain BookingRequest-shaped object (pickup/weight/requiredTruckType/etc.)
 * @param {Array<{bid:object, truck:object, driver:object|null, finalShipperPrice:number}>} bidsWithContext
 * @returns {Array<object>} ranked, richest-first (rank 1 = best), each with bidId/finalShipperPrice/aiMatchScore/trustScore/priceScore/compositeScore/rank
 */
function rankBidsForShipper(load, bidsWithContext) {
  const priced = (bidsWithContext || []).map((b) => ({
    ...b,
    aiMatch: matchingEngine.scoreCandidate(load, b.truck, b.driver || {}),
  }));
  const allPrices = priced.map((b) => b.finalShipperPrice);
  const ranked = priced.map((b) => {
    const priceScore = priceScoreWithinSet(b.finalShipperPrice, allPrices);
    const trustScore = (b.driver && typeof b.driver.trustScore === 'number') ? b.driver.trustScore : 70;
    const compositeScore = Math.round(b.aiMatch.score * 0.5 + priceScore * 0.35 + trustScore * 0.15);
    return {
      bidId: b.bid.id,
      carrierCompanyName: b.bid.carrierCompanyName,
      finalShipperPrice: b.finalShipperPrice,
      aiMatchScore: b.aiMatch.score,
      aiMatchBreakdown: b.aiMatch.breakdown,
      trustScore,
      priceScore,
      compositeScore,
      truckType: b.truck.truckType,
      bodyType: b.truck.bodyType || '',
      capacityTons: b.truck.capacityTons,
      currentLocation: b.truck.currentLocation || '',
      submittedAt: b.bid.createdAt,
      notes: b.bid.notes || '',
    };
  });
  ranked.sort((a, c) => c.compositeScore - a.compositeScore);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return ranked;
}

module.exports = { MARGIN_TYPES, calculateLoadSmartPricing, priceScoreWithinSet, rankBidsForShipper };
