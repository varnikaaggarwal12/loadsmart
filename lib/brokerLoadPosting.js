/**
 * lib/brokerLoadPosting.js
 *
 * Pure, DB-free validation for the Broker Portal's "+ Post New Load" form —
 * same contract as lib/brokerService.js's validateBrokerRegistration: plain
 * object in, {valid, errors} out, no Mongoose/Express access, so it's
 * unit-testable with `node --test` and reusable from both the create and
 * edit routes in server_load.js without duplicating the rule list.
 */
'use strict';

const REQUIRED_TRUCK_TYPES_ANY = true; // free text, matches the existing Truck.truckType convention (no hard-coded enum)

/**
 * @param {object} b raw request body for POST /api/broker/loads
 * @returns {{valid:boolean, errors:Array<{field:string, code:string, message:string}>}}
 */
function validateBrokerLoadPosting(b) {
  const errors = [];
  const push = (field, code, message) => errors.push({ field, code, message });

  if (!String(b.pickup || '').trim()) push('pickup', 'pickup_required', 'Pickup location is required.');
  if (!String(b.destination || '').trim()) push('destination', 'destination_required', 'Destination is required.');
  if (!String(b.material || '').trim()) push('material', 'material_required', 'Material / category is required.');

  const weight = Number(b.weight);
  if (!weight || weight <= 0) push('weight', 'weight_required', 'Enter a valid weight (in tons/kg, greater than 0).');

  if (!String(b.requiredTruckType || '').trim()) push('requiredTruckType', 'truck_type_required', 'Required truck type is required.');

  const numberOfTrucks = b.numberOfTrucks === undefined || b.numberOfTrucks === null || b.numberOfTrucks === '' ? 1 : Number(b.numberOfTrucks);
  if (!Number.isFinite(numberOfTrucks) || numberOfTrucks < 1) push('numberOfTrucks', 'invalid_truck_count', 'Number of trucks must be at least 1.');

  if (b.pickupDateTime) {
    const d = new Date(b.pickupDateTime);
    if (isNaN(d.getTime())) push('pickupDateTime', 'invalid_pickup_date', 'Enter a valid pickup date.');
  } else {
    push('pickupDateTime', 'pickup_date_required', 'Pickup date is required.');
  }
  if (b.deliveryDeadline) {
    const d = new Date(b.deliveryDeadline);
    if (isNaN(d.getTime())) push('deliveryDeadline', 'invalid_delivery_date', 'Enter a valid delivery date.');
    else if (b.pickupDateTime && !isNaN(new Date(b.pickupDateTime).getTime()) && d.getTime() < new Date(b.pickupDateTime).getTime()) {
      push('deliveryDeadline', 'delivery_before_pickup', 'Delivery date cannot be before the pickup date.');
    }
  }

  const budgetRate = b.budgetRate === undefined || b.budgetRate === null || b.budgetRate === '' ? null : Number(b.budgetRate);
  if (budgetRate !== null && (!Number.isFinite(budgetRate) || budgetRate < 0)) {
    push('budgetRate', 'invalid_budget', 'Enter a valid budget / expected freight rate.');
  }

  if (!String(b.contactPerson || '').trim()) push('contactPerson', 'contact_person_required', 'Contact person is required.');
  const phone = String(b.contactPhone || '').trim();
  if (!/^[0-9+\-\s()]{7,15}$/.test(phone)) push('contactPhone', 'invalid_contact_phone', 'Enter a valid contact phone number.');

  if (b.advancePaymentRequired) {
    const pct = Number(b.advancePaymentPercent);
    if (b.advancePaymentPercent !== undefined && b.advancePaymentPercent !== null && b.advancePaymentPercent !== '' && (!Number.isFinite(pct) || pct <= 0 || pct > 100)) {
      push('advancePaymentPercent', 'invalid_advance_percent', 'Advance payment percentage must be between 1 and 100.');
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Which brokerLoadStatus values a broker may still edit their own load from — a load already open to carriers (POSTED) or cancelled should not have its core commercial terms silently rewritten. */
function canEditBrokerLoad(load) {
  return load.brokerLoadStatus === 'DRAFT';
}

/** A broker may cancel their own posted load unless it has already progressed past being purely their own listing (a carrier/driver assignment or later loadStage means real commitments may already be in motion). */
function canCancelBrokerLoad(load) {
  if (load.brokerLoadStatus === 'CANCELLED') return false;
  const committedStages = ['ASSIGNED', 'DRIVER_ACCEPTED', 'ARRIVED_PICKUP', 'LOADING', 'LOADED', 'DEPARTED_PICKUP', 'IN_TRANSIT', 'REACHED_DESTINATION', 'UNLOADING', 'UNLOADING_COMPLETE', 'DELIVERED', 'COMPLETED'];
  return !committedStages.includes(load.loadStage);
}

module.exports = { validateBrokerLoadPosting, canEditBrokerLoad, canCancelBrokerLoad, REQUIRED_TRUCK_TYPES_ANY };
