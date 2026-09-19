#!/usr/bin/env node
/**
 * scripts/migrateImagesToGridFS.js
 *
 * One-time (safely re-runnable) migration that moves every existing
 * user-uploaded photo/KYC document this app knows about — wherever its
 * bytes currently live — into the new permanent GridFS-backed storage (see
 * lib/fileStorageService.js), and updates the referencing Registration/
 * BookingRequest/Truck document to point at the new `/api/files/<fileId>`
 * reference instead of the old local-disk path.
 *
 * Per the fix spec this script implements:
 *   - Detects what kind of reference each `...Path` field actually holds
 *     (already-migrated GridFS reference / legacy on-disk path / bare
 *     legacy filename / a literal base64 data URL / an external URL /
 *     something unrecognized) — see fileStorageService.classifyLegacyPath.
 *     Nothing is guessed: every branch below is a specific, checkable
 *     pattern.
 *   - If the original file is still recoverable (on local disk, or in the
 *     lib/kycFileStore.js durable Mongo backup), it is uploaded to GridFS
 *     and the record is updated to the new reference.
 *   - Every attempt (success or failure) is written to the
 *     "filemigrationlogs" collection — a permanent, queryable audit trail
 *     — and also printed to the console as it runs.
 *   - The OLD file (on disk, or in kycFileStore) is NEVER deleted by this
 *     script, regardless of outcome — only the pointer field is updated,
 *     and only once the new GridFS copy is confirmed written. Re-running
 *     this script is always safe: anything already in the new
 *     `/api/files/<fileId>` format is skipped.
 *   - A file that cannot be recovered (already lost, or referenced only by
 *     an external URL this script deliberately does not fetch — see
 *     below) is reported by this script's summary, never silently dropped
 *     and never replaced with an invented/placeholder image.
 *
 * Auto-generated invoice PDFs (loadInvoicePath / transportInvoicePath) are
 * OUT OF SCOPE here on purpose — server_load.js's
 * GET /api/orders/:token/document/:kind now regenerates both fresh on
 * every view instead of relying on a cached file (see that route's
 * comments), so there is nothing to migrate for them.
 *
 * Usage:
 *   node scripts/migrateImagesToGridFS.js           # run the migration
 *   node scripts/migrateImagesToGridFS.js --dry-run  # report only, write nothing
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const fileStorageService = require('../lib/fileStorageService');
const kycFileStore = require('../lib/kycFileStore');

const DRY_RUN = process.argv.includes('--dry-run');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/loadsmart';
const KYC_UPLOAD_DIR = path.join(__dirname, '..', 'private-uploads', 'kyc');

// ---------- Minimal, strict:false models — enough to read/update the
// handful of fields this migration touches, without importing
// server_load.js itself (which would start the whole HTTP server). Same
// collection names Mongoose derives from the real models there
// ("registrations" / "bookingrequests" / "trucks"), so this reads/writes
// the exact same documents.
const Registration = mongoose.models.Registration
  || mongoose.model('Registration', new mongoose.Schema({ id: String, role: String }, { strict: false, collection: 'registrations' }));
const BookingRequest = mongoose.models.BookingRequest
  || mongoose.model('BookingRequest', new mongoose.Schema({ tokenNo: String }, { strict: false, collection: 'bookingrequests' }));
const Truck = mongoose.models.Truck
  || mongoose.model('Truck', new mongoose.Schema({ id: String, carrierUsername: String }, { strict: false, collection: 'trucks' }));

const migrationLogSchema = new mongoose.Schema({
  ranAt: { type: Date, default: Date.now },
  collection: String, // 'registrations' | 'bookingrequests' | 'trucks'
  recordId: String,
  field: String,
  originalValue: String,
  classification: String,
  outcome: String, // 'migrated' | 'already-migrated' | 'unrecoverable' | 'skipped-external-url' | 'skipped-empty' | 'error'
  newFileId: String,
  errorMessage: String,
}, { collection: 'filemigrationlogs' });
const MigrationLog = mongoose.models.FileMigrationLog || mongoose.model('FileMigrationLog', migrationLogSchema);

// Registration fields that may hold an uploaded photo/document, and the
// documentType + role each maps to. Includes legacy dynamic fields that
// only exist on old records (the schema is strict:false, same as
// server_load.js's registrationSchema) — a field simply won't be present
// on records that never had it, which is handled below (skipped as empty).
const REGISTRATION_DOC_FIELDS = [
  ['facePhotoPath', 'face'], ['aadharFrontPhotoPath', 'aadharFront'], ['aadharBackPhotoPath', 'aadharBack'],
  ['officePhotoPath', 'officePhoto'], ['profilePhotoPath', 'profilePhoto'],
  ['gstPhotoPath', 'gstPhoto'], ['msmePhotoPath', 'msmePhoto'], ['loadingSlipPath', 'loadingSlip'],
  ['bankProofPhotoPath', 'bankProof'], ['panDocumentPath', 'panDocument'], ['addressProofPath', 'addressProof'],
  ['driverAadharFrontPhotoPath', 'driverAadharFront'], ['driverAadharBackPhotoPath', 'driverAadharBack'],
  ['driverRcPhotoPath', 'driverRcPhoto'], ['driverDlPhotoPath', 'driverDlPhoto'],
];
const BOOKING_DOC_FIELDS = [['invoicePath', 'invoice'], ['podPath', 'pod']];
const TRUCK_DOC_FIELDS = [['documentPhotoPath', 'documentPhoto']];

const summary = { migrated: 0, alreadyMigrated: 0, unrecoverable: 0, skippedExternal: 0, skippedEmpty: 0, errors: 0 };
const unrecoverableDetails = [];

/** Reads bytes for a legacy on-disk (or bare-filename) reference — disk first, then the durable kycFileStore Mongo backup, exactly like the serving routes do. Never touches GridFS. */
async function readLegacyBytes(pathValue) {
  const filename = String(pathValue).replace('/admin/kyc-photo/', '').replace('/api/my-documents/', '').split('/').pop();
  if (!/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|pdf)$/.test(filename)) return null;
  const filePath = path.join(KYC_UPLOAD_DIR, filename);
  if (fs.existsSync(filePath)) {
    return { buffer: fs.readFileSync(filePath), mimeType: kycFileStore.mimeForFilename(filename), originalName: filename };
  }
  const backup = await kycFileStore.readFile(filename);
  if (backup) return { buffer: backup.buffer, mimeType: backup.mimeType, originalName: filename };
  return null;
}

