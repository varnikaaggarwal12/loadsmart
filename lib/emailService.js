/**
 * lib/emailService.js
 *
 * Centralized email service for the whole application — every "send an
 * email when X happens" call anywhere in server_load.js goes through one
 * of the named functions below instead of writing provider code inline in
 * a route. This file itself never talks to SMTP/Resend/SendGrid directly —
 * it renders content (lib/emailTemplates.js) and hands it to the queue
 * (lib/emailQueue.js), which is what actually calls the provider
 * (lib/emailProvider.js), retries failures, and de-duplicates.
 *
 * Layered architecture (spec):
 *   route handler -> DB write confirmed -> emailService.sendXxxEmail(...)
 *     -> emailQueue.enqueue() [writes PENDING EmailLog row, returns fast]
 *     -> emailQueue worker -> emailProvider.send() -> SENT/FAILED
 *
 * Every function here is failure-isolated and non-blocking: it resolves
 * almost immediately (the EmailLog row write is the only awaited DB call)
 * and NEVER throws, so a caller can always do
 *   emailService.sendXxxEmail(...).catch(()=>{});
 * or even call it un-awaited, without risking the surrounding database
 * transaction. This is also why every email-triggering call site in
 * server_load.js is placed AFTER its `await record.save()` / `.create()`
 * succeeds — never before (spec: "If the DB operation fails, do NOT send
 * the email").
 */
const templates = require('./emailTemplates');
const emailQueue = require('./emailQueue');

/** Kept for backward compatibility with any code still calling
 * emailService.init(transporter, from) directly — forwards to the real
 * provider abstraction. New code should call emailProvider.init() itself
 * (see server_load.js's startup block). */
function init(mailTransporter, from) {
  require('./emailProvider').init({ transporter: mailTransporter, from });
}

function block(...lines) {
  return lines.filter((l) => l !== null && l !== undefined).join('\n');
}

/**
 * Legacy low-level send — every one of the ~20 plain functions further
 * down funnels through this. Wraps the plain-text body in the branded HTML
 * shell and hands it to the queue (idempotency key = event + loadId + to).
 */
async function send({ to, subject, text, event, loadId, userId = '', userRole = '' }) {
  if (!to) {
    console.log(`[EMAIL SKIPPED — no recipient address on file] ${event} (${loadId || 'n/a'})`);
    return { sent: false, reason: 'no_recipient' };
  }
  const { html, text: plainText } = templates.render({ title: subject, intro: text });
  const result = await emailQueue.enqueue({
    to, subject, html, text: plainText,
    eventType: event, entityType: 'Load', entityId: loadId || '', userId, userRole,
  });
  return { sent: result.queued, ...result };
}

/**
 * Rich, templated send used by every NEW event type below — same
 * queue/idempotency guarantees as send(), plus real fields/CTA rendering.
 */
async function sendTemplated({
  to, event, entityType = 'Load', entityId = '', userId = '', userRole = '',
  title, preheader = '', intro = '', fields = [], statusLabel = '', ctaLabel = '', ctaPath = '', footerNote = '', subject,
}) {
  if (!to) {
    console.log(`[EMAIL SKIPPED — no recipient address on file] ${event} (${entityId || 'n/a'})`);
    return { sent: false, reason: 'no_recipient' };
  }
  const ctaUrl = ctaPath ? templates.appLink(ctaPath) : '';
  const { html, text } = templates.render({ title, preheader, intro, fields, statusLabel, ctaLabel, ctaUrl, footerNote });
  const result = await emailQueue.enqueue({
    to, subject: subject || title, html, text,
    eventType: event, entityType, entityId, userId, userRole,
  });
  return { sent: result.queued, ...result };
}

// =====================================================================
// ---------- 1. Load posted (legacy plain-text, kept as-is) ----------
// =====================================================================
async function sendLoadPostedEmail({ to, tokenNo }) {
  return send({
    to, event: 'LOAD_POSTED', loadId: tokenNo,
    subject: `Load ${tokenNo} submitted — pending admin approval`,
    text: block(
      `Your load ${tokenNo} has been successfully submitted and is pending admin approval.`,
      '',
      'We will email you the moment it is reviewed.',
    ),
  });
}

