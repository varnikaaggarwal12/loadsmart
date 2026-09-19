/**
 * lib/brokerAiFallback.js
 *
 * Deterministic, rule-based answers for the Broker AI Assistant's most
 * common questions — used automatically whenever the real LLM (Claude, via
 * lib/aiService.js) isn't configured, or a live call to it fails. This is
 * what makes "AI Assistant is currently unavailable" mean "some questions
 * still work" instead of "nothing works."
 *
 * SAME safety contract as lib/brokerAiTools.js: every function here is
 * handed the already-authenticated broker's own repo (see
 * buildBrokerAiRepo() in server_load.js) — the exact same data-access
 * functions the real AI tool-calling path uses — so a fallback answer can
 * NEVER show different data than the AI path would have, and can never
 * invent a load, price, document, or account status that doesn't exist.
 * Never a write — read-only, exactly like the real assistant.
 *
 * Pure pattern-matching + formatting: no network, no randomness, so this
 * is trivially unit-testable with a fake in-memory repo.
 */
'use strict';

function norm(s) { return String(s || '').toLowerCase(); }

/** Which canonical question (if any) `message` most likely means. Order matters — checked most-specific first. */
function classify(message) {
  const m = norm(message);
  if (/\b(match|matching)\b.*\broute/.test(m) || /route.*match/.test(m) || /which loads? match/.test(m) || (/loads?/.test(m) && /route/.test(m))) return 'LOADS_FOR_ROUTES';
  if (/document/.test(m) && /(missing|need|require)/.test(m)) return 'MISSING_DOCUMENTS';
  if (/pending/.test(m) && /account/.test(m)) return 'ACCOUNT_PENDING';
  if (/why.*pending|pending.*why/.test(m)) return 'ACCOUNT_PENDING';
  if (/bid/.test(m) && /(active|status|current)/.test(m)) return 'ACTIVE_BIDS';
  if (/what should i do next|next step|what next/.test(m)) return 'NEXT_STEPS';
  return null;
}

async function answerLoadsForRoutes(broker, repo) {
  const [profile, loads] = await Promise.all([repo.getProfile(broker), repo.getAvailableLoads(broker, {})]);
  const prefs = profile && profile.loadPreferences;
  if (!loads || !loads.length) {
    return 'There are no open loads on the board right now, so there is nothing to match against your routes at this moment. Check back soon.';
  }
  const origins = ((prefs && prefs.preferredOrigins) || []).map(norm);
  const destinations = ((prefs && prefs.preferredDestinations) || []).map(norm);
  const truckTypes = ((prefs && prefs.preferredTruckTypes) || []).map(norm);
  const scored = loads.map((l) => {
    let score = 0;
    const reasons = [];
    const pickup = norm(l.pickup), dest = norm(l.destination), type = norm(l.requiredTruckType);
    if (origins.some((o) => o && pickup.includes(o))) { score += 40; reasons.push('matches a preferred origin'); }
    if (destinations.some((d) => d && dest.includes(d))) { score += 40; reasons.push('matches a preferred destination'); }
    if (truckTypes.some((t) => t && type.includes(t))) { score += 20; reasons.push('matches a preferred truck type'); }
    return { l, score, reasons };
  });
  const hasPrefs = origins.length || destinations.length || truckTypes.length;
  const ranked = hasPrefs ? scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score) : scored;
  if (hasPrefs && !ranked.length) {
    return `None of the ${loads.length} currently open load(s) match your saved route preferences yet. You can widen your preferred origins/destinations/truck types in Profile, or browse the full Load Board.`;
  }
  const top = ranked.slice(0, 5);
  const lines = top.map((s) => `• ${s.l.tokenNo}: ${s.l.pickup} → ${s.l.destination}${s.l.requiredTruckType ? ' (' + s.l.requiredTruckType + ')' : ''}${s.reasons.length ? ' — ' + s.reasons.join(', ') : ''}`);
  const intro = hasPrefs
    ? `Based on your saved route preferences, here are your best-matching open load(s):`
    : `You haven't saved route preferences yet, so here are the currently open loads (set preferences in Profile for a more targeted list):`;
  return `${intro}\n${lines.join('\n')}`;
}

async function answerMissingDocuments(broker, repo) {
  const kyc = await repo.getKycStatus(broker);
  if (!kyc.missingDocuments || !kyc.missingDocuments.length) {
    return `You have no missing required documents on file. Your current KYC status is ${kyc.kycStatus}.`;
  }
  return `Your KYC status is ${kyc.kycStatus}. You are still missing: ${kyc.missingDocuments.join(', ')}. Upload them from the KYC & Documents tab.`;
}

