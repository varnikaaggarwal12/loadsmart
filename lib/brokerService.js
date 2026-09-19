/**
 * lib/brokerService.js
 *
 * Pure, DB-free helpers for the Broker module — same contract as
 * lib/biddingEngine.js / lib/trustScore.js / lib/matchingEngine.js: plain
 * objects in, plain objects out, no Mongoose/Express/network access, so
 * every rule here is trivially unit-testable with `node --test` and safe to
 * call from any route without re-deriving the logic inline.
 *
 * Covers:
 *  - GST/MSME "independently optional" registration validation (spec
 *    sections 2-3: a broker is never rejected merely for not having GST or
 *    MSME — each is validated ONLY when its own hasGST/hasMSME flag is true).
 *  - KYC document-completeness checks (what's still missing before a
 *    broker's KYC can move to SUBMITTED).
 *  - Broker Risk Indicators (spec section 7C) — neutral, non-accusatory
 *    signals derived from real record fields, never a fraud accusation.
 *  - Broker Opportunity Radar scoring (spec section 7A/7B) — explainable
 *    load-to-preference matching using real load fields only.
 *  - Activity timeline formatting (spec section 7D).
 */

const GST_CODES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Format + ISO-7064-style mod-36 checksum check — same algorithm server_load.js already uses for every other role, duplicated here (not imported) so this module stays a standalone, dependency-free file like its siblings. */
function isValidGST(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = GST_CODES.indexOf(v[i]);
    const factor = (i % 2 === 0) ? 1 : 2;
    const val = code * factor;
    sum += Math.floor(val / 36) + (val % 36);
  }
  const checkDigit = GST_CODES[(36 - (sum % 36)) % 36];
  return checkDigit === v[14];
}
function normalizeGST(raw) {
  return String(raw || '').trim().toUpperCase();
}
function isValidPAN(v) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(v || '').toUpperCase());
}
// Same lenient presence+length check server_load.js uses for Carrier MSME —
// there is no one universal, stable MSME/Udyam format (old UAM vs new UDYAM
// schemes, plus state variants), so this only catches empty/too-short values.
function isValidMsme(v) {
  return String(v || '').trim().length >= 8;
}
function isValidPincode(v) {
  return /^[0-9]{6}$/.test(String(v || '').trim());
}

/**
 * Validates a broker registration payload against the conditional GST/MSME
 * rules (spec sections 2-3). Never requires GST or MSME themselves — only
 * requires their number+document WHEN the broker said they have one.
 *
 * @param {object} b raw broker registration payload
 * @returns {{valid:boolean, errors:Array<{field:string, code:string, message:string}>}}
 */
function validateBrokerRegistration(b) {
  const errors = [];
  const push = (field, code, message) => errors.push({ field, code, message });

  const fullName = String(b.contactPerson || b.fullName || '').trim();
  if (!fullName) push('contactPerson', 'full_name_required', 'Full name is required.');

  const brokerType = String(b.brokerType || '').trim().toLowerCase();
  if (!['individual', 'company'].includes(brokerType)) {
    push('brokerType', 'broker_type_required', 'Select whether you are registering as an Individual or a Company/Agency.');
  }
  if (brokerType === 'company' && !String(b.companyName || '').trim()) {
    push('companyName', 'company_name_required', 'Company/Agency name is required for a Company/Agency broker.');
  }

  const address = b.address || {};
  if (!String(address.addressLine || '').trim()) push('address.addressLine', 'address_required', 'Business address is required.');
  if (!String(address.city || '').trim()) push('address.city', 'city_required', 'City is required.');
  if (!String(address.state || '').trim()) push('address.state', 'state_required', 'State is required.');
  if (!isValidPincode(address.pincode)) push('address.pincode', 'invalid_pincode', 'Enter a valid 6-digit pincode.');

  // ---------- GST — independently optional ----------
  const hasGST = b.hasGST === true || b.hasGST === 'true';
  if (hasGST) {
    if (!isValidGST(b.gstNumber)) push('gstNumber', 'invalid_gst', 'Enter a valid GST number (format/checksum check failed).');
    if (!b.gstDocumentPath && !b.gstPhotoPath) push('gstDocumentPath', 'gst_document_required', 'Upload your GST certificate — required when you have GST.');
  }

  // ---------- MSME — independently optional ----------
  const hasMSME = b.hasMSME === true || b.hasMSME === 'true';
  if (hasMSME) {
    if (!isValidMsme(b.msmeNumber)) push('msmeNumber', 'invalid_msme', 'Enter a valid MSME/Udyam registration number.');
    if (!b.msmeDocumentPath && !b.msmePhotoPath) push('msmeDocumentPath', 'msme_document_required', 'Upload your MSME/Udyam certificate — required when you have MSME registration.');
  }

  // ---------- PAN — the one mandatory identity document ----------
  // GST and MSME are BOTH optional per spec, so PAN (same role shipper's
  // identity verification already leans on) is what keeps every broker
  // account backed by at least one verifiable identity document.
  if (!isValidPAN(b.panNumber)) push('panNumber', 'invalid_pan', 'Enter a valid PAN number.');
  if (!b.panDocumentPath) push('panDocumentPath', 'pan_document_required', 'Upload your PAN card.');

  // ---------- Bank details — unchanged from the existing Broker workflow ----------
  // Kept mandatory (not part of the new optional GST/MSME rules) because the
  // existing Admin Bank KYC verification screen already depends on every
  // Broker/Carrier record having these fields populated.
  if (!String(b.bankAccountHolder || '').trim()) push('bankAccountHolder', 'bank_account_holder_required', 'Bank account holder name is required.');
  if (!/^[0-9]{9,18}$/.test(String(b.bankAccountNumber || '').trim())) push('bankAccountNumber', 'invalid_bank_account_number', 'Enter a valid bank account number (9-18 digits).');
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(b.bankIfsc || '').toUpperCase())) push('bankIfsc', 'invalid_ifsc', 'Enter a valid IFSC code.');
  if (!String(b.bankName || '').trim()) push('bankName', 'bank_name_required', 'Bank name is required.');
  if (!['savings', 'current'].includes(b.bankAccountType)) push('bankAccountType', 'bank_account_type_required', 'Select an account type.');
  if (!b.bankProofPhotoPath) push('bankProofPhotoPath', 'bank_proof_required', 'Upload your bank proof document.');

  return { valid: errors.length === 0, errors };
}

