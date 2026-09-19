/**
 * lib/notificationService.js
 *
 * Centralized in-app notification helper (spec sections 16-18). One place
 * that creates Notification rows and reads them back, so every route that
 * needs to notify someone calls one small function instead of re-writing
 * `Notification.create(...)` inline everywhere. Mirrors the same
 * "centralize instead of scattering" approach used for lib/emailService.js.
 *
 * Never throws into the caller — a notification failure must not roll back
 * or block the database transaction that triggered it, same rule as email
 * (spec section 26). Failures are logged server-side only.
 */
const crypto = require('crypto');
const { Notification } = require('./opsModels');

/**
 * Create one notification. Fire-and-forget safe — callers can `await` it
 * (recommended, so ordering in tests/logs is predictable) or leave it
 * unawaited; either way a failure here never throws.
 *
 * @param {{userId:string, userRole:string, loadId?:string, type?:string, title:string, message:string}} params
 */
async function notify({ userId, userRole, loadId = '', type = '', title, message }) {
  if (!userId || !userRole || !title || !message) {
    console.error('notificationService.notify: missing required field(s)', { userId, userRole, title });
    return null;
  }
  try {
    const doc = await Notification.create({
      id: `NOTIF-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      userId, userRole, loadId, type, title, message,
    });
    return doc;
  } catch (err) {
    console.error('notificationService.notify failed:', err.message);
    return null;
  }
}

/**
 * Notify several recipients at once with the same title/message — used
 * whenever one event (e.g. "driver assigned") needs to reach more than one
 * role (spec section 17: shipper + driver + admin each get their own row).
 * @param {Array<{userId:string, userRole:string}>} recipients
 * @param {{loadId?:string, type?:string, title:string, message:string}} shared
 */
async function notifyMany(recipients, shared) {
  const list = (recipients || []).filter((r) => r && r.userId && r.userRole);
  return Promise.all(list.map((r) => notify({ ...shared, userId: r.userId, userRole: r.userRole })));
}

/** List notifications for one user, most recent first. */
async function listForUser(userId, userRole, { limit = 50 } = {}) {
  if (!userId || !userRole) return [];
  return Notification.find({ userId, userRole }).sort({ createdAt: -1 }).limit(limit).lean();
}

/** Unread count for the bell badge. */
async function unreadCount(userId, userRole) {
  if (!userId || !userRole) return 0;
  return Notification.countDocuments({ userId, userRole, read: false });
}

/** Mark exactly one notification read — scoped to its owner so one user can never mark another's as read. */
async function markRead(id, userId, userRole) {
  return Notification.findOneAndUpdate({ id, userId, userRole }, { read: true }, { new: true }).lean();
}

/** Mark every notification for this user read (the "Mark all as read" button). */
async function markAllRead(userId, userRole) {
  const result = await Notification.updateMany({ userId, userRole, read: false }, { read: true });
  return { modified: result.modifiedCount != null ? result.modifiedCount : result.nModified || 0 };
}

module.exports = { notify, notifyMany, listForUser, unreadCount, markRead, markAllRead };
