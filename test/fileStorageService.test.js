/**
 * test/fileStorageService.test.js
 *
 * Unit tests for the pure, DB-free logic in lib/fileStorageService.js —
 * validation, filename generation, the access-control decision function,
 * and the legacy-path classifier the migration script relies on. No live
 * MongoDB is available in this project's dev/CI sandbox (see the other
 * test files' headers for the same note), so every GridFS I/O function
 * (uploadBuffer, openDownloadStream, claimFileForUser, etc.) is exercised
 * only by code review + `node -c` + these pure-logic tests, exactly the
 * same verification approach used for the rest of this codebase's
 * Mongo-dependent code.
 *
 * Run: node --test test/fileStorageService.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateUpload, sanitizeFilename, generateStoredFilename, checkFileAccess,
  classifyLegacyPath, isValidFileId, extractFileIdFromPath, ALLOWED_MIME_TYPES, DOCUMENT_TYPES,
} = require('../lib/fileStorageService');

// ---------- validateUpload ----------
test('validateUpload: accepts a valid PNG under the size limit', () => {
  const { valid, errors } = validateUpload({ buffer: Buffer.from('fake-png-bytes'), mimeType: 'image/png', documentType: 'profilePhoto' });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateUpload: accepts a valid PDF document type', () => {
  const { valid } = validateUpload({ buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf', documentType: 'panDocument' });
  assert.equal(valid, true);
});

test('validateUpload: rejects an empty buffer', () => {
  const { valid, errors } = validateUpload({ buffer: Buffer.alloc(0), mimeType: 'image/png', documentType: 'profilePhoto' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.code === 'empty_file'));
});

test('validateUpload: rejects a missing buffer entirely', () => {
  const { valid, errors } = validateUpload({ buffer: null, mimeType: 'image/png', documentType: 'profilePhoto' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.code === 'empty_file'));
});

test('validateUpload: rejects an unsupported mime type (e.g. SVG or an executable)', () => {
  const { valid, errors } = validateUpload({ buffer: Buffer.from('x'), mimeType: 'image/svg+xml', documentType: 'profilePhoto' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.code === 'unsupported_type'));
});

test('validateUpload: rejects an unrecognized documentType', () => {
  const { valid, errors } = validateUpload({ buffer: Buffer.from('x'), mimeType: 'image/png', documentType: 'somethingMadeUp' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.code === 'unknown_document_type'));
});

test('validateUpload: rejects a file over the size limit', () => {
  const bigBuffer = Buffer.alloc(1024);
  const { valid, errors } = validateUpload({ buffer: bigBuffer, mimeType: 'image/png', documentType: 'profilePhoto', maxSizeBytes: 100 });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.code === 'too_large'));
});

test('validateUpload: collects every failing check in one pass, not just the first', () => {
  const { valid, errors } = validateUpload({ buffer: null, mimeType: 'application/zip', documentType: 'bogus' });
  assert.equal(valid, false);
  const codes = errors.map((e) => e.code);
  assert.ok(codes.includes('empty_file'));
  assert.ok(codes.includes('unsupported_type'));
  assert.ok(codes.includes('unknown_document_type'));
});

test('DOCUMENT_TYPES / ALLOWED_MIME_TYPES cover every type this app actually collects', () => {
  ['face', 'officePhoto', 'profilePhoto', 'panDocument', 'addressProof', 'gstPhoto', 'msmePhoto',
    'bankProof', 'driverAadharFront', 'driverAadharBack', 'driverRcPhoto', 'driverDlPhoto',
    'documentPhoto', 'pod', 'invoice', 'loadingSlip'].forEach((t) => {
    assert.ok(DOCUMENT_TYPES.includes(t), `expected ${t} to be a recognized document type`);
  });
  assert.ok(ALLOWED_MIME_TYPES['image/png']);
  assert.ok(ALLOWED_MIME_TYPES['image/jpeg']);
  assert.ok(ALLOWED_MIME_TYPES['application/pdf']);
  assert.ok(!ALLOWED_MIME_TYPES['image/svg+xml'], 'SVG must never be accepted — it can carry active content');
  assert.ok(!ALLOWED_MIME_TYPES['text/html']);
});

// ---------- sanitizeFilename ----------
test('sanitizeFilename: strips directory components (no path traversal via a crafted originalName)', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Windows\\evil.exe'), 'evil.exe');
});

test('sanitizeFilename: replaces unsafe characters and falls back to a default for empty input', () => {
  assert.equal(sanitizeFilename('my file<script>.png'), 'my file_script_.png');
  assert.equal(sanitizeFilename(''), 'document');
  assert.equal(sanitizeFilename(null), 'document');
});

test('sanitizeFilename: caps length so an absurdly long name cannot be used to cause problems downstream', () => {
  const long = 'a'.repeat(500) + '.png';
  assert.ok(sanitizeFilename(long).length <= 120);
});

// ---------- generateStoredFilename ----------
test('generateStoredFilename: is unique across repeated calls for the same inputs', () => {
  const a = generateStoredFilename('profilePhoto', 'image/png');
  const b = generateStoredFilename('profilePhoto', 'image/png');
  assert.notEqual(a, b);
  assert.match(a, /^profilePhoto-\d+-[a-f0-9]{16}\.png$/);
});

test('generateStoredFilename: never derives the name from user input (a crafted documentType is sanitized)', () => {
  const name = generateStoredFilename('../../etc/passwd', 'application/pdf');
  assert.doesNotMatch(name, /\.\.|\//);
  assert.match(name, /\.pdf$/);
});

// ---------- isValidFileId / extractFileIdFromPath ----------
test('isValidFileId: accepts a well-formed 24-char hex ObjectId string, rejects everything else', () => {
  assert.equal(isValidFileId('507f1f77bcf86cd799439011'), true);
  assert.equal(isValidFileId('not-an-object-id'), false);
  assert.equal(isValidFileId('../../etc/passwd'), false);
  assert.equal(isValidFileId(''), false);
  assert.equal(isValidFileId(null), false);
});

test('extractFileIdFromPath: pulls the fileId out of a well-formed /api/files/<id> path', () => {
  assert.equal(extractFileIdFromPath('/api/files/507f1f77bcf86cd799439011'), '507f1f77bcf86cd799439011');
  assert.equal(extractFileIdFromPath('/api/files/507f1f77bcf86cd799439011?download=1'), '507f1f77bcf86cd799439011');
});

test('extractFileIdFromPath: returns null for a legacy path, garbage, or path-traversal attempt', () => {
  assert.equal(extractFileIdFromPath('/admin/kyc-photo/face-123.jpg'), null);
  assert.equal(extractFileIdFromPath('/api/files/../../../etc/passwd'), null);
  assert.equal(extractFileIdFromPath(''), null);
  assert.equal(extractFileIdFromPath(undefined), null);
});

// ---------- checkFileAccess ----------
test('checkFileAccess: admin can always view, including a soft-deleted file (for recovery review)', () => {
  assert.equal(checkFileAccess({ meta: { isDeleted: true, userId: 'BROKER-1' }, isAdmin: true }), true);
});

test('checkFileAccess: a soft-deleted file is never served to a non-admin, even the owner', () => {
  assert.equal(checkFileAccess({ meta: { isDeleted: true, userId: 'BROKER-1' }, isAdmin: false, requesterUserId: 'BROKER-1' }), false);
});

test('checkFileAccess: a user-owned file is visible only to the exact owning account', () => {
  const meta = { userId: 'BROKER-1', isDeleted: false };
  assert.equal(checkFileAccess({ meta, isAdmin: false, requesterUserId: 'BROKER-1' }), true);
  assert.equal(checkFileAccess({ meta, isAdmin: false, requesterUserId: 'BROKER-2' }), false);
  assert.equal(checkFileAccess({ meta, isAdmin: false, requesterUserId: null }), false);
});

test('checkFileAccess: an order-scoped file defers entirely to the passed-in order access result', () => {
  const meta = { orderToken: 'LS-1', isDeleted: false };
  assert.equal(checkFileAccess({ meta, isAdmin: false, requesterUserId: 'CARRIER-1', orderAccessGranted: true }), true);
  assert.equal(checkFileAccess({ meta, isAdmin: false, requesterUserId: 'CARRIER-1', orderAccessGranted: false }), false);
});

test('checkFileAccess: an unclaimed (anonymous pre-registration) file is visible to nobody but admin', () => {
  const meta = { isDeleted: false };
  assert.equal(checkFileAccess({ meta, isAdmin: false, requesterUserId: 'SHIPPER-1', orderAccessGranted: true }), false);
  assert.equal(checkFileAccess({ meta, isAdmin: true }), true);
});

test('checkFileAccess: no metadata means no access, ever', () => {
  assert.equal(checkFileAccess({ meta: null, isAdmin: false }), false);
});

// ---------- classifyLegacyPath (used by the migration script) ----------
test('classifyLegacyPath: recognizes an already-migrated GridFS reference', () => {
  assert.equal(classifyLegacyPath('/api/files/507f1f77bcf86cd799439011'), 'gridfs');
});

test('classifyLegacyPath: recognizes a base64 data URL', () => {
  assert.equal(classifyLegacyPath('data:image/png;base64,aGVsbG8='), 'base64');
  assert.equal(classifyLegacyPath('data:application/pdf;base64,aGVsbG8='), 'base64');
});

test('classifyLegacyPath: recognizes an external URL', () => {
  assert.equal(classifyLegacyPath('https://cdn.example.com/photo.jpg'), 'external-url');
  assert.equal(classifyLegacyPath('http://example.com/x.png'), 'external-url');
});

test('classifyLegacyPath: recognizes the legacy on-disk serving paths', () => {
  assert.equal(classifyLegacyPath('/admin/kyc-photo/face-123.jpg'), 'legacy-disk');
  assert.equal(classifyLegacyPath('/api/my-documents/gstPhoto-456.png'), 'legacy-disk');
});

test('classifyLegacyPath: recognizes a bare legacy filename with no leading path', () => {
  assert.equal(classifyLegacyPath('face-123-abcdef.jpg'), 'legacy-disk-bare-filename');
});

test('classifyLegacyPath: treats missing/empty values as "empty", never guesses', () => {
  assert.equal(classifyLegacyPath(''), 'empty');
  assert.equal(classifyLegacyPath(null), 'empty');
  assert.equal(classifyLegacyPath(undefined), 'empty');
});

test('classifyLegacyPath: anything else is honestly reported as "unknown" rather than assumed', () => {
  assert.equal(classifyLegacyPath('some-random-string-with-no-pattern'), 'unknown');
  assert.equal(classifyLegacyPath({ weird: 'object' }), 'unknown');
});