/**
 * What KYC document categories are still outstanding for a broker record —
 * used by the "What documents are missing from my KYC?" AI tool and the
 * Broker dashboard's KYC checklist. Purely reads flags/paths already on the
 * record; never guesses.
 */
function missingKycDocuments(record) {
  const missing = [];
  if (!record.panDocumentPath) missing.push('PAN card');
  if (record.hasGST && !record.gstPhotoPath && !record.gstDocumentPath) missing.push('GST certificate');
  if (record.hasMSME && !record.msmePhotoPath && !record.msmeDocumentPath) missing.push('MSME/Udyam certificate');
  if (!record.bankProofPhotoPath) missing.push('Bank proof document');
  if (!record.addressProofPath) missing.push('Address proof (optional, recommended)');
  if (!record.profilePhotoPath) missing.push('Profile photo (optional, recommended)');
  return missing;
}

const KYC_STATUSES = ['DRAFT', 'SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'];

/** kycStatus -> the legacy account `status` field it should be kept in sync with, so every existing screen that already reads `status` keeps working unchanged. */
function kycStatusToAccountStatus(kycStatus) {
  if (kycStatus === 'APPROVED') return 'accepted';
  if (kycStatus === 'REJECTED') return 'rejected';
  return 'pending'; // DRAFT, SUBMITTED, PENDING_REVIEW
}
/** The reverse mapping — used only so the OLD generic /api/registrations/broker/:id/status endpoint (still supported) keeps kycStatus from silently drifting out of sync when an admin uses it instead of the new /api/admin/brokers/:id/kyc-status endpoint. */
function accountStatusToKycStatus(status) {
  if (status === 'accepted') return 'APPROVED';
  if (status === 'rejected') return 'REJECTED';
  return 'PENDING_REVIEW';
}

/**
 * Broker Risk Indicators (spec section 7C) — transparent, neutral-language
 * signals only. Never labels an account "fraudulent"; every message uses
 * the neutral vocabulary the spec explicitly asks for.
 * @returns {Array<{key:string, severity:'info'|'warning', message:string}>}
 */
function computeRiskIndicators(record, stats = {}) {
  const indicators = [];
  if (record.kycStatus !== 'APPROVED') {
    indicators.push({ key: 'KYC_NOT_APPROVED', severity: 'warning', message: 'Verification pending — your KYC has not been approved yet.' });
  }
  const missing = missingKycDocuments(record).filter((m) => !m.includes('(optional'));
  if (missing.length) {
    indicators.push({ key: 'MISSING_DOCUMENTS', severity: 'warning', message: `Missing document${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` });
  }
  if (record.hasGST && !record.gstVerified) {
    indicators.push({ key: 'GST_UNVERIFIED', severity: 'info', message: 'GST details need review — additional information may be required.' });
  }
  if (record.hasMSME && String(record.msmeNumber || '').trim().length < 8) {
    indicators.push({ key: 'MSME_UNVERIFIED', severity: 'info', message: 'MSME/Udyam details need review — additional information may be required.' });
  }
  if (Number(stats.cancelledCount) > 0 && Number(stats.cancelledCount) >= Number(stats.completedCount || 0)) {
    indicators.push({ key: 'REPEATED_CANCELLATIONS', severity: 'warning', message: 'Recent activity shows repeated cancellations — needs review.' });
  }
  if (Number(stats.delayedCount) > 0) {
    indicators.push({ key: 'DELAYED_LOADS', severity: 'info', message: `${stats.delayedCount} of your shipment(s) reported a delay — needs review.` });
  }
  if (Number(stats.openComplaints) > 0) {
    indicators.push({ key: 'OPEN_COMPLAINTS', severity: 'warning', message: 'You have unresolved support complaints on file — needs review.' });
  }
  if (!indicators.length) {
    indicators.push({ key: 'ALL_CLEAR', severity: 'info', message: 'No outstanding issues found on your account right now.' });
  }
  return indicators;
}