async function sendNewLoadAdminAlertEmail({ to, tokenNo, companyName, pickup, destination, material, weight }) {
  return send({
    to, event: 'LOAD_POSTED_ADMIN_ALERT', loadId: tokenNo,
    subject: `New load ${tokenNo} waiting for approval`,
    text: block(
      `A new load is waiting for admin approval on Load Smart.`,
      '',
      `Load ID: ${tokenNo}`,
      `Shipper: ${companyName || '—'}`,
      `Pickup: ${pickup || '—'}`,
      `Destination: ${destination || '—'}`,
      `Material: ${material || '—'}`,
      `Weight: ${weight != null ? weight + ' tons' : '—'}`,
    ),
  });
}

// ---------- 2. Admin approval ----------
async function sendLoadApprovedEmail({ to, tokenNo }) {
  return send({
    to, event: 'LOAD_APPROVED', loadId: tokenNo,
    subject: `Load ${tokenNo} has been approved`,
    text: `Your load ${tokenNo} has been approved.`,
  });
}

async function sendLoadRejectedEmail({ to, tokenNo, reason }) {
  return send({
    to, event: 'LOAD_REJECTED', loadId: tokenNo,
    subject: `Load ${tokenNo} was not approved`,
    text: block(
      `Your load ${tokenNo} was rejected by our admin team.`,
      '',
      `Reason: ${reason || 'Not specified.'}`,
    ),
  });
}

// ---------- Broker module: KYC status change ----------
// Sent whenever admin changes a Broker's kycStatus (spec section 10) — one
// email per actual change, since the route calling this only invokes it
// when the new status differs from the old one (no duplicate emails on a
// no-op update).
async function sendBrokerKycStatusEmail({ to, brokerName, kycStatus, reason }) {
  const titleByStatus = {
    APPROVED: 'Your Broker KYC has been approved',
    REJECTED: 'Your Broker KYC was rejected',
    PENDING_REVIEW: 'Your Broker KYC is under review',
    SUBMITTED: 'Your Broker KYC documents were received',
  };
  return send({
    to, event: 'BROKER_KYC_STATUS_CHANGED', userRole: 'broker',
    subject: titleByStatus[kycStatus] || `Your Broker KYC status is now ${kycStatus}`,
    text: block(
      `Hi ${brokerName || 'there'},`,
      '',
      titleByStatus[kycStatus] || `Your Broker KYC status is now ${kycStatus}.`,
      kycStatus === 'REJECTED' && reason ? `\nReason: ${reason}` : null,
      '',
      'You can review your KYC status any time from your Broker Dashboard.',
    ),
  });
}

async function sendBrokerDocumentsRequestedEmail({ to, brokerName, message }) {
  return send({
    to, event: 'BROKER_DOCUMENTS_REQUESTED', userRole: 'broker',
    subject: 'Load Smart needs more documents from you',
    text: block(
      `Hi ${brokerName || 'there'},`,
      '',
      'Our admin team needs some additional information/documents to complete your KYC review:',
      '',
      message,
      '',
      'Please upload them from your Broker Dashboard as soon as you can.',
    ),
  });
}

// ---------- 3. Driver / carrier assignment ----------
async function sendDriverAssignedEmail({ to, tokenNo, pickup, destination, material, weight, vehicleNumber, companyName }) {
  return sendTemplated({
    to, event: 'DRIVER_ASSIGNED', entityType: 'Load', entityId: tokenNo, userRole: 'driver',
    title: `Driver Assigned – LoadSmart`,
    subject: `Driver Assigned – LoadSmart (Load ${tokenNo})`,
    statusLabel: 'DRIVER ASSIGNED',
    intro: `You have been assigned Load ${tokenNo}. Please review the details below and accept or reject the assignment from your Driver Dashboard.`,
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Drop', destination],
      ['Material', material],
      ['Weight', weight != null ? `${weight} tons` : ''],
      ['Vehicle', vehicleNumber],
      ['Shipper', companyName],
    ],
    ctaLabel: 'View Assignment',
    ctaPath: '/driver/dashboard',
    footerNote: 'Please open your Driver Dashboard to accept or reject this load.',
  });
}

