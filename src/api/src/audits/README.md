# Maple ID impact audit (#3642)

Run from `src/api` with the existing `MAPLE_MONGO_URI` and `MAPLE_MONGO_DB`
set explicitly, preferably using a read-only Mongo user:

```sh
bun scripts/audit-maple-ids.ts > maple-id-audit.jsonl
```

The command uses a direct MongoClient, **not** the application connection
initializer (which can create indexes and run migrations). It never writes to
Mongo or opens original photo files. Findings stream as JSON lines, followed by
a `complete` summary. An interrupted report has no complete marker; rerun it.
A live scan is not a consistent snapshot: use a restored snapshot or quiesce
writers for conclusive impact evidence. Reports contain database record IDs.

## Coverage and interpretation

- `assets.maple_id`: canonical content keys; report missing/null/empty separately
  as legacy, malformed values, and valid uppercase/mixed-case values.
- `upload_sessions.maple_id`: retained completed-upload references, including
  synthetic rendered/video sessions. Missing values are normal while uploading.
- `video_geo_backfill_audit.maple_id` and `donor_maple_id`: historical video
  migration provenance. Missing donor IDs are expected for `no-donor` decisions.
- `meilisearch_backfill_failures.maple_id`: search retry references. Their `_id`
  is the stable Mongo asset ID, not the content ID.
- Case-fold collisions count distinct **asset owners**, not repeated session
  references. Each colliding owner is emitted separately. Nothing is merged.
- Unresolved references are reported separately; an EXIF fallback-to-primary
  upgrade can leave an old session reference. This is not automatically damage.
- Unknown tag bytes remain syntactically valid, matching Rust. A valid hex
  string is never evidence that an ID was derived from the correct photo.

Other Mongo links (fileinfo, jobs, imports, change feed, faces) use ObjectId or
file paths rather than content IDs. External consumers include Meilisearch
(document `id`), native backup state, browser IndexedDB and historical derivative
cache keys. Current edge thumbnail keys are path-based. This Mongo audit does
not certify external search/cache/client state; any re-key migration must cover
those consumers and preserve old-client compatibility explicitly.

## Derivation and deployment

The parser lives in the browser library's dependency-free `maple-id-parser.ts`;
the API imports that same source. The API Docker runtime copies that file at the
matching relative path. There are no filesystem or hashing imports in it.
Both parsers lowercase valid input; unknown tags retain their existing behavior.
All client ID boundaries (ingest, rendered ingest, sidecar lookup, exists probe)
reject malformed IDs. Final-chunk ID presence is checked before session/chunk
writes, so a corrected retry starts at the same offset.

No hashing formulas change. In particular, server `hashFileForId` retains its
legacy **head-only** fallback, while browser streaming fallback hashes the whole
file. The 70,001-byte regression fixture pins both distinct results and primary
output. Changing that policy is outside #3642.

## Verified database impact (2026-09-15)

The user-designated server's `maple` database was audited read-only. The initial
scan and expanded scan agreed on asset/session counts. The expanded scan ran
from 2026-09-15T20:38:54.848Z to 2026-09-15T20:39:08.506Z.
The server is standalone; these are live observations, not a consistent snapshot.
No database records, indexes, original files, or user edits were written.

| Collection / field                      | Canonical | Malformed | Case differences | Missing / legacy |
| --------------------------------------- | --------: | --------: | ---------------: | ---------------: |
| assets.maple_id                         |   335,286 |         0 |                0 |               63 |
| upload_sessions.maple_id                |         4 |         0 |                0 |               40 |
| meilisearch_backfill_failures.maple_id  |         0 |         0 |                0 |                0 |
| video_geo_backfill_audit.maple_id       |     8,114 |         0 |                0 |                0 |
| video_geo_backfill_audit.donor_maple_id |     2,398 |         0 |                0 |            5,716 |

- **Zero case-fold collision groups.** The live `maple_id_gt_1` asset index is
  unique with partial filter `{ maple_id: { $gt: '' } }`.
- All 40 sessions without IDs are `state: open`. All 5,716 missing donor IDs
  correspond to `decision: no-donor`.
- The 63 assets without IDs have absent fields (not invalid hex): 62 live image
  records and one deleted image record. They are classified as missing/legacy;
  the parser fix does not supply identity for them, and no IDs were invented.
- Twelve historical video-audit references no longer resolve by content ID.
  Looking up their stable asset `_id` found six absent assets and six assets
  with changed IDs. None is malformed or noncanonical. Historical provenance
  was retained. Upload-session, donor and search-retry references had zero
  unresolved IDs.

**Migration decision: no ID rewrite is needed for this correction in the audited
records.** There are no malformed or noncanonical stored IDs to repair, no
normalization collisions, and existing generation remains byte-for-byte unchanged
(including the legacy server fallback). Missing legacy values and historical
references are not evidence of permissive-parser corruption. A syntactically
valid ID is not proof of correct derivation; original bytes were not rehashed.
External Meilisearch/client/cache state was not independently scanned, and this
result does not claim byte-derived identity verification. No valid record is
re-keyed, so no downstream reference migration or old-ID alias is introduced.

The committed aggregate evidence is `maple-ids-evidence.json`. Detailed JSONL
findings stay local to avoid publishing individual production record IDs.
If later audits find affected records, #3642's migration requirements apply:
versioned/resumable repair with authoritative provenance, collision checks,
reference and old-client compatibility, writer coordination and recovery.

## Local validation (2026-09-15)

- 76 existing backup tests passed against an isolated temporary MongoDB.
- 19 focused TypeScript parser, file hashing, upload and audit tests passed.
- 18 browser ID unit tests passed with Vitest; the pure parser bundled for a
  browser without server imports.
- 19 Rust ID tests passed, including the shared parser vectors and large-file
  streaming golden.
- Formatting, changed-source lint and file-budget/headroom checks passed.
- Full Angular test compilation was blocked by missing local dependencies
  (`maplibre-gl`) and stale local WASM exports. The API-wide typecheck also
  reports existing errors outside the new implementation; it is not a clean
  validation signal for this change.
