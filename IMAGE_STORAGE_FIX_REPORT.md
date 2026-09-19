# Fix: User Photos & Admin KYC Image Visibility (GridFS Migration)

Implementation report for: *"Fix LoadSmart User Photos and Admin KYC Image Visibility."*

## 1. Root cause (confirmed, not guessed)

Every uploaded photo/KYC document (`POST /api/kyc/upload`) was written with `fs.writeFileSync()` to a local folder, `private-uploads/kyc/`, on the app server's own disk. The Registration/BookingRequest/Truck document then stored only a **path string** pointing at that file (`/admin/kyc-photo/<filename>`).

This deployment's local disk is **not persistent across a server restart or redeploy** — confirmed by a prior developer's own diagnostic comment already present in `lib/kycFileStore.js`, and by the very existence of that file, which was an earlier partial fix (a raw `Buffer` backup in a normal Mongo collection). When the disk is wiped, the DB record's path string survives, but the file it points at is gone — producing exactly the reported symptom: photos and KYC documents that work for a day or two, then break.

The Buffer-in-Mongo backup mitigated data loss going forward but was not GridFS, had no per-document metadata/verification/soft-delete support, and had at least one confirmed gap: `runPodAiCheck()` read straight from disk with no fallback at all, and `runBrokerDocumentReview()` had the same gap. A second, related bug was found in the same investigation: the auto-generated **Transport Invoice** was generated once and cached to the same non-persistent disk (unlike the Load Invoice, which already regenerated fresh on every view) — so it was silently vulnerable to the identical root cause even though it isn't a user upload.

No image was stored as an expiring signed cloud URL or a temporary third-party link — this is a pure local-disk-persistence problem, entirely within this app's own code.

## 2. What changed, end to end

| Requirement | Status | Notes |
|---|---|---|
| Permanent storage via GridFS, separate bucket | ✅ Done | `lib/fileStorageService.js` + `lib/fileStorageModels.js`, bucket `loadsmartFiles` (configurable) |
| Reusable service for every document type listed | ✅ Done | One `uploadBuffer()`/`/api/kyc/upload` path already covers profile photo, selfie, PAN, Aadhaar, GST, MSME, bank proof, company/vehicle/driver documents, POD |
| Only fileId + metadata stored on the record | ✅ Done | Existing `...Path` fields now hold `/api/files/<fileId>`, never bytes |
| Upload validation (type, size, unique name) | ✅ Done | `validateUpload()` — MIME whitelist, size cap, generated filename never derived from user input |
| Secure retrieval routes | ✅ Done | `GET /api/files/:fileId`, `GET /api/admin/users/:userId/documents`, `GET /api/admin/users/:userId/photo` |
| Admin KYC review UI | ✅ Done | New "KYC Docs" modal (all roles) + per-document Approve/Reject/Request re-upload |
| DB schema — inspect first, additive only | ✅ Done | No existing collection touched; one new `FileMeta` collection |
| Migration of existing images | ✅ Done (script; not run — no live DB here) | `scripts/migrateImagesToGridFS.js`, dry-run supported |
| Frontend stable URLs, no expiring cache | ✅ Done | `/api/files/<fileId>` never changes; two pre-existing frontend bugs fixed (see below) |
| Cloud/deployment — no reliance on local disk | ✅ Done | New uploads never touch disk; transport invoice now regenerates on demand instead of caching |
| Security — auth, RBAC, audit log | ✅ Done | Reuses existing bearer-token sessions + `canAccessOrderDocuments`; new audit log entries via the existing `logActivity()`/`ActivityLog` |
| Tests | ✅ 30 new, 241/241 passing | Pure-logic unit tests; see §7 for why GridFS I/O itself isn't integration-tested here |

## 3. New files

- **`lib/fileStorageModels.js`** — `FileMeta` Mongoose model: `fileId`, `bucketName`, `userId`/`ownerRole` (user-owned) or `orderToken` (order-scoped), `documentType`, `originalName`, `storedFilename`, `mimeType`, `size`, `uploadedAt`, `uploadedBy`/`uploadedByRole`, `verificationStatus` (`NOT_REVIEWED`/`APPROVED`/`REJECTED`/`REUPLOAD_REQUESTED`), `verificationReason`, `verifiedBy`/`verifiedAt`, `isDeleted`/`deletedAt`/`deletedBy`, `legacyMigratedFrom`. Indexes on `userId`, `documentType`, `uploadedAt`, `verificationStatus`, `orderToken`, plus two compound indexes.
- **`lib/fileStorageService.js`** — the reusable storage service: GridFS init/upload/download, validation, filename generation, the `checkFileAccess()` authorization decision, `classifyLegacyPath()` (used by both the migration script and its own logic), claim-for-user/claim-for-order, verification status, soft delete/restore. Pure functions are exported separately from the Mongo I/O specifically so they're unit-testable without a live database.
- **`scripts/migrateImagesToGridFS.js`** — one-time, safely re-runnable migration (see §6).
- **`test/fileStorageService.test.js`** — 30 tests (validation, filename/ID handling, access control, legacy-path classification).