async function sendDriverAssignedShipperEmail({ to, tokenNo, driverName, vehicleNumber }) {
  return sendTemplated({
    to, event: 'DRIVER_ASSIGNED_SHIPPER', entityType: 'Load', entityId: tokenNo, userRole: 'shipper',
    title: `A driver has been assigned to your load`,
    subject: `Driver assigned to your load ${tokenNo}`,
    statusLabel: 'DRIVER ASSIGNED',
    intro: `A driver has been assigned to your load ${tokenNo}.`,
    fields: [
      ['Load ID', tokenNo],
      ['Driver', driverName],
      ['Vehicle', vehicleNumber],
    ],
    ctaLabel: 'View Load',
    ctaPath: `/portal/shipper/live-tracking?token=${encodeURIComponent(tokenNo)}`,
  });
}

// ---------- 5. Driver accept / reject ----------
async function sendDriverAcceptedEmail({ to, tokenNo }) {
  return send({
    to, event: 'DRIVER_ACCEPTED', loadId: tokenNo,
    subject: `Driver accepted Load ${tokenNo}`,
    text: `The assigned driver has accepted Load ${tokenNo}. Pickup is being arranged.`,
  });
}

async function sendDriverRejectedEmail({ to, tokenNo, reason }) {
  return send({
    to, event: 'DRIVER_REJECTED', loadId: tokenNo,
    subject: `Driver rejected assignment for Load ${tokenNo}`,
    text: block(
      `The driver assigned to Load ${tokenNo} has rejected the assignment.`,
      reason ? `Reason: ${reason}` : null,
      'Please assign another driver from the Fleet page.',
    ),
  });
}

// ---------- 6-8. Manual tracking / checkpoint ----------
async function sendTripStartedEmail({ to, tokenNo, location }) {
  return send({
    to, event: 'TRIP_STARTED', loadId: tokenNo,
    subject: `Load ${tokenNo} — trip started`,
    text: `Load ${tokenNo} is now in transit.${location ? ` Starting point: ${location}.` : ''}`,
  });
}

async function sendPickupReachedEmail({ to, tokenNo, location }) {
  return send({
    to, event: 'PICKUP_REACHED', loadId: tokenNo,
    subject: `Load ${tokenNo} — driver reached pickup`,
    text: `The driver has reached the pickup location for Load ${tokenNo}.${location ? ` Location: ${location}.` : ''}`,
  });
}

// New (manual digital trip-tracking milestone expansion): the driver has
// physically left the pickup location — one step before live GPS tracking
// begins (sendTripStartedEmail above stays the "now in transit" email).
async function sendDepartedPickupEmail({ to, tokenNo, location }) {
  return send({
    to, event: 'DEPARTED_PICKUP', loadId: tokenNo,
    subject: `Load ${tokenNo} — departed pickup location`,
    text: `The driver has departed the pickup location for Load ${tokenNo}.${location ? ` Location: ${location}.` : ''}`,
  });
}

async function sendCheckpointUpdateEmail({ to, tokenNo, location, notes }) {
  return send({
    to, event: 'CHECKPOINT_UPDATE', loadId: tokenNo,
    subject: `Load ${tokenNo} — checkpoint update`,
    text: block(
      `Load ${tokenNo} reached a new checkpoint.`,
      location ? `Location: ${location}` : null,
      notes ? `Notes: ${notes}` : null,
    ),
  });
}

// ---------- 9. Delay ----------
async function sendDelayNotificationEmail({ to, tokenNo, location, reason, expectedDelay }) {
  return send({
    to, event: 'DELAY_REPORTED', loadId: tokenNo,
    subject: `Load ${tokenNo} has been delayed`,
    text: block(
      `Load ${tokenNo} has been delayed.`,
      `Current Location: ${location || '—'}`,
      `Reason: ${reason || '—'}`,
      expectedDelay ? `Expected Delay: ${expectedDelay}` : null,
    ),
  });
}

