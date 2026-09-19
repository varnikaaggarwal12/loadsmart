/**
 * lib/fileStorageService.js
 *
 * Reusable, permanent image/document storage service backed by MongoDB
 * GridFS. Built to replace the previous "write to local disk, hope the
 * server's filesystem survives a restart" pipeline (see lib/kycFileStore.js
 * for the root-cause diagnosis this replaces) with storage that is durable
 * for as long as the MongoDB deployment itself exists — no dependency on
 * the app server's local disk at all.
 *
 * Design:
 *   - File bytes live in a dedicated GridFS bucket (default name
 *     "loadsmartFiles", override with FILE_BUCKET_NAME) — never as a
 *     Base64 string or a raw Buffer field inside a normal document.
 *   - Every uploaded file gets exactly one lib/fileStorageModels.js
 *     FileMeta document, which is what every other part of the app
 *     (ownership checks, admin review, verification status, soft delete)
 *     actually reads/writes. Callers never touch the GridFS bucket or the
 *     "fs.files"/"fs.chunks" collections directly.
 *   - The public "path" handed back to the frontend and stored in the
 *     existing `...Path` schema fields (Registration.profilePhotoPath,
 *     BookingRequest.podPath, Truck.documentPhotoPath, etc.) is always
 *     `/api/files/<fileId>` — a stable reference that never expires and
 *     never changes, unlike a signed cloud URL.
 *
 * Pure, DB-free logic (validateUpload, sanitizeFilename,
 * generateStoredFilename, checkFileAccess, classifyLegacyPath) is exported
 * separately from the GridFS I/O functions specifically so it can be unit
 * tested without a live MongoDB connection (none is available in this
 * project's CI/dev sandbox — see test/fileStorageService.test.js).
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const { FileMeta } = require('./fileStorageModels');

// ---------------- Configuration ----------------
const DEFAULT_BUCKET_NAME = process.env.FILE_BUCKET_NAME || 'loadsmartFiles';
const MAX_FILE_SIZE_BYTES = Number(process.env.FILE_MAX_SIZE_MB || 10) * 1024 * 1024;

// Every document type this app collects is either an image or a PDF —
// deliberately never anything else (no .exe/.zip/.svg/.html — SVG and HTML
// can carry active content and are excluded on purpose).
const ALLOWED_MIME_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'application/pdf': 'pdf',
};

// Recognized document types (see fileStorageModels.js header comment for
// the full rationale). Not enforced as a hard whitelist on the model itself
// (kept free-form there to match this codebase's existing extensibility
// pattern), but validateUpload() below does check against it so a typo'd or
// unexpected documentType is rejected loudly instead of silently accepted.
const DOCUMENT_TYPES = [
  'face', 'aadharFront', 'aadharBack', 'officePhoto', 'profilePhoto', 'selfiePhoto',
  'gstPhoto', 'msmePhoto', 'invoice', 'bankProof', 'loadingSlip',
  'panDocument', 'addressProof',
  'driverAadharFront', 'driverAadharBack', 'driverRcPhoto', 'driverDlPhoto',
  'documentPhoto', 'pod', 'other',
];

let bucket = null;
let bucketNameInUse = null;

/**
 * Must be called once, after mongoose's connection is open, before any
 * upload/download call. Idempotent — safe to call again (e.g. on a
 * reconnect) since GridFSBucket itself is a cheap, stateless handle.
 */
function init(connection, opts = {}) {
  const conn = connection || mongoose.connection;
  if (!conn || conn.readyState !== 1) {
    throw new Error('fileStorageService.init() requires an open mongoose connection.');
  }
  bucketNameInUse = opts.bucketName || DEFAULT_BUCKET_NAME;
  bucket = new mongoose.mongo.GridFSBucket(conn.db, { bucketName: bucketNameInUse });
  return bucket;
}

function getBucket() {
  if (!bucket) throw new Error('fileStorageService not initialized — call init() after MongoDB connects.');
  return bucket;
}

function isInitialized() {
  return !!bucket;
}

// ---------------- Pure validation / helper logic ----------------

/**
 * Validates a file BEFORE it is written anywhere. Returns { valid, errors }
 * rather than throwing, so callers can return all problems at once (same
 * convention as lib/brokerLoadPosting.js's validateBrokerLoadPosting).
 */