/** Maps the broker's REAL kycStatus/rejection/requested-docs fields onto a plain-language reason — never invents a state (like "physical verification pending") this app doesn't actually track. */
async function answerAccountPending(broker, repo) {
  const kyc = await repo.getKycStatus(broker);
  if (kyc.kycStatus === 'APPROVED') return 'Your account is fully verified — it is not pending. You can bid on loads and use every feature.';
  if (kyc.kycStatus === 'REJECTED') {
    return `Your KYC was rejected${kyc.kycRejectionReason ? ': ' + kyc.kycRejectionReason : '.'} Please re-upload the affected document(s) from the KYC & Documents tab.`;
  }
  if (kyc.kycDocumentsRequested) {
    return `Admin has requested an additional document from you: ${kyc.kycDocumentsRequested}. Please upload it from the KYC & Documents tab.`;
  }
  if (kyc.kycStatus === 'DRAFT') {
    const missing = kyc.missingDocuments && kyc.missingDocuments.length ? ` You still need to upload: ${kyc.missingDocuments.join(', ')}.` : '';
    return `Your account is pending because your KYC documents have not been submitted yet.${missing} Submit them from the KYC & Documents tab.`;
  }
  if (['SUBMITTED', 'PENDING_REVIEW'].includes(kyc.kycStatus)) {
    return 'Your account is pending because your KYC documents have been submitted and are currently under admin review. No action is needed from you right now.';
  }
  return `Your current KYC status is ${kyc.kycStatus}.`;
}

async function answerActiveBids(broker, repo) {
  const bids = await repo.getBids(broker, {});
  const active = (bids || []).filter((b) => ['SUBMITTED', 'SHORTLISTED'].includes(b.status));
  if (!active.length) return 'You have no active bids right now. Browse the Load Board or Load Matching tab to find loads to bid on.';
  const lines = active.slice(0, 8).map((b) => `• Load ${b.loadId}: ₹${b.bidAmount} — ${b.status}`);
  return `You have ${active.length} active bid(s):\n${lines.join('\n')}`;
}

async function answerNextSteps(broker, repo) {
  const [kyc, bids, shipments, loads] = await Promise.all([
    repo.getKycStatus(broker), repo.getBids(broker, {}), repo.getActiveShipments(broker), repo.getAvailableLoads(broker, {}),
  ]);
  if (kyc.kycStatus !== 'APPROVED') {
    if (kyc.missingDocuments && kyc.missingDocuments.length) {
      return `Your next step is to complete your KYC — you're still missing: ${kyc.missingDocuments.join(', ')}. Upload them from the KYC & Documents tab so you can start bidding.`;
    }
    return `Your KYC is ${kyc.kycStatus} — no action needed from you right now; you'll be notified once admin reviews it.`;
  }
  const activeBids = (bids || []).filter((b) => ['SUBMITTED', 'SHORTLISTED'].includes(b.status));
  if (!activeBids.length && loads && loads.length) {
    return `Your KYC is approved. You have no active bids — there are currently ${loads.length} open load(s) on the board. Try Load Matching to find the ones that best fit your saved routes.`;
  }
  if (activeBids.length) {
    return `You have ${activeBids.length} active bid(s) awaiting a decision — check My Bids for status updates.`;
  }
  if (shipments && shipments.length) {
    return `You have ${shipments.length} shipment(s) in progress — check My Shipments for the latest status.`;
  }
  return 'Your account is in good standing with nothing pending — browse the Load Board or Load Matching tab to find new opportunities.';
}

/**
 * Tries to answer `message` deterministically using ONLY the broker's own
 * real data (via `repo`, same shape as lib/brokerAiTools.js). Returns
 * {matched:false} when the question isn't one of the supported patterns —
 * the caller decides what to say in that case (never invents an answer to
 * an unsupported question).
 * @param {{broker:object, repo:object, message:string}} args
 */
async function answerDeterministically({ broker, repo, message }) {
  const kind = classify(message);
  if (!kind) return { matched: false };
  const handlers = {
    LOADS_FOR_ROUTES: answerLoadsForRoutes,
    MISSING_DOCUMENTS: answerMissingDocuments,
    ACCOUNT_PENDING: answerAccountPending,
    ACTIVE_BIDS: answerActiveBids,
    NEXT_STEPS: answerNextSteps,
  };
  try {
    const reply = await handlers[kind](broker, repo);
    return { matched: true, kind, reply };
  } catch (err) {
    return { matched: true, kind, reply: 'I could not find that information right now. Please try again in a moment.' };
  }
}

const SUPPORTED_QUESTIONS = [
  'Which loads match my routes?',
  'What documents are missing?',
  'Why is my account pending?',
  'Which bids are active?',
  'What should I do next?',
];

module.exports = { classify, answerDeterministically, SUPPORTED_QUESTIONS };