// ---------- 10. Destination reached ----------
async function sendDestinationReachedEmail({ to, tokenNo, vehicleNumber, driverName, arrivalTime }) {
  return send({
    to, event: 'DESTINATION_REACHED', loadId: tokenNo,
    subject: `Load ${tokenNo} has reached the destination`,
    text: block(
      `Load ${tokenNo} has reached the destination.`,
      vehicleNumber ? `Vehicle: ${vehicleNumber}` : null,
      driverName ? `Driver: ${driverName}` : null,
      `Arrival Time: ${arrivalTime ? new Date(arrivalTime).toLocaleString() : new Date().toLocaleString()}`,
    ),
  });
}

async function sendUnloadingStartedEmail({ to, tokenNo }) {
  return send({
    to, event: 'UNLOADING_STARTED', loadId: tokenNo,
    subject: `Load ${tokenNo} — unloading started`,
    text: `Unloading has started for Load ${tokenNo}.`,
  });
}

// New (manual digital trip-tracking milestone expansion): unloading is
// physically finished — one step before the driver confirms delivery with
// receiver details (sendDeliveryCompletedEmail below stays that final step).
async function sendUnloadingCompletedEmail({ to, tokenNo }) {
  return send({
    to, event: 'UNLOADING_COMPLETED', loadId: tokenNo,
    subject: `Load ${tokenNo} — unloading completed`,
    text: `Unloading has been completed for Load ${tokenNo}. Awaiting delivery confirmation.`,
  });
}

// ---------- 11. Delivery ----------
async function sendDeliveryCompletedEmail({ to, tokenNo, deliveryDate, receiverName }) {
  return send({
    to, event: 'DELIVERY_COMPLETED', loadId: tokenNo,
    subject: `Load ${tokenNo} has been delivered`,
    text: block(
      `Load ${tokenNo} has been marked as delivered.`,
      `Delivery Date: ${deliveryDate ? new Date(deliveryDate).toLocaleString() : new Date().toLocaleString()}`,
      receiverName ? `Received by: ${receiverName}` : null,
      'A Proof of Delivery (POD) is required to fully complete this load.',
    ),
  });
}

// ---------- 12-14. POD ----------
async function sendPODUploadedEmail({ to, tokenNo }) {
  return send({
    to, event: 'POD_UPLOADED', loadId: tokenNo,
    subject: `POD uploaded for Load ${tokenNo}`,
    text: `Proof of Delivery has been uploaded for Load ${tokenNo} and is awaiting admin approval.`,
  });
}

async function sendPODApprovedEmail({ to, tokenNo }) {
  return send({
    to, event: 'POD_APPROVED', loadId: tokenNo,
    subject: `POD approved for Load ${tokenNo}`,
    text: `The Proof of Delivery for Load ${tokenNo} has been approved.`,
  });
}

async function sendPODRejectedEmail({ to, tokenNo, reason }) {
  return send({
    to, event: 'POD_REJECTED', loadId: tokenNo,
    subject: `POD rejected for Load ${tokenNo}`,
    text: block(
      `The Proof of Delivery uploaded for Load ${tokenNo} was rejected.`,
      reason ? `Reason: ${reason}` : null,
      'Please upload a corrected POD from your Driver Dashboard.',
    ),
  });
}

// ---------- 14. Completion ----------
async function sendLoadCompletedShipperEmail({ to, tokenNo, driverName, vehicleNumber, pickup, destination, deliveryDate }) {
  return send({
    to, event: 'LOAD_COMPLETED_SHIPPER', loadId: tokenNo,
    subject: `Load ${tokenNo} has been successfully delivered and completed`,
    text: block(
      `Load ${tokenNo} has been successfully delivered and completed.`,
      driverName ? `Driver: ${driverName}` : null,
      vehicleNumber ? `Vehicle: ${vehicleNumber}` : null,
      `Pickup: ${pickup || '—'}`,
      `Destination: ${destination || '—'}`,
      `Delivery Date: ${deliveryDate ? new Date(deliveryDate).toLocaleString() : '—'}`,
      'POD: Approved',
    ),
  });
}

