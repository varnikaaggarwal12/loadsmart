/**
 * lib/kycFileStore.js
 *
 * ROOT CAUSE of "Photo unavailable after a day or two" (KYC Photos /
 * Business Certificate / bank proof / POD / loading slip, etc.):
 * POST /api/kyc/upload writes every uploaded file to LOCAL DISK only
 * (private-uploads/kyc/), and this deployment's local disk does not
 * reliably survive a restart — confirmed directly: for a shipper whose
 * record clearly has KYC fields populated (the UI shows the distinct
 * "Photo unavailable" broken-request state, not the separate "No KYC
 * photos on file" empty state — see views/admin/list.js), the actual
 * bytes were already gone from private-uploads/kyc/ while the database
 * record (and its stored /admin/kyc-photo/:filename path) was completely
 * intact. Mongo, unlike local disk here, IS durable — the rest of this
 * app's data proves that every day — so every uploaded file is now ALSO
 * saved here as the source of truth. The three routes that serve these
 * files (admin /admin/kyc-photo/:filename, self-view
 * /api/my-documents/:filename, and /api/orders/:token/document/:kind) all
 * fall back to this store whenever the on-disk copy is missing, and
 * transparently re-write the disk cache so the fast path is used again
 * next time. Disk stays the fast path; Mongo is what makes it durable.
 *
 * Known limitation: this only protects files uploaded AFTER this fix
 * ships. A file whose disk copy was already lost before today has no
 * backup to recover from — that shipper/carrier will need to re-upload
 * the affected document once.
 */
const mongoose = require('mongoose');

const kycFileSchema = new mongoose.Schema({
  filename: { type: String, required: true, unique: true, index: true },
  mimeType: { type: String, required: true },
  data: { type: Buffer, required: true },
  size: Number,
  uploadedAt: { type: Date, default: Date.now },
});
const KycFile = mongoose.model('KycFile', kycFileSchema);

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf',
};

function mimeForFilename(filename) {
  const ext = String(filename).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/** Upserts by filename — safe to call more than once for the same file. */
async function saveFile(filename, buffer) {
  await KycFile.findOneAndUpdate(
    { filename },
    { filename, mimeType: mimeForFilename(filename), data: buffer, size: buffer.length, uploadedAt: new Date() },
    { upsert: true },
  );
}

/** @returns {Promise<{buffer:Buffer, mimeType:string}|null>} */
async function readFile(filename) {
  const doc = await KycFile.findOne({ filename }).lean();
  if (!doc) return null;
  return { buffer: doc.data, mimeType: doc.mimeType || mimeForFilename(filename) };
}

module.exports = { KycFile, saveFile, readFile, mimeForFilename };
