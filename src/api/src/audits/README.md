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

## Impact verification status

No production database or representative snapshot has been provided for this
change. **Stored-data impact and the migration decision remain unresolved.**
Synthetic temporary-Mongo tests prove detection, collision reporting, repeatable
execution and no mutations; they do not establish zero affected production rows.
Do not close #3642 or deploy normalization based on those synthetic results.

If the representative audit reports affected records, the issue requires a
versioned, resumable migration using the existing migration mechanisms before
completion. Do not infer replacement IDs from permissive parsing. Case folding
is a proven normalization only after collision and reference review. Malformed
IDs require authoritative bytes/metadata and provenance; ambiguous records must
remain recoverable. Preserve `_id`, originals, edits and file paths. The migration
must include dry-run mappings, collision checks, external-ID compatibility,
writer coordination, reference updates and a rollback/recovery procedure. A
clean representative audit plus unchanged generation can justify no migration;
attach that evidence to the issue instead of adding an empty rewrite migration.

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