async function sendLoadCompletedDriverEmail({ to, tokenNo }) {
  return send({
    to, event: 'LOAD_COMPLETED_DRIVER', loadId: tokenNo,
    subject: `Load ${tokenNo} completed`,
    text: block(
      `Load ${tokenNo} has been successfully completed.`,
      'Your delivery and POD have been approved.',
    ),
  });
}

// =====================================================================
// ---------- NEW: full email-notification-system event types ----------
// =====================================================================

// ---------- LoadCreated -> notify matching carriers (spec section 2) ----------
async function sendCarrierNewLoadEmail({
  to, tokenNo, pickup, destination, pickupDateTime, deliveryDeadline, material, weight,
  requiredTruckType, distanceKm, estimatedRate,
}) {
  return sendTemplated({
    to, event: 'LOAD_CREATED_CARRIER_ALERT', entityType: 'Load', entityId: tokenNo, userRole: 'carrier',
    title: 'New Load Available – LoadSmart',
    subject: `New Load Available – LoadSmart (${tokenNo})`,
    intro: `A new load matching your fleet's truck type has just been posted.`,
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Drop', destination],
      ['Pickup Date/Time', pickupDateTime ? new Date(pickupDateTime).toLocaleString() : ''],
      ['Delivery Deadline', deliveryDeadline ? new Date(deliveryDeadline).toLocaleString() : ''],
      ['Material', material],
      ['Weight', weight != null ? `${weight} tons` : ''],
      ['Truck Type Required', requiredTruckType],
      ['Distance', distanceKm != null ? `${distanceKm} km` : ''],
      ['Price / Budget', estimatedRate != null ? `₹${estimatedRate}` : ''],
    ],
    ctaLabel: 'View Load',
    ctaPath: `/portal/carrier/loads?token=${encodeURIComponent(tokenNo)}`,
  });
}

// ---------- TruckCreated -> notify shippers/brokers with matching loads (spec section 3) ----------
async function sendShipperNewTruckMatchEmail({
  to, tokenNo, truckType, vehicleNumberMasked, capacityTons, currentLocation, availableFrom,
}) {
  return sendTemplated({
    to, event: 'TRUCK_CREATED_SHIPPER_ALERT', entityType: 'Load', entityId: tokenNo, userRole: 'shipper',
    title: 'A Matching Truck Was Just Added – LoadSmart',
    subject: `A matching truck is now available for your load ${tokenNo}`,
    intro: `A carrier just added a truck that matches your posted load ${tokenNo}.`,
    fields: [
      ['Load ID', tokenNo],
      ['Truck Type', truckType],
      ['Vehicle Number', vehicleNumberMasked],
      ['Capacity', capacityTons != null ? `${capacityTons} tons` : ''],
      ['Current Location', currentLocation],
      ['Available From', availableFrom ? new Date(availableFrom).toLocaleDateString() : ''],
    ],
    ctaLabel: 'View Match',
    ctaPath: `/portal/shipper/live-tracking?token=${encodeURIComponent(tokenNo)}`,
  });
}

// ---------- LoadMatched / TruckMatched -> score-gated "Perfect Match" pair (spec sections 4-6) ----------
// One shared pair of functions used for BOTH directions (a load finding its
// truck, or a truck finding its load) — the direction only changes which
// side triggered the scan, never the shape of the two emails sent.
async function sendPerfectMatchShipperEmail({
  to, tokenNo, pickup, destination, requiredTruckType, matchedTruckType, carrierName,
  capacityTons, currentLocation, matchScore, matchTierLabel, reasonText,
}) {
  return sendTemplated({
    to, event: 'LOAD_TRUCK_MATCHED_SHIPPER', entityType: 'Load', entityId: tokenNo, userRole: 'shipper',
    title: 'Perfect Truck Match Found for Your Load – LoadSmart',
    subject: 'Perfect Truck Match Found for Your Load – LoadSmart',
    statusLabel: matchTierLabel,
    intro: reasonText || `We found a strong truck match for your load ${tokenNo}.`,
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Drop', destination],
      ['Required Truck Type', requiredTruckType],
      ['Matched Truck Type', matchedTruckType],
      ['Carrier', carrierName],
      ['Capacity', capacityTons != null ? `${capacityTons} tons` : ''],
      ['Truck Location', currentLocation],
      ['Match Score', matchScore != null ? `${matchScore}/100 (${matchTierLabel})` : ''],
    ],
    ctaLabel: 'Review Match',
    ctaPath: `/portal/shipper/live-tracking?token=${encodeURIComponent(tokenNo)}`,
  });
}