function decodeBase64DataUrl(value) {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) return null;
  return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] };
}

async function logOutcome(entry) {
  console.log(`[${entry.outcome}] ${entry.collection}/${entry.recordId}.${entry.field}` + (entry.newFileId ? ` -> ${entry.newFileId}` : '') + (entry.errorMessage ? ` (${entry.errorMessage})` : ''));
  if (!DRY_RUN) {
    await MigrationLog.create(entry).catch((err) => console.error('Could not write migration log entry:', err.message));
  }
}

/**
 * Migrates one field on one record, if needed. `claim` describes how the
 * new file should be attached once uploaded — either { userId, ownerRole }
 * for a user-owned document or { orderToken } for an order-scoped one.
 * Returns true if the record's field value changed (caller must .save()).
 */
async function migrateField({ collectionName, recordId, fieldName, value, documentType, claim }) {
  const classification = fileStorageService.classifyLegacyPath(value);
  const base = { collection: collectionName, recordId, field: fieldName, originalValue: String(value || ''), classification };

  if (classification === 'empty') {
    summary.skippedEmpty++;
    return null; // nothing to log — not worth a row per absent field
  }
  if (classification === 'gridfs') {
    summary.alreadyMigrated++;
    await logOutcome({ ...base, outcome: 'already-migrated' });
    return null;
  }
  if (classification === 'external-url') {
    summary.skippedExternal++;
    await logOutcome({ ...base, outcome: 'skipped-external-url', errorMessage: 'External URL left as-is — this script does not fetch third-party URLs.' });
    return null;
  }

  let bytes = null;
  try {
    if (classification === 'base64') {
      bytes = decodeBase64DataUrl(value);
    } else if (classification === 'legacy-disk' || classification === 'legacy-disk-bare-filename') {
      bytes = await readLegacyBytes(value);
    }
  } catch (err) {
    summary.errors++;
    await logOutcome({ ...base, outcome: 'error', errorMessage: err.message });
    return null;
  }

  if (!bytes) {
    summary.unrecoverable++;
    unrecoverableDetails.push({ ...base });
    await logOutcome({ ...base, outcome: 'unrecoverable', errorMessage: 'No disk copy, durable backup, or decodable data found for this reference.' });
    return null;
  }

  if (DRY_RUN) {
    summary.migrated++; // counted as "would migrate" in dry-run mode
    await logOutcome({ ...base, outcome: 'migrated (dry-run)' });
    return null;
  }

  try {
    const { fileId } = await fileStorageService.uploadBuffer({
      buffer: bytes.buffer,
      originalName: bytes.originalName || `${documentType}.bin`,
      mimeType: bytes.mimeType,
      documentType,
      uploadedBy: 'migration-script',
      uploadedByRole: 'system',
    });
    if (claim.userId) {
      await fileStorageService.claimFileForUser(fileId, { userId: claim.userId, ownerRole: claim.ownerRole });
    } else if (claim.orderToken) {
      await fileStorageService.claimFileForOrder(fileId, { orderToken: claim.orderToken });
    }
    // Permanent audit trail of exactly what this new file replaced.
    await require('../lib/fileStorageModels').FileMeta.updateOne({ fileId }, { legacyMigratedFrom: String(value) });
    summary.migrated++;
    await logOutcome({ ...base, outcome: 'migrated', newFileId: fileId });
    return `/api/files/${fileId}`;
  } catch (err) {
    summary.errors++;
    await logOutcome({ ...base, outcome: 'error', errorMessage: err.message });
    return null;
  }
}

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to ${MONGODB_URI}${DRY_RUN ? ' (DRY RUN — no writes will be made)' : ''}`);
  fileStorageService.init(mongoose.connection, { bucketName: process.env.FILE_BUCKET_NAME || 'loadsmartFiles' });

  // ---- Registration (Shipper / Broker / Carrier accounts) ----
  const registrations = await Registration.find({});
  for (const rec of registrations) {
    let changed = false;
    for (const [field, documentType] of REGISTRATION_DOC_FIELDS) {
      const value = rec.get(field);
      if (value === undefined) continue;
      const newPath = await migrateField({
        collectionName: 'registrations', recordId: rec.id, fieldName: field, value, documentType,
        claim: { userId: rec.id, ownerRole: rec.role },
      });
      if (newPath) { rec.set(field, newPath); changed = true; }
    }
    if (changed) await rec.save();
  }
  console.log(`Registrations scanned: ${registrations.length}`);

  // ---- BookingRequest (shipper invoice + carrier/driver POD) ----
  const bookings = await BookingRequest.find({});
  for (const rec of bookings) {
    let changed = false;
    for (const [field, documentType] of BOOKING_DOC_FIELDS) {
      const value = rec.get(field);
      if (value === undefined) continue;
      const newPath = await migrateField({
        collectionName: 'bookingrequests', recordId: rec.tokenNo, fieldName: field, value, documentType,
        claim: { orderToken: rec.tokenNo },
      });
      if (newPath) { rec.set(field, newPath); changed = true; }
    }
    if (changed) await rec.save();
  }
  console.log(`Bookings scanned: ${bookings.length}`);

  // ---- Truck (vehicle documents) ----
  const trucks = await Truck.find({});
  const carrierIdCache = new Map();
  for (const rec of trucks) {
    let changed = false;
    for (const [field, documentType] of TRUCK_DOC_FIELDS) {
      const value = rec.get(field);
      if (value === undefined) continue;
      let ownerId = carrierIdCache.get(rec.carrierUsername);
      if (ownerId === undefined) {
        const owner = await Registration.findOne({ role: 'carrier', username: rec.carrierUsername }).lean();
        ownerId = (owner && owner.id) || '';
        carrierIdCache.set(rec.carrierUsername, ownerId);
      }
      const newPath = await migrateField({
        collectionName: 'trucks', recordId: rec.id, fieldName: field, value, documentType,
        claim: { userId: ownerId, ownerRole: 'carrier' },
      });
      if (newPath) { rec.set(field, newPath); changed = true; }
    }
    if (changed) await rec.save();
  }
  console.log(`Trucks scanned: ${trucks.length}`);

  console.log('\n========== Migration summary ==========');
  console.log(`Migrated:          ${summary.migrated}`);
  console.log(`Already migrated:  ${summary.alreadyMigrated}`);
  console.log(`Skipped (empty):   ${summary.skippedEmpty}`);
  console.log(`Skipped (ext URL): ${summary.skippedExternal}`);
  console.log(`Unrecoverable:     ${summary.unrecoverable}`);
  console.log(`Errors:            ${summary.errors}`);
  if (unrecoverableDetails.length) {
    console.log('\nUnrecoverable files (original file/backup no longer exists — NOT replaced with a placeholder):');
    unrecoverableDetails.forEach((d) => console.log(`  - ${d.collection}/${d.recordId}.${d.field} = "${d.originalValue}"`));
  }
  console.log('\nFull per-file detail is in the "filemigrationlogs" collection.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
