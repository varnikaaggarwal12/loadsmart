/**
 * test/tripLifecycle.test.js
 *
 * Pure, DB-free unit tests for lib/loadStatusMachine.js — specifically the
 * Phase 1 "manual digital trip tracking" milestone expansion (spec section
 * 2): the two new stages (DEPARTED_PICKUP, UNLOADING_COMPLETE) and the two
 * new driver actions ('depart', 'complete_unloading') that reach them, plus
 * a check that the full happy-path sequence still walks end to end with no
 * gaps and that the pre-existing GPS-tracking hook point (start_trip) was
 * only re-gated, never functionally changed.
 *
 * Run: node --test test/tripLifecycle.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const statusMachine = require('../lib/loadStatusMachine');
const opsModels = require('../lib/opsModels');

test('LOAD_STAGE_KEYS includes the two new milestone stages in the right position', () => {
  const keys = statusMachine.LOAD_STAGE_KEYS;
  const loadedIdx = keys.indexOf('LOADED');
  const departedIdx = keys.indexOf('DEPARTED_PICKUP');
  const inTransitIdx = keys.indexOf('IN_TRANSIT');
  const unloadingIdx = keys.indexOf('UNLOADING');
  const unloadingCompleteIdx = keys.indexOf('UNLOADING_COMPLETE');
  const deliveredIdx = keys.indexOf('DELIVERED');

  assert.ok(departedIdx > loadedIdx && departedIdx < inTransitIdx, 'DEPARTED_PICKUP must sit between LOADED and IN_TRANSIT');
  assert.ok(unloadingCompleteIdx > unloadingIdx && unloadingCompleteIdx < deliveredIdx, 'UNLOADING_COMPLETE must sit between UNLOADING and DELIVERED');
});

test('STAGE_LABELS has a human label for every stage key, including the two new ones', () => {
  statusMachine.LOAD_STAGE_KEYS.forEach((key) => {
    assert.equal(typeof statusMachine.STAGE_LABELS[key], 'string');
    assert.ok(statusMachine.STAGE_LABELS[key].length > 0, `missing label for ${key}`);
  });
});

test("'depart' action transitions LOADED -> DEPARTED_PICKUP", () => {
  const t = statusMachine.assertTransition('LOADED', 'depart');
  assert.equal(t.to, 'DEPARTED_PICKUP');
  assert.equal(t.eventType, 'DEPARTED_PICKUP');
});

test("'start_trip' now requires DEPARTED_PICKUP (not LOADED) as its starting stage", () => {
  assert.throws(() => statusMachine.assertTransition('LOADED', 'start_trip'), /isn't valid right now/);
  const t = statusMachine.assertTransition('DEPARTED_PICKUP', 'start_trip');
  assert.equal(t.to, 'IN_TRANSIT');
});

test("'complete_unloading' action transitions UNLOADING -> UNLOADING_COMPLETE", () => {
  const t = statusMachine.assertTransition('UNLOADING', 'complete_unloading');
  assert.equal(t.to, 'UNLOADING_COMPLETE');
  assert.equal(t.eventType, 'UNLOADING_COMPLETED');
});

test("'deliver' and 'complete' now require UNLOADING_COMPLETE (not UNLOADING) as their starting stage", () => {
  assert.throws(() => statusMachine.assertTransition('UNLOADING', 'deliver'), /isn't valid right now/);
  assert.throws(() => statusMachine.assertTransition('UNLOADING', 'complete'), /isn't valid right now/);
  const t1 = statusMachine.assertTransition('UNLOADING_COMPLETE', 'deliver');
  assert.equal(t1.to, 'DELIVERED');
  assert.equal(t1.requiresDeliveryConfirmation, true);
  const t2 = statusMachine.assertTransition('UNLOADING_COMPLETE', 'complete');
  assert.equal(t2.to, 'DELIVERED');
});

test('the full happy-path action sequence walks every stage with no gaps', () => {
  const sequence = [
    ['ASSIGNED', 'accept', 'DRIVER_ACCEPTED'],
    ['DRIVER_ACCEPTED', 'arrived', 'ARRIVED_PICKUP'],
    ['ARRIVED_PICKUP', 'start_loading', 'LOADING'],
    ['LOADING', 'loaded', 'LOADED'],
    ['LOADED', 'depart', 'DEPARTED_PICKUP'],
    ['DEPARTED_PICKUP', 'start_trip', 'IN_TRANSIT'],
    ['IN_TRANSIT', 'reach_destination', 'REACHED_DESTINATION'],
    ['REACHED_DESTINATION', 'start_unloading', 'UNLOADING'],
    ['UNLOADING', 'complete_unloading', 'UNLOADING_COMPLETE'],
    ['UNLOADING_COMPLETE', 'deliver', 'DELIVERED'],
  ];
  sequence.forEach(([from, action, expectedTo]) => {
    const t = statusMachine.assertTransition(from, action);
    assert.equal(t.to, expectedTo, `${action} from ${from} should reach ${expectedTo}`);
  });
});

test('TRACKING_STATUS_MAP has an entry for every loadStage, including the two new ones, mapped into an existing legacy status value', () => {
  const LEGACY_STATUSES = ['Booked', 'Confirmed', 'Picked Up', 'In Transit', 'Out for Delivery', 'Delayed', 'Delivered'];
  statusMachine.LOAD_STAGE_KEYS.forEach((key) => {
    const mapped = statusMachine.TRACKING_STATUS_MAP[key];
    assert.ok(LEGACY_STATUSES.includes(mapped), `TRACKING_STATUS_MAP.${key} ("${mapped}") must be one of the existing legacy tracking.status values`);
  });
});

test('start_trip (the GPS-tracking-start hook) still exists unchanged in every field except `from`', () => {
  const t = statusMachine.DRIVER_ACTION_TRANSITIONS.start_trip;
  assert.equal(t.to, 'IN_TRANSIT');
  assert.equal(t.eventType, 'TRIP_STARTED');
  assert.equal(t.eventLabel, 'Trip Started');
});

test('DEPARTED_PICKUP is a valid TrackingEvent type (opsModels enum was extended)', () => {
  assert.ok(opsModels.TRACKING_EVENT_TYPES.includes('DEPARTED_PICKUP'));
  assert.ok(opsModels.TRACKING_EVENT_TYPES.includes('UNLOADING_COMPLETED'), 'UNLOADING_COMPLETED already existed in the enum and must still be present');
});

test('an unknown action is still rejected the same way regardless of the new stages', () => {
  assert.throws(() => statusMachine.assertTransition('LOADED', 'not_a_real_action'), /Unknown action/);
});