async function sendNewLoadMatchCarrierEmail({
  to, tokenNo, pickup, destination, material, weight, requiredTruckType,
  pickupDateTime, estimatedRate, matchScore, matchTierLabel, reasonText,
}) {
  return sendTemplated({
    to, event: 'LOAD_TRUCK_MATCHED_CARRIER', entityType: 'Load', entityId: tokenNo, userRole: 'carrier',
    title: 'New Load Match Found for Your Truck – LoadSmart',
    subject: 'New Load Match Found for Your Truck – LoadSmart',
    statusLabel: matchTierLabel,
    intro: reasonText || `We found a load that's a strong fit for one of your trucks.`,
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Drop', destination],
      ['Material', material],
      ['Weight', weight != null ? `${weight} tons` : ''],
      ['Truck Type Required', requiredTruckType],
      ['Expected Pickup Date', pickupDateTime ? new Date(pickupDateTime).toLocaleString() : ''],
      ['Estimated Price', estimatedRate != null ? `₹${estimatedRate}` : ''],
      ['Match Score', matchScore != null ? `${matchScore}/100 (${matchTierLabel})` : ''],
    ],
    ctaLabel: 'View Load',
    ctaPath: `/portal/carrier/loads?token=${encodeURIComponent(tokenNo)}`,
  });
}

// ---------- Assignment confirmation (spec section 7) ----------
// notifyDriverAssigned() in server_load.js already emails driver + shipper
// via sendDriverAssignedEmail/sendDriverAssignedShipperEmail above; this
// fills the one gap the spec explicitly calls out — the CARRIER (whose
// truck/driver just got booked) previously received no email of their own.
async function sendAssignmentConfirmedCarrierEmail({ to, tokenNo, shipperName, pickup, destination, driverName, vehicleNumber, statusLabel }) {
  return sendTemplated({
    to, event: 'ASSIGNMENT_CONFIRMED_CARRIER', entityType: 'Load', entityId: tokenNo, userRole: 'carrier',
    title: 'Load Assignment Confirmed – LoadSmart',
    subject: `Load Assignment Confirmed – LoadSmart (${tokenNo})`,
    statusLabel: statusLabel || 'ASSIGNED',
    intro: `Your truck and driver have been confirmed for Load ${tokenNo}.`,
    fields: [
      ['Load ID', tokenNo],
      ['Shipper', shipperName],
      ['Pickup', pickup],
      ['Drop', destination],
      ['Driver', driverName],
      ['Vehicle', vehicleNumber],
    ],
    ctaLabel: 'View Load',
    ctaPath: `/portal/carrier/loads?token=${encodeURIComponent(tokenNo)}`,
  });
}

// =====================================================================
// ---------- Broker Automation: Save Load / Truck Match / Connection ----------
// One shared, richly-templated sender for every connection-workflow status
// notification (spec section 5) — same sendTemplated plumbing (queue,
// idempotency, retry) as everything else in this file, just parameterized
// by role/event so six near-identical status emails don't need six
// near-identical function bodies. Each PUBLIC function below still has its
// own name/signature so call sites in server_load.js stay self-documenting.
async function sendBrokerConnectionEvent({
  to, event, userRole, title, subject, statusLabel, intro, fields, ctaPath, footerNote,
}) {
  return sendTemplated({
    to, event, entityType: 'Load', entityId: fields && (fields.find((f) => f[0] === 'Load ID') || [])[1], userRole,
    title, subject: subject || title, statusLabel, intro, fields,
    ctaLabel: ctaPath ? 'Open Dashboard' : '', ctaPath, footerNote,
  });
}