## 4. Edited files

- **`server_load.js`** — the bulk of the work:
  - GridFS bucket initialized right after `mongoose.connect()` resolves (`fileStorageService.init(...)`), using `FILE_BUCKET_NAME`.
  - `POST /api/kyc/upload` now uploads straight to GridFS (no disk write at all for new uploads) and returns `/api/files/<fileId>` instead of `/admin/kyc-photo/<filename>`. Opportunistically stamps ownership immediately when the uploader already has a session (e.g., a broker re-uploading from their portal); anonymous pre-registration uploads stay unclaimed until claimed below.
  - **New routes**: `GET /api/files/:fileId` (the single retrieval endpoint every document type uses — auth + ownership/order/admin check, correct `Content-Type`/`Content-Disposition`, `?download=1` for a forced download, never caches a private response), `GET /api/admin/users/:userId/documents` (full per-user document list + which expected document types are missing, never invented), `GET /api/admin/users/:userId/photo` (the user's main photo, handles both new and legacy formats), `PATCH /api/admin/documents/:fileId/verify` (Approve/Reject/Request re-upload), `POST /api/admin/documents/:fileId/delete` / `.../restore` (soft delete + recovery). All five admin routes are gated by the existing `requireAdmin` **and** a new `ADMIN_FILE_ACCESS_ENABLED` kill-switch.
  - **Claim-on-attach**: `claimUploadedDocsInPayload()` runs inside `saveSubmission()` (the one function all three registration routes funnel through) right after the account is created, claiming every `/api/files/<fileId>` reference in the submitted payload for that new account. The same claim call was added to the broker document-attach route, the carrier driver-document update route, the carrier truck create/update routes (vehicle documents), and — using the order-scoped variant — the shipper invoice-upload and both carrier/driver POD-upload routes. `claimFileForUser`/`claimFileForOrder` both refuse to reassign a file someone else already owns, closing off a "reference someone else's fileId to gain view access" attack.
  - Every route that used to gate an incoming path on `.startsWith('/admin/kyc-photo/')` now accepts **either** the legacy format or the new `/api/files/<fileId>` format (`isKnownDocPath()`), so nothing that already worked stops working.
  - `runPodAiCheck()` and `runBrokerDocumentReview()` (both pre-existing AI advisory features) previously read image bytes straight off disk with no fallback — found during inspection as a related bug where the AI check would silently no-op if the disk copy was already lost. Both now go through a shared `readStoredDocBytes()` helper that reads from GridFS (new format) or disk+`kycFileStore` backup (legacy format).
  - `GET /api/orders/:token/document/:kind` — `shipper-invoice`/`pod` now stream directly from GridFS when the stored path is in the new format. **Transport Invoice** now regenerates fresh on every view (same pattern the Load Invoice already used) instead of relying on a cached disk file — this closes the second, related persistence bug found during inspection, since a transport invoice's content is entirely derivable from the order and never needs to be "recovered."
  - New `requireAdminFileAccessEnabled` middleware — a deployment-level kill-switch (`ADMIN_FILE_ACCESS_ENABLED=false`) on top of the existing admin-session check.
- **`views/admin/list.js`**:
  - Generic-table photo thumbnails now show **"Document not uploaded"** for a missing field (never a broken image), and a broken/expired image now swaps itself for **"Photo unavailable"** via `onerror` (previously only the Shipper/Broker detail views had this; the generic table — which is what Carrier uses — did not).
  - New **KYC Documents modal**, opened from a "KYC Docs" button next to every row's ID (covers Carrier, which previously had no dedicated document-review UI at all) and from a "KYC Document Review" button added to the Shipper and Broker detail views. Shows every uploaded document (thumbnail/PDF link, upload date, size, verification status) plus which expected documents are still missing, with **Approve / Reject / Request re-upload** buttons wired to the new admin endpoints.
- **`views/portal/broker-dashboard.js`** — `myDocUrl()` had a real bug: it never appended `?token=`, so a broker's own KYC document links were silently returning 401 when clicked (a plain `<a href>` navigation can't carry a bearer header). Fixed, and extended to route new-format `/api/files/<fileId>` paths directly instead of always assuming the legacy filename shape.
- **`views/portal/details.js`** — `selfDocUrl()` had the same "assumes legacy filename shape" limitation; extended the same way (token append already worked correctly here).
- **`.env.example`** — added `FILE_BUCKET_NAME`, `FILE_MAX_SIZE_MB`, `ADMIN_FILE_ACCESS_ENABLED`.

## 5. Database changes

