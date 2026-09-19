/**
 * lib/fileStorageModels.js
 *
 * Metadata model for the GridFS-backed permanent file storage service (see
 * lib/fileStorageService.js). The actual file bytes live in GridFS, in a
 * dedicated bucket (default name "loadsmartFiles", configurable via the
 * FILE_BUCKET_NAME env var) — this model stores ONLY the GridFS file id plus
 * everything needed to authorize access to it and review it in the Admin
 * Portal. Nothing here duplicates the file bytes (no Base64, no Buffer
 * field) — that is the exact anti-pattern this whole feature replaces.
 *
 * One FileMeta document is created per uploaded file, covering every
 * document type the spec lists: profile photo, live selfie, PAN card,
 * Aadhaar (front/back), GST certificate, MSME certificate, bank proof,
 * company documents, vehicle/driver documents, and order-scoped documents
 * (shipper invoice, POD).
 *
 * Ownership shape: a file is either
 *   - user-owned (userId set)      — a Registration account's own document, or
 *   - order-scoped (orderToken set) — attached to a BookingRequest (invoice/POD)
 *   - unclaimed (neither set)       — uploaded anonymously before an account
 *     exists (the pre-registration KYC flow); claimed later once the
 *     registration/update it belongs to actually succeeds (see
 *     claimFileForUser / claimFileForOrder in fileStorageService.js).
 * A file is never both — the two are mutually exclusive by how they're claimed.
 */
const mongoose = require('mongoose');

// Free-form but documented list of the document types this app collects.
// Kept as a comment (not a strict enum) so a new document type introduced
// elsewhere doesn't require a schema migration — matches this codebase's
// existing convention (registrationSchema is strict:false for the same
// reason). Recognized values today:
//   face, aadharFront, aadharBack, officePhoto, profilePhoto,
//   gstPhoto, msmePhoto, invoice, bankProof,
//   driverAadharFront, driverAadharBack, driverRcPhoto, driverDlPhoto,
//   pod, loadingSlip, panDocument, addressProof, documentPhoto (vehicle)
const fileMetaSchema = new mongoose.Schema({
  // The GridFS files._id this record describes. Stored as a plain string
  // (hex ObjectId) rather than an ObjectId reference so it can be embedded
  // verbatim into Registration/BookingRequest/Truck "...Path" string fields
  // as `/api/files/<fileId>` without any special (de)serialization.
  fileId: { type: String, required: true, unique: true },
  bucketName: { type: String, required: true },

  // Ownership — see header comment. Exactly one of userId/orderToken is set
  // once claimed; both are empty for a not-yet-claimed anonymous upload.
  userId: { type: String, default: '', index: true },
  ownerRole: { type: String, default: '' }, // 'shipper' | 'broker' | 'carrier' | 'driver'
  orderToken: { type: String, default: '', index: true },

  documentType: { type: String, required: true, index: true },
  originalName: { type: String, default: '' },
  storedFilename: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },

  uploadedAt: { type: Date, default: Date.now, index: true },
  uploadedBy: { type: String, default: '' }, // userId of the uploader, or '' if anonymous
  uploadedByRole: { type: String, default: '' },

  verificationStatus: {
    type: String,
    enum: ['NOT_REVIEWED', 'APPROVED', 'REJECTED', 'REUPLOAD_REQUESTED'],
    default: 'NOT_REVIEWED',
    index: true,
  },
  verificationReason: { type: String, default: '' },
  verifiedBy: { type: String, default: '' },
  verifiedAt: { type: Date, default: null },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: String, default: '' },

  // Set only when this record was produced by the legacy-image migration
  // script (scripts/migrateImagesToGridFS.js) — keeps a permanent audit
  // trail of exactly which old disk/base64/Mongo-Buffer file this replaced.
  legacyMigratedFrom: { type: String, default: '' },
}, { timestamps: true });

fileMetaSchema.index({ userId: 1, documentType: 1 });
fileMetaSchema.index({ orderToken: 1, documentType: 1 });
fileMetaSchema.index({ uploadedAt: -1 });
fileMetaSchema.index({ verificationStatus: 1 });

const FileMeta = mongoose.models.FileMeta || mongoose.model('FileMeta', fileMetaSchema);

module.exports = { FileMeta };
