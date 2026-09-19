/**
 * lib/smsService.js
 *
 * One named function per SMS-worthy business event — same shape as
 * lib/emailService.js, sitting on top of lib/smsQueue.js the same way
 * emailService sits on top of emailQueue. Every function here:
 *   - takes the REAL recipient phone number already resolved by the caller
 *     from that user's own Registration/Driver record (never hardcoded,
 *     never guessed),
 *   - is fire-and-forget safe (`.catch(() => {})` at the call site is
 *     always enough — this module never throws),
 *   - is a no-op (logged, not "sent") when the recipient has no phone
 *     number on file,
 *   - is deduplicated by lib/smsQueue.js's idempotencyKey (eventType +
 *     entityId + recipient), so a retried request or a page refresh can
 *     never send the same SMS twice.
 *
 * Messages are short, plain text (SMS has no HTML) and always end with the
 * "LoadSmart powered by Rodex" signature used across the app's other
 * notification channels.
 */
const smsQueue = require('./smsQueue');

const SIGNATURE = '- LoadSmart powered by Rodex';

function send({ to, eventType, entityId, entityType = 'Load', userId = '', userRole = '', body }) {
  if (!to) {
    console.log(`[SMS SKIPPED — no phone on file] ${eventType} (${entityId || 'n/a'})`);
    return Promise.resolve({ queued: false, reason: 'no_recipient' });
  }
  return smsQueue.enqueue({ to, body: `${body}\n${SIGNATURE}`, eventType, entityType, entityId, userId, userRole });
}

// ---------- Load lifecycle ----------
function sendLoadPostedSms({ to, tokenNo, pickup, destination, userId, userRole }) {
  return send({
    to, eventType: 'LOAD_POSTED', entityId: tokenNo, userId, userRole,
    body: `Your load ${tokenNo} (${pickup} to ${destination}) has been posted on LoadSmart.`,
  });
}
function sendLoadApprovedSms({ to, tokenNo, pickup, destination, userId, userRole }) {
  return send({
    to, eventType: 'LOAD_APPROVED', entityId: tokenNo, userId, userRole,
    body: `Load ${tokenNo} (${pickup} to ${destination}) has been approved and is now live.`,
  });
}

// ---------- Broker <-> Carrier connections ----------
function sendCarrierConnectionRequestSms({ to, tokenNo, carrierCompanyName, userId, userRole }) {
  return send({
    to, eventType: 'CARRIER_CONNECTION_REQUESTED', entityId: tokenNo, entityType: 'CarrierConnection', userId, userRole,
    body: `A broker sent a connection request${carrierCompanyName ? ' to ' + carrierCompanyName : ''} for load ${tokenNo}. Check your LoadSmart dashboard.`,
  });
}
function sendCarrierConnectionAcceptedSms({ to, entityId, brokerCompanyName, userId, userRole }) {
  return send({
    to, eventType: 'CARRIER_CONNECTION_ACCEPTED', entityId, entityType: 'CarrierConnection', userId, userRole,
    body: `${brokerCompanyName || 'A broker'} accepted your carrier connection request on LoadSmart.`,
  });
}
function sendCarrierConnectionRejectedSms({ to, entityId, carrierCompanyName, userId, userRole }) {
  return send({
    to, eventType: 'CARRIER_CONNECTION_REJECTED', entityId, entityType: 'CarrierConnection', userId, userRole,
    body: `${carrierCompanyName || 'The carrier'} declined your connection request on LoadSmart.`,
  });
}
function sendCarrierInvitedToBidSms({ to, tokenNo, pickup, destination, userId, userRole }) {
  return send({
    to, eventType: 'CARRIER_INVITED_TO_BID', entityId: tokenNo, userId, userRole,
    body: `You've been invited to bid on load ${tokenNo} (${pickup} to ${destination}) on LoadSmart.`,
  });
}

// ---------- Bidding ----------
function sendBidSubmittedSms({ to, tokenNo, bidAmount, userId, userRole }) {
  return send({
    to, eventType: 'BID_SUBMITTED', entityId: tokenNo, entityType: 'Bid', userId, userRole,
    body: `Your bid of Rs.${bidAmount} for load ${tokenNo} has been submitted.`,
  });
}
function sendBidAcceptedSms({ to, tokenNo, userId, userRole }) {
  return send({
    to, eventType: 'BID_ACCEPTED', entityId: tokenNo, entityType: 'Bid', userId, userRole,
    body: `Congratulations! Your bid on load ${tokenNo} has been accepted.`,
  });
}

// ---------- Payments / dispatch / delivery / documents ----------
function sendAdvancePaymentReceivedSms({ to, tokenNo, amount, userId, userRole }) {
  return send({
    to, eventType: 'ADVANCE_PAYMENT_RECEIVED', entityId: tokenNo, userId, userRole,
    body: `Advance payment${amount ? ' of Rs.' + amount : ''} received for load ${tokenNo}.`,
  });
}
function sendDriverAssignedSms({ to, tokenNo, driverName, vehicleNumber, userId, userRole }) {
  return send({
    to, eventType: 'DRIVER_ASSIGNED', entityId: tokenNo, userId, userRole,
    body: `Driver ${driverName || ''} (${vehicleNumber || 'vehicle TBD'}) has been assigned to load ${tokenNo}.`,
  });
}
function sendShipmentDispatchedSms({ to, tokenNo, pickup, destination, userId, userRole }) {
  return send({
    to, eventType: 'SHIPMENT_DISPATCHED', entityId: tokenNo, userId, userRole,
    body: `Your shipment ${tokenNo} (${pickup} to ${destination}) has been dispatched.`,
  });
}
function sendShipmentDeliveredSms({ to, tokenNo, userId, userRole }) {
  return send({
    to, eventType: 'SHIPMENT_DELIVERED', entityId: tokenNo, userId, userRole,
    body: `Shipment ${tokenNo} has been delivered.`,
  });
}
function sendPodUploadedSms({ to, tokenNo, userId, userRole }) {
  return send({
    to, eventType: 'POD_UPLOADED', entityId: tokenNo, userId, userRole,
    body: `Proof of delivery has been uploaded for load ${tokenNo} and is awaiting review.`,
  });
}
function sendAdminRequestedDocumentsSms({ to, docs, userId, userRole }) {
  return send({
    to, eventType: 'ADMIN_REQUESTED_DOCUMENTS', entityId: userId, entityType: 'KYC', userId, userRole,
    body: `LoadSmart admin requested additional document(s): ${docs || 'see your dashboard'}. Please upload them to continue.`,
  });
}

module.exports = {
  sendLoadPostedSms,
  sendLoadApprovedSms,
  sendCarrierConnectionRequestSms,
  sendCarrierConnectionAcceptedSms,
  sendCarrierConnectionRejectedSms,
  sendCarrierInvitedToBidSms,
  sendBidSubmittedSms,
  sendBidAcceptedSms,
  sendAdvancePaymentReceivedSms,
  sendDriverAssignedSms,
  sendShipmentDispatchedSms,
  sendShipmentDeliveredSms,
  sendPodUploadedSms,
  sendAdminRequestedDocumentsSms,
};