One new collection, **`filemetas`** (via the `FileMeta` model) — see §3 for its fields and indexes. No existing collection's schema changed, no existing field was renamed or removed, and no backfill/migration is required for the app to keep running — every `...Path` field keeps its exact existing name and meaning; only the *shape of new values* changes (`/api/files/<fileId>` instead of `/admin/kyc-photo/<filename>`). Old records are read exactly as before via the unchanged legacy serving routes.

The migration script also creates **`filemigrationlogs`** — a permanent, queryable audit trail of every migration attempt (see §6).

## 6. Migration of existing images

Run once against your real database:

```bash
node scripts/migrateImagesToGridFS.js --dry-run   # report only, writes nothing
node scripts/migrateImagesToGridFS.js             # actually migrate
```

For every `...Path` field on every Registration/BookingRequest/Truck record, the script:

1. Classifies the current value (`classifyLegacyPath()`): already-migrated GridFS reference, legacy on-disk path, bare legacy filename, a literal base64 data URL, an external URL, empty, or unrecognized. Nothing is guessed.
2. If recoverable (still on local disk, or in the `lib/kycFileStore.js` durable Mongo backup, or a decodable base64 value), uploads it to GridFS and updates the record's field to `/api/files/<fileId>`.
3. Logs every attempt — success or failure — to the `filemigrationlogs` collection and to the console.
4. **Never deletes** the original file/backup, regardless of outcome, and never invents a placeholder for a file it can't recover.
5. An external URL is deliberately left untouched (the script does not fetch third-party URLs); it's reported as `skipped-external-url` in the log for a human to review — this codebase's own upload flow has never produced one, so in practice this branch exists for defensive completeness, not an expected case.

**This script has not been run against a live database in this environment** — there is no live MongoDB reachable from this sandbox (confirmed in the prior session's investigation too), so "images that could not be recovered" cannot be reported here. Run the dry-run first against your real deployment's database and review its console/`.filemigrationlogs` output before running it for real.

## 7. Required environment variables

```
MONGODB_URI=<your connection string — unchanged>
FILE_BUCKET_NAME=loadsmartFiles      # GridFS bucket name (new, has a sane default)
FILE_MAX_SIZE_MB=10                  # new upload size cap (server-side, before GridFS)
ADMIN_FILE_ACCESS_ENABLED=true       # kill-switch for the 5 new admin file routes
```

No new secrets are introduced, and nothing new is exposed to the frontend — the frontend only ever sees `/api/files/<fileId>` reference strings, never a connection string, bucket internals, or a file path.

## 8. Test results

```
npm test
# tests 241
# pass 241
# fail 0
```

211 pre-existing tests still pass unchanged (no regressions). 30 new tests in `test/fileStorageService.test.js`: upload validation (type/size/empty/unknown-type, all failures collected in one pass), filename sanitization (path-traversal via a crafted original name), unique stored-filename generation (never derived from user input), file-id validation/extraction, the full `checkFileAccess()` decision matrix (admin-always, soft-deleted-hidden-from-non-admin, owner-only, order-scoped-defers-to-existing-check, unclaimed-is-admin-only, no-metadata-means-no-access), and every branch of `classifyLegacyPath()`.

**What is and isn't covered here, honestly**: exactly as documented in the prior Broker Portal report for this same project, there is no live MongoDB reachable from this environment, so the actual GridFS read/write path (upload → download → claim → soft-delete → restore → "survives a reconnect") could not be exercised end-to-end here. I attempted to install `mongodb-memory-server` and run a full integration check (upload/download byte-for-byte round-trip, ownership-claim/steal-attempt, soft-delete+restore, order-scoped access, and a simulated disconnect/reconnect standing in for a server restart) — the package installed, but downloading the actual `mongod` binary is blocked by this sandbox's network allowlist, so that check could not run here. **This is the one thing that most needs verification against your real deployment before you rely on it**: run `scripts/migrateImagesToGridFS.js --dry-run` against a copy of your real database, and manually verify one upload → admin-view → restart-the-server → admin-view-again cycle in a staging environment. Everything else (routing, RBAC logic, request/response shape, schema, backward compatibility with legacy records) was verified by code review, `node -c` syntax checks, and the full existing test suite passing with zero regressions — the same verification approach already used for the rest of this codebase's Mongo-dependent code.

## 9. Known, deliberate limitations

- **External URLs are never fetched by the migration script** (§6) — not a gap in practice, since nothing in this app's upload flow currently produces one, but called out rather than silently ignored.
- **The generic admin table's per-role "expected document" list (`ADMIN_REVIEW_DOC_TYPES`) is a best-effort summary**, not a live reflection of every dynamic field a `strict:false` schema could theoretically hold — it lists the documents each role's registration form actually collects today.
- **GridFS I/O itself was not integration-tested in this environment** (§7) — verify the upload → restart → still-visible cycle in your own staging environment before considering this fully closed out.