function validateUpload({ buffer, mimeType, documentType, maxSizeBytes = MAX_FILE_SIZE_BYTES }) {
  const errors = [];
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    errors.push({ field: 'file', code: 'empty_file', message: 'No file data was received.' });
  }
  if (!mimeType || !ALLOWED_MIME_TYPES[mimeType]) {
    errors.push({ field: 'mimeType', code: 'unsupported_type', message: 'Only PNG, JPEG, and PDF files are allowed.' });
  }
  if (!documentType || !DOCUMENT_TYPES.includes(documentType)) {
    errors.push({ field: 'documentType', code: 'unknown_document_type', message: 'Unrecognized document type.' });
  }
  if (buffer && Buffer.isBuffer(buffer) && buffer.length > maxSizeBytes) {
    errors.push({ field: 'file', code: 'too_large', message: `File is too large (max ${Math.round(maxSizeBytes / (1024 * 1024))}MB).` });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Strips anything from a user-supplied original filename that isn't a safe
 * character, and caps its length — used only for the human-readable
 * "originalName"/Content-Disposition value, never as a storage path
 * component (generateStoredFilename below is what's actually used on disk
 * or in GridFS, and it is never derived from user input).
 */
function sanitizeFilename(name) {
  const base = String(name || 'document').split(/[\\/]/).pop();
  const cleaned = base.replace(/[^a-zA-Z0-9 ._-]/g, '_').trim();
  return (cleaned || 'document').slice(0, 120);
}

/**
 * Generates a unique, collision-proof storage filename. Never derived from
 * user input (no path traversal surface) and never reused.
 */
function generateStoredFilename(documentType, mimeType) {
  const ext = ALLOWED_MIME_TYPES[mimeType] || 'bin';
  const safeType = String(documentType || 'file').replace(/[^a-zA-Z0-9]/g, '');
  return `${safeType}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
}

/**
 * Pure access-control decision for a file, given its metadata and what we
 * know about the requester. Kept separate from the Express route so the
 * authorization rules themselves are unit-testable without a real request/
 * response/session store.
 *
 *   meta            — the FileMeta document (plain object) being requested
 *   isAdmin         — true if the requester has a valid admin session
 *   requesterUserId — Registration.id of the logged-in user, or null
 *   orderAccessGranted — result of the existing canAccessOrderDocuments()
 *                        check, only meaningful when meta.orderToken is set
 *
 * Rules (matching the spec):
 *   - Admin can always view (including soft-deleted, for recovery review).
 *   - A soft-deleted file is otherwise never served.
 *   - A user-owned file is visible only to the exact owning account.
 *   - An order-scoped file (invoice/POD) defers to the existing
 *     shipper-owns-order / carrier-assigned-to-order / admin check.
 *   - An unclaimed file (no owner yet — mid pre-registration upload) is
 *     visible to nobody but admin, since there is no identity yet to check
 *     ownership against.
 */
function checkFileAccess({ meta, isAdmin, requesterUserId, orderAccessGranted }) {
  if (!meta) return false;
  if (isAdmin) return true;
  if (meta.isDeleted) return false;
  if (meta.userId) return !!requesterUserId && requesterUserId === meta.userId;
  if (meta.orderToken) return !!orderAccessGranted;
  return false; // unclaimed — no identity to check against yet
}

/**
 * Classifies what kind of reference a legacy `...Path` field value is, for
 * the migration script (scripts/migrateImagesToGridFS.js) and for reporting.
 * Deliberately conservative/explicit per the spec's "do not guess" — every
 * branch is a specific, checkable pattern, never a fallback guess.
 */
function classifyLegacyPath(value) {
  if (value === undefined || value === null || value === '') return 'empty';
  const str = String(value);
  if (/^\/api\/files\/[a-f0-9]{24}$/i.test(str)) return 'gridfs'; // already migrated
  if (/^data:(image|application)\//i.test(str)) return 'base64';
  if (/^https?:\/\//i.test(str)) return 'external-url';
  if (str.startsWith('/admin/kyc-photo/') || str.startsWith('/api/my-documents/')) return 'legacy-disk';
  if (/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|pdf)$/.test(str)) return 'legacy-disk-bare-filename';
  return 'unknown';
}

// ---------------- GridFS I/O ----------------

/**
 * Uploads a buffer to GridFS and creates its FileMeta record in one call.
 * Returns { fileId, meta }. Throws on validation failure — callers should
 * run validateUpload() first if they want to return a 4xx instead of
 * catching a thrown error, but this also re-validates internally so a
 * caller can never accidentally skip validation.
 */
async function uploadBuffer({
  buffer, originalName, mimeType, documentType,
  uploadedBy = '', uploadedByRole = '', userId = '', ownerRole = '', orderToken = '',
  maxSizeBytes = MAX_FILE_SIZE_BYTES,
}) {
  const { valid, errors } = validateUpload({ buffer, mimeType, documentType, maxSizeBytes });
  if (!valid) {
    const err = new Error(errors.map((e) => e.message).join(' '));
    err.validationErrors = errors;
    throw err;
  }
  const storedFilename = generateStoredFilename(documentType, mimeType);
  const gridFsBucket = getBucket();

  const fileId = await new Promise((resolve, reject) => {
    const uploadStream = gridFsBucket.openUploadStream(storedFilename, {
      contentType: mimeType,
      metadata: { documentType, uploadedBy, uploadedByRole },
    });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(String(uploadStream.id)));
    uploadStream.end(buffer);
  });

  const meta = await FileMeta.create({
    fileId,
    bucketName: bucketNameInUse,
    userId, ownerRole, orderToken,
    documentType,
    originalName: sanitizeFilename(originalName || storedFilename),
    storedFilename,
    mimeType,
    size: buffer.length,
    uploadedBy, uploadedByRole,
  });

  return { fileId, meta };
}

function isValidFileId(fileId) {
  return typeof fileId === 'string' && mongoose.Types.ObjectId.isValid(fileId) && String(fileId).length === 24;
}

/** Looks up a file's metadata. Returns null (never throws) if not found. */
async function getFileMeta(fileId) {
  if (!isValidFileId(fileId)) return null;
  return FileMeta.findOne({ fileId }).lean();
}

/**
 * Opens a GridFS download stream for a file. Throws a clearly-labeled error
 * (never a raw driver error) if the id is malformed or the file isn't
 * actually in GridFS — the route layer turns both into a clean 404.
 */
function openDownloadStream(fileId) {
  if (!isValidFileId(fileId)) {
    const err = new Error('Invalid file reference.');
    err.code = 'INVALID_FILE_ID';
    throw err;
  }
  return getBucket().openDownloadStream(new mongoose.Types.ObjectId(fileId));
}

/**
 * Claims an unclaimed file for a user account. Refuses to reassign a file
 * that's already owned by someone else — closes off a theoretical "submit
 * someone else's fileId in my registration form to gain view access to it"
 * attack, since the claim silently no-ops instead of overwriting.
 * Returns true if the claim took effect, false otherwise (already claimed
 * by someone else, file not found, or already claimed by this same user).
 */
async function claimFileForUser(fileId, { userId, ownerRole = '' }) {
  if (!isValidFileId(fileId) || !userId) return false;
  const meta = await FileMeta.findOne({ fileId });
  if (!meta) return false;
  if (meta.userId && meta.userId !== userId) return false; // already owned by someone else
  if (meta.userId === userId) return true; // no-op, already claimed by this user
  if (meta.orderToken) return false; // already claimed as an order-scoped file
  meta.userId = userId;
  meta.ownerRole = ownerRole;
  await meta.save();
  return true;
}

/** Same idea as claimFileForUser, for order-scoped documents (invoice/POD). */
async function claimFileForOrder(fileId, { orderToken }) {
  if (!isValidFileId(fileId) || !orderToken) return false;
  const meta = await FileMeta.findOne({ fileId });
  if (!meta) return false;
  if (meta.orderToken && meta.orderToken !== orderToken) return false;
  if (meta.orderToken === orderToken) return true;
  if (meta.userId) return false;
  meta.orderToken = orderToken;
  await meta.save();
  return true;
}

/** Extracts the fileId out of a stored `/api/files/<fileId>` path, or null. */
function extractFileIdFromPath(pathValue) {
  const match = /^\/api\/files\/([a-f0-9]{24})(?:\?.*)?$/i.exec(String(pathValue || ''));
  return match ? match[1] : null;
}

async function setVerificationStatus(fileId, { status, reason = '', verifiedBy = '' }) {
  if (!isValidFileId(fileId)) return null;
  if (!['NOT_REVIEWED', 'APPROVED', 'REJECTED', 'REUPLOAD_REQUESTED'].includes(status)) {
    throw new Error('Invalid verification status.');
  }
  return FileMeta.findOneAndUpdate(
    { fileId },
    { verificationStatus: status, verificationReason: reason, verifiedBy, verifiedAt: new Date() },
    { new: true },
  );
}

async function softDeleteFile(fileId, { deletedBy = '' } = {}) {
  if (!isValidFileId(fileId)) return null;
  return FileMeta.findOneAndUpdate(
    { fileId },
    { isDeleted: true, deletedAt: new Date(), deletedBy },
    { new: true },
  );
}

async function restoreFile(fileId) {
  if (!isValidFileId(fileId)) return null;
  return FileMeta.findOneAndUpdate(
    { fileId },
    { isDeleted: false, deletedAt: null, deletedBy: '' },
    { new: true },
  );
}

module.exports = {
  // config/constants
  ALLOWED_MIME_TYPES, DOCUMENT_TYPES, MAX_FILE_SIZE_BYTES,
  // lifecycle
  init, getBucket, isInitialized,
  // pure logic (unit-testable without Mongo)
  validateUpload, sanitizeFilename, generateStoredFilename, checkFileAccess, classifyLegacyPath, isValidFileId, extractFileIdFromPath,
  // GridFS I/O
  uploadBuffer, getFileMeta, openDownloadStream,
  claimFileForUser, claimFileForOrder,
  setVerificationStatus, softDeleteFile, restoreFile,
};