/**
 * Broker Opportunity Radar (spec section 7A/7B) — scores currently
 * available (BIDDING_OPEN) loads against the broker's own stated
 * preferences (or, absent preferences, their own recent activity), using
 * only fields the load/broker records genuinely have. Never invents an
 * opportunity that doesn't exist in `loads`.
 *
 * @param {object} preferences {preferredOrigins:[string], preferredDestinations:[string], preferredTruckTypes:[string], preferredLoadCategories:[string]}
 * @param {Array<object>} loads plain BookingRequest-shaped objects (loadStage BIDDING_OPEN)
 * @returns {Array<{tokenNo, score, reasons:string[]}>} sorted best-first
 */
function scoreOpportunities(preferences, loads) {
  const prefs = preferences || {};
  const origins = (prefs.preferredOrigins || []).map((s) => String(s).toLowerCase());
  const destinations = (prefs.preferredDestinations || []).map((s) => String(s).toLowerCase());
  const truckTypes = (prefs.preferredTruckTypes || []).map((s) => String(s).toLowerCase());
  const categories = (prefs.preferredLoadCategories || []).map((s) => String(s).toLowerCase());

  const scored = (loads || []).map((load) => {
    let score = 40; // baseline: it's a real, currently open opportunity
    const reasons = [];

    const pickup = String(load.pickup || '').toLowerCase();
    const destination = String(load.destination || '').toLowerCase();
    if (origins.some((o) => o && pickup.includes(o))) { score += 20; reasons.push('Pickup route matches your preferred origin.'); }
    if (destinations.some((d) => d && destination.includes(d))) { score += 20; reasons.push('Destination matches your preferred route.'); }

    const truckType = String(load.requiredTruckType || '').toLowerCase();
    if (!truckType) { score += 5; reasons.push('No specific truck type required — broadly compatible.'); }
    else if (truckTypes.some((t) => t && truckType.includes(t))) { score += 15; reasons.push('Suitable truck type is available for this load.'); }

    const material = String(load.material || '').toLowerCase();
    if (categories.some((c) => c && material.includes(c))) { score += 10; reasons.push('Load category matches your preferred cargo type.'); }

    if (load.pickupDateTime) {
      const pickupTime = new Date(load.pickupDateTime).getTime();
      if (Number.isFinite(pickupTime) && pickupTime > Date.now()) {
        score += 5;
        reasons.push('Pickup date is compatible with an upcoming window.');
      }
    }
    if (Number(load.bidCount) > 0) {
      reasons.push(`${load.bidCount} carrier bid(s) already active — competitive interest on this lane.`);
    }
    if (!reasons.length) reasons.push('Currently open for bidding on Load Smart.');

    return { tokenNo: load.tokenNo, score: Math.min(100, score), reasons };
  });
  scored.sort((a, c) => c.score - a.score);
  return scored;
}

/**
 * Formats a mixed list of ActivityLog + TrackingEvent + Notification-shaped
 * rows into one chronological Broker Activity Timeline (spec section 7D).
 * Pure formatting only — callers fetch the raw rows from Mongo and hand
 * them in here already merged.
 */
function buildActivityTimeline(rawEvents) {
  return (rawEvents || [])
    .map((e) => ({
      at: e.at || e.createdAt || e.timestamp,
      label: e.label || e.action || e.title || e.type || 'Activity',
      detail: e.detail || e.message || e.notes || '',
      source: e.source || 'system',
    }))
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

module.exports = {
  isValidGST,
  normalizeGST,
  isValidPAN,
  isValidMsme,
  isValidPincode,
  validateBrokerRegistration,
  missingKycDocuments,
  KYC_STATUSES,
  kycStatusToAccountStatus,
  accountStatusToKycStatus,
  computeRiskIndicators,
  scoreOpportunities,
  buildActivityTimeline,
};