/** Carrier notification: "A Broker saves a load for them" (spec section 5, Carrier notifications). */
async function sendLoadSavedForCarrierEmail({ to, carrierName, tokenNo, pickup, destination, brokerCompanyName, requiredTruckType }) {
  return sendBrokerConnectionEvent({
    to, event: 'LOAD_SAVED_FOR_CARRIER', userRole: 'carrier',
    title: `LoadSmart: A Load Was Saved For You (${tokenNo})`,
    statusLabel: 'SAVED FOR YOU',
    intro: `Hi ${carrierName || 'there'}, your broker${brokerCompanyName ? ` (${brokerCompanyName})` : ''} has shortlisted a load that may suit your fleet.`,
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Delivery', destination],
      ['Truck Type', requiredTruckType],
      ['Status', 'Saved — awaiting a truck match'],
    ],
    ctaPath: '/portal/carrier',
    footerNote: 'This is a shortlist only — nothing has been booked or committed yet.',
  });
}

/** Broker notification: "A suitable truck is found" (spec section 5, Broker notifications) — matches the exact example subject/body format in the spec. */
async function sendSuitableTruckFoundEmail({ to, tokenNo, pickup, destination, truckType, vehicleNumber }) {
  return sendBrokerConnectionEvent({
    to, event: 'SUITABLE_TRUCK_FOUND', userRole: 'broker',
    title: `Suitable Truck Found for Load ${tokenNo}`,
    intro: 'A suitable truck has been identified for your selected load.',
    statusLabel: 'AWAITING CONFIRMATION',
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Delivery', destination],
      ['Truck Type', truckType],
      ['Vehicle', vehicleNumber],
      ['Status', 'Awaiting confirmation'],
    ],
    ctaPath: '/broker-dashboard',
    footerNote: 'Please open your LoadSmart dashboard to review the details.',
  });
}

/** Carrier notification: a broker matched one of the carrier's own trucks to a load. */
async function sendCarrierTruckMatchedEmail({ to, carrierName, tokenNo, pickup, destination, vehicleNumber, brokerCompanyName }) {
  return sendBrokerConnectionEvent({
    to, event: 'CARRIER_TRUCK_MATCHED', userRole: 'carrier',
    title: `LoadSmart: Your Truck Was Matched to Load ${tokenNo}`,
    statusLabel: 'TRUCK MATCHED',
    intro: `Hi ${carrierName || 'there'}, your broker${brokerCompanyName ? ` (${brokerCompanyName})` : ''} matched your vehicle ${vehicleNumber || ''} to a load.`,
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Delivery', destination],
      ['Vehicle', vehicleNumber],
      ['Status', 'Matched — connection may follow'],
    ],
    ctaPath: '/portal/carrier',
  });
}

/** Shipper notification: a broker has requested to connect a carrier to their load (spec section 5, Shipper notifications: "A Broker requests a connection regarding their load"). */
async function sendShipperConnectionRequestEmail({ to, tokenNo, pickup, destination, carrierCompanyName, brokerCompanyName }) {
  return sendBrokerConnectionEvent({
    to, event: 'SHIPPER_CONNECTION_REQUESTED', userRole: 'shipper',
    title: `LoadSmart: A Carrier Connection Was Requested for Load ${tokenNo}`,
    statusLabel: 'CONNECTION REQUESTED',
    intro: `${brokerCompanyName || 'A broker'} has requested to connect carrier ${carrierCompanyName || ''} to your load. No commitment has been made — you choose whether to proceed.`,
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Delivery', destination],
      ['Carrier', carrierCompanyName],
      ['Requested by', brokerCompanyName],
      ['Status', 'Pending your review'],
    ],
    ctaPath: '/portal/shipper',
    footerNote: 'Open your dashboard to compare this and any other offers before deciding.',
  });
}

/** Carrier notification: a broker has requested to connect them with a shipper's load (spec section 5, Carrier notifications: "A Shipper connection is requested"). */
async function sendCarrierConnectionRequestEmail({ to, carrierName, tokenNo, pickup, destination, shipperCompanyName, brokerCompanyName }) {
  return sendBrokerConnectionEvent({
    to, event: 'CARRIER_CONNECTION_REQUESTED', userRole: 'carrier',
    title: `LoadSmart: A Shipper Connection Was Requested for Load ${tokenNo}`,
    statusLabel: 'CONNECTION REQUESTED',
    intro: `Hi ${carrierName || 'there'}, your broker${brokerCompanyName ? ` (${brokerCompanyName})` : ''} has requested to connect you with a shipper's load.`,
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Delivery', destination],
      ['Shipper', shipperCompanyName],
      ['Requested by', brokerCompanyName],
      ['Status', 'Pending — no commitment yet'],
    ],
    ctaPath: '/portal/carrier',
  });
}

/**
 * Generic connection-status-change notifier — covers "negotiating",
 * "approved", "rejected", "cancelled" and "expired" for whichever of
 * broker/carrier/shipper needs to hear about it (spec section 5's
 * "A bid or negotiation changes" / "A Carrier accepts or rejects a
 * connection" / "A shipment is successfully assigned" events).
 */
async function sendConnectionStatusChangedEmail({ to, toRole, tokenNo, pickup, destination, status, note }) {
  const STATUS_TITLES = {
    negotiating: 'Negotiation Started',
    approved: 'Connection Approved',
    rejected: 'Connection Not Selected',
    cancelled: 'Connection Cancelled',
    expired: 'Connection Request Expired',
  };
  const label = STATUS_TITLES[status] || `Connection Update: ${status}`;
  return sendBrokerConnectionEvent({
    to, event: 'CONNECTION_STATUS_CHANGED', userRole: toRole,
    title: `LoadSmart: ${label} — Load ${tokenNo}`,
    statusLabel: String(status || '').toUpperCase(),
    intro: note || `The connection request for load ${tokenNo} is now: ${status}.`,
    fields: [
      ['Load ID', tokenNo],
      ['Pickup', pickup],
      ['Delivery', destination],
      ['Status', status],
    ],
    ctaPath: toRole === 'broker' ? '/broker-dashboard' : `/portal/${toRole}`,
  });
}

module.exports = {
  init,
  sendLoadPostedEmail,
  sendNewLoadAdminAlertEmail,
  sendLoadApprovedEmail,
  sendLoadRejectedEmail,
  sendDriverAssignedEmail,
  sendDriverAssignedShipperEmail,
  sendDriverAcceptedEmail,
  sendDriverRejectedEmail,
  sendTripStartedEmail,
  sendPickupReachedEmail,
  sendDepartedPickupEmail,
  sendCheckpointUpdateEmail,
  sendDelayNotificationEmail,
  sendDestinationReachedEmail,
  sendUnloadingStartedEmail,
  sendUnloadingCompletedEmail,
  sendDeliveryCompletedEmail,
  sendPODUploadedEmail,
  sendPODApprovedEmail,
  sendPODRejectedEmail,
  sendLoadCompletedShipperEmail,
  sendLoadCompletedDriverEmail,
  // Broker module
  sendBrokerKycStatusEmail,
  sendBrokerDocumentsRequestedEmail,
  // new event types
  sendCarrierNewLoadEmail,
  sendShipperNewTruckMatchEmail,
  sendPerfectMatchShipperEmail,
  sendNewLoadMatchCarrierEmail,
  sendAssignmentConfirmedCarrierEmail,
  // Broker Automation (Broker -> Carrier -> Shipper workflow)
  sendLoadSavedForCarrierEmail,
  sendSuitableTruckFoundEmail,
  sendCarrierTruckMatchedEmail,
  sendShipperConnectionRequestEmail,
  sendCarrierConnectionRequestEmail,
  sendConnectionStatusChangedEmail,
};
