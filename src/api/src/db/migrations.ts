/**
 * Boot-time migration gate. The sentinel collection `migrations` records
 * one document per migration ID that has been applied to this database.
 * `ensureIndexes` uses this to skip expensive `updateMany` backfills on
 * every boot — once a migration is recorded, subsequent boots short-circuit.
 *
 * Why a dedicated collection (not server_state): keeps the migration log
 * inspectable on its own (`db.migrations.find()` is the operator answer to
 * "what's been applied?"), and the `_id` field carries the migration name
 * directly so the collection is self-documenting.
 *
 * Failure semantics: if `recordMigration` throws (rare — only on Mongo
 * outage between updateMany completion and the sentinel insert), the next
 * boot will re-run the backfill. That's idempotent for all three callers,
 * just wasteful — we accept the rare double-run to keep the design simple.
 */

import * as pathMod from 'node:path';
import type { AnyBulkWriteOperation, Db } from 'mongodb';
import { child as childLogger } from '../log.ts';
import { slugify, dedupeSlug } from '../library/slug.ts';

export type MigrationId =
  | 'exif-captured-year-month-backfill'
  | 'place-search-blob-backfill'
  | 'asset-search-blob-backfill'
  | 'reset-describe-dead-vision-parse-2026-05-20'
  | 'reset-describe-dead-vision-parse-2026-05-21'
  | 'reset-describe-dead-vision-parse-2026-05-22'
  | 'fileinfo-backfill-2026-05-20'
  | 'merge-duplicate-assets-2026-05-21'
  | 'drop-abs-path-2026-05-21'
  | 'swap-maple-id-partial-filter-2026-05-23'
  | 'migrate-missing-since-to-fileinfo-2026-06-05'
  | 'repair-captured-year-month-2026-06-07'
  | 'drop-legacy-location-fields-2026-06-11'
  | 'backfill-folder-slugs-2026-06-16'
  | 'backfill-person-face-count-2026-06-27';

interface MigrationDoc {
  _id: MigrationId;
  applied_at: Date;
  rows: number;
}

/**
 * True when the migration has been recorded as applied.
 *
 * Takes `Db` as a parameter so the migrations module doesn't import from
 * `./client.ts` — which would create a circular import (client.ts imports
 * these helpers to gate its backfills). ESM live bindings happen to make
 * that cycle work today, but cycles are fragile under bundling and lazy
 * module init; parameterising on `Db` keeps the dependency direction
 * one-way (client → migrations).
 */
export async function migrationApplied(db: Db, id: MigrationId): Promise<boolean> {
  // Cast: the TS driver insists `_id` be ObjectId for `Collection<T>` when
  // T._id isn't an ObjectId itself. The runtime query is fine — Mongo
  // happily matches on a string _id when one exists.
  const doc = await db
    .collection<MigrationDoc>('migrations')
    .findOne({ _id: id } as Parameters<
      ReturnType<typeof db.collection<MigrationDoc>>['findOne']
    >[0]);
  return doc != null;
}

/** Records a migration as applied. Idempotent — duplicate inserts are swallowed. */
export async function recordMigration(db: Db, id: MigrationId, rows: number): Promise<void> {
  try {
    await db.collection<MigrationDoc>('migrations').insertOne({
      _id: id,
      applied_at: new Date(),
      rows,
    });
  } catch (err) {
    // E11000 duplicate key — another boot beat us to it. That's fine, the
    // sentinel is "did it ever run", not "how many times". Re-throw anything
    // else (auth failures, network errors).
    const code = (err as { code?: number } | null)?.code;
    if (code !== 11000) throw err;
  }
}

// ---------------------------------------------------------------------------
// fileinfo-backfill-2026-05-20
//
// Populate `fileinfo[0]` for legacy `assets` rows that pre-date the content-
// addressing migration. Derives the entry from `(folder_id, filename,
// abs_path)`: the library root is the `folder.path` matching `folder_id`, and
// `fileinfo[0].path` is `path.dirname(abs_path)` made relative to that root,
// then POSIX-normalised (`/` only) so it's portable across hosts. `""` means
// the file sits at the library root.
//
// Idempotent — the `$exists: false` filter on both the read cursor AND the
// write predicate prevents overwriting concurrently-populated rows (e.g. by
// the discover watcher running on the same boot).
//
// Rows whose `folder_id` doesn't resolve to a registered library, or whose
// `abs_path` escapes the library root, are left unchanged and counted in
// `skipped`. The intent is conservative: we'd rather leave a row legacy than
// store invalid `fileinfo.path` (e.g. `"../escape"`).
// ---------------------------------------------------------------------------

/**
 * Convert a relative directory produced by `path.relative` to POSIX form:
 * empty / "." → "", backslashes → forward slashes. The `FileInfo.path`
 * docstring promises `/` separators; the API only runs on Linux/macOS in
 * production but the normalization keeps the contract honest if someone
 * runs the harness on a Windows host.
 */
function toPosixRelDir(relDir: string): string {
  if (relDir === '' || relDir === '.') return '';
  return relDir.split(pathMod.sep).join('/');
}

/** A row matches the backfill if its derived rel-dir is inside the library
 * (doesn't start with `..` or resolve to an absolute path). */
function relDirIsInsideLibrary(relDir: string): boolean {
  if (relDir.startsWith('..')) return false;
  if (pathMod.isAbsolute(relDir)) return false;
  return true;
}

export interface BackfillFileinfoResult {
  scanned: number;
  updated: number;
  skipped: number;
}

const BACKFILL_BATCH_SIZE = 500;

export async function backfillFileinfo(db: Db): Promise<BackfillFileinfoResult> {
  // Build the library_id → root path map once.
  const folders = await db
    .collection('folders')
    .find({}, { projection: { path: 1 } })
    .toArray();
  const folderMap = new Map<string, string>();
  for (const f of folders) {
    folderMap.set((f._id as { toHexString: () => string }).toHexString(), f.path as string);
  }

  const cursor = db
    .collection('assets')
    .find(
      { fileinfo: { $exists: false }, abs_path: { $exists: true } },
      { projection: { _id: 1, folder_id: 1, filename: 1, abs_path: 1 } },
    );

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let batch: AnyBulkWriteOperation[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const res = await db.collection('assets').bulkWrite(batch, { ordered: false });
    updated += res.modifiedCount ?? 0;
    batch = [];
  };

  for await (const doc of cursor) {
    scanned += 1;
    const folderId = doc.folder_id as { toHexString: () => string } | undefined;
    const libRoot = folderId ? folderMap.get(folderId.toHexString()) : undefined;
    if (!libRoot || !doc.abs_path) {
      skipped += 1;
      continue;
    }
    const relDir = pathMod.relative(libRoot, pathMod.dirname(doc.abs_path as string));
    if (!relDirIsInsideLibrary(relDir)) {
      skipped += 1;
      continue;
    }
    batch.push({
      updateOne: {
        // Re-check `fileinfo: { $exists: false }` on the write so a row
        // populated between cursor read and bulk flush stays untouched.
        filter: { _id: doc._id, fileinfo: { $exists: false } },
        update: {
          $set: {
            fileinfo: [
              {
                path: toPosixRelDir(relDir),
                filename: doc.filename as string,
                library_id: doc.folder_id,
              },
            ],
          },
        },
      },
    });
    if (batch.length >= BACKFILL_BATCH_SIZE) await flush();
  }
  await flush();
  return { scanned, updated, skipped };
}

// merge-duplicate-assets-2026-05-21 — healing pass: collapse pre-existing
// rows that share a `maple_id` into a single row with a union of every
// group member's `fileinfo[]`. Impl in migrations.merge-duplicates.ts (kept
// out of this file to stay under the file-size budget — it's the largest
// single migration and the batching refactor needs room to breathe).
export type { MergeDuplicatesResult } from './migrations.merge-duplicates.ts';
export { mergeDuplicateAssets } from './migrations.merge-duplicates.ts';

// ---------------------------------------------------------------------------
// drop-abs-path-2026-05-21 pre-flight
//
// Final PR of the content-addressing migration retires the legacy
// `abs_path` / `filename` / `folder_id` indexes. Before dropping them we
// need to be sure every LIVE asset carries `fileinfo` — otherwise readers
// that fall back through to the legacy fields would have no source of
// truth left.
//
// Returns the count of live rows still missing `fileinfo`. 0 means safe to
// proceed; > 0 means an operator must re-run discover so the watcher can
// backfill the field before the index drop will run.
// ---------------------------------------------------------------------------

/**
 * Pre-flight for the abs_path drop: refuse to drop the legacy fields if any
 * live (`deleted_at: null`) row is still missing `fileinfo`. Returns the
 * count of legacy rows (0 means safe to proceed). Caller decides whether
 * to abort the deploy or log + skip the index drops.
 */
export async function countAssetsMissingFileinfo(db: Db): Promise<number> {
  // Match the same live-row predicate the API uses (see
  // `routes/search/query.ts` `applyLiveFilter`): `deleted_at: null` OR the
  // field is absent. Legacy rows that pre-date the indexer's explicit
  // `deleted_at: null` write would slip past a strict `deleted_at: null`
  // filter — counting them as 0 here would let the index drop run and
  // strand those rows in an unindexed state.
  return await db.collection('assets').countDocuments({
    fileinfo: { $exists: false },
    $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }],
  });
}

// ---------------------------------------------------------------------------
// drop-legacy-location-fields-2026-06-11
//
// Reclaim the bytes the content-addressing migration left behind. That
// migration retired the location triple (`abs_path` / `folder_id` / `filename`)
// and the derived-cache paths (`thumb_path` / `preview_path`) in CODE — no
// writer sets them and no reader consults them (locations resolve from
// `fileinfo[]`; cache paths recompute from `(library root, fileinfo[0].path,
// maple_id)`) — but it only dropped the legacy *indexes*. The field VALUES
// stayed on every row indexed before the cutover, as dead weight. This one-shot
// `$unset` removes them.
//
// Scoped to rows that carry a PRIMARY `fileinfo` entry (`fileinfo.0` exists,
// i.e. a non-empty array). A legacy row still missing `fileinfo` — OR carrying
// a degenerate empty `fileinfo: []` — keeps `abs_path` / `folder_id` /
// `filename`: with no primary entry there is nothing to resolve a location
// from, so those fields are the only thing its path could be rebuilt from once
// the library is re-registered and discover re-runs. (`fileinfo.0` is the same
// "has at least one entry" predicate the missing_since→fileinfo migration uses;
// a bare `$type: 'array'` would also match `[]` and strip a row we must keep.)
// `thumb_path` / `preview_path` are never read on any row, but gating the whole
// cleanup on the primary-entry predicate keeps it a single, obviously-safe
// `updateMany`.
//
// Idempotent — `$unset` on an already-clean row is a no-op. Sentinel-gated in
// `ensureIndexes` (and ordered AFTER the fileinfo backfill there, so a row
// backfilled this boot is cleaned in the same pass).
// ---------------------------------------------------------------------------

export interface DropLegacyLocationFieldsResult {
  cleared: number;
}

export async function dropLegacyLocationFields(db: Db): Promise<DropLegacyLocationFieldsResult> {
  const res = await db.collection('assets').updateMany(
    {
      // Require a primary fileinfo entry (non-empty array). `fileinfo.0`
      // existing implies `fileinfo` is an array AND has ≥1 element, so a
      // degenerate `fileinfo: []` row is left untouched (its legacy fields are
      // the only source its location could be rebuilt from).
      'fileinfo.0': { $exists: true },
      $or: [
        { abs_path: { $exists: true } },
        { folder_id: { $exists: true } },
        { filename: { $exists: true } },
        { thumb_path: { $exists: true } },
        { preview_path: { $exists: true } },
      ],
    },
    {
      $unset: {
        abs_path: '',
        folder_id: '',
        filename: '',
        thumb_path: '',
        preview_path: '',
      },
    },
  );
  return { cleared: res.modifiedCount ?? 0 };
}

// ---------------------------------------------------------------------------
// backfill-folder-slugs-2026-06-16
//
// Mints a `slug` for every `folders` document that lacks one. Deterministic:
// documents are processed in `_id` order (ascending insertion order), so
// deduplication is stable across reruns. Idempotent: rows that already carry
// a `slug` are skipped. The unique `folders_slug_unique` index is created
// AFTER this backfill runs (see ensureIndexes ordering in client.ts).
// ---------------------------------------------------------------------------

export interface BackfillFolderSlugsResult {
  updated: number;
  skipped: number;
}

const FOLDER_SLUG_BATCH_SIZE = 500;

export async function backfillFolderSlugs(db: Db): Promise<BackfillFolderSlugsResult> {
  const slugsLog = childLogger('db:migrations:folder-slugs');

  // Seed the taken set with slugs already assigned so dedup is collision-safe
  // even in partial-run scenarios.
  const existing = await db
    .collection('folders')
    .find({ slug: { $exists: true, $ne: null } }, { projection: { slug: 1 } })
    .toArray();
  const taken = new Set<string>(existing.map((d) => d.slug as string).filter(Boolean));

  const cursor = db
    .collection('folders')
    .find(
      { $or: [{ slug: { $exists: false } }, { slug: null }] },
      { projection: { _id: 1, label: 1, path: 1 } },
    )
    .sort({ _id: 1 });

  let updated = 0;
  let skipped = 0;
  let batch: AnyBulkWriteOperation[] = [];

  // `bulkWrite` reports matched/modified counts for the whole chunk, not per
  // op — a doc's guard filter only fails to match when another writer set
  // its slug between the cursor read and this flush, so
  // `chunk size - modifiedCount` is exactly the skipped count for that chunk.
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const res = await db.collection('folders').bulkWrite(batch, { ordered: false });
    const modified = res.modifiedCount ?? 0;
    updated += modified;
    skipped += batch.length - modified;
    batch = [];
  };

  for await (const doc of cursor) {
    // Slug derivation stays strictly sequential per doc — only the writes
    // that follow are batched — so `taken` always reflects every slug minted
    // so far in this pass, including ones still sitting in an unflushed batch.
    const label = (doc.label as string | undefined) ?? '';
    const base = slugify(label || pathMod.basename(doc.path as string) || 'library');
    const slug = dedupeSlug(base, taken);
    taken.add(slug);
    batch.push({
      updateOne: {
        // Guard filter preserved verbatim: re-check on write so a row
        // populated between cursor read and bulk flush stays untouched.
        filter: { _id: doc._id, $or: [{ slug: { $exists: false } }, { slug: null }] },
        update: { $set: { slug } },
      },
    });
    if (batch.length >= FOLDER_SLUG_BATCH_SIZE) await flush();
  }
  await flush();

  slugsLog.info({ updated, skipped }, 'backfilled folder slugs');
  return { updated, skipped };
}

// ---------------------------------------------------------------------------
// fileinfo compound index uniqueness hardening (Task 2b)
//
// Checks for duplicate (library_id, path, filename) tuples in the assets
// collection. If zero violations, promotes the compound index to unique. If
// violations exist, logs them and leaves the non-unique index in place.
// Called from ensureIndexes() after the non-unique `fileinfo_lib_path_name`
// index has been created.
// ---------------------------------------------------------------------------

export interface FileinfoUniquenessResult {
  violations: number;
  promoted: boolean;
}

export async function hardenFileinfoCompoundIndex(db: Db): Promise<FileinfoUniquenessResult> {
  const uniqueLog = childLogger('db:migrations:fileinfo-unique');

  // Count groups with size > 1 — each such group is a duplicate tuple.
  const pipeline = [
    { $unwind: '$fileinfo' },
    {
      $group: {
        _id: {
          library_id: '$fileinfo.library_id',
          path: '$fileinfo.path',
          filename: '$fileinfo.filename',
        },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $count: 'total' },
  ];

  const result = await db.collection('assets').aggregate(pipeline).toArray();
  const violations = result[0]?.total ?? 0;

  if (violations > 0) {
    // Log the offending tuples for operator inspection (up to 10 for brevity).
    const dupPipeline = [
      { $unwind: '$fileinfo' },
      {
        $group: {
          _id: {
            library_id: '$fileinfo.library_id',
            path: '$fileinfo.path',
            filename: '$fileinfo.filename',
          },
          count: { $sum: 1 },
          maple_ids: { $push: '$maple_id' },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 10 },
    ];
    const dups = await db.collection('assets').aggregate(dupPipeline).toArray();
    uniqueLog.warn(
      { violations, sample: dups },
      '[STOP] fileinfo compound uniqueness violations detected — unique index NOT created; operator must resolve duplicates before re-running',
    );
    return { violations, promoted: false };
  }

  // Zero violations — safe to promote to unique.
  // The partialFilterExpression restricts the unique constraint to rows that
  // actually have at least one fileinfo entry (excludes skeleton rows and rows
  // without fileinfo, which would otherwise all collide on null keys).
  await db.collection('assets').createIndex(
    { 'fileinfo.library_id': 1, 'fileinfo.path': 1, 'fileinfo.filename': 1 },
    {
      unique: true,
      name: 'fileinfo_lib_path_name_unique',
      partialFilterExpression: { 'fileinfo.0': { $exists: true } },
    },
  );

  // Drop the redundant non-unique base index now that the unique one covers the
  // same key. Keeping both would cause every write to update two identical index
  // entries (write amplification). The unique index satisfies all read queries
  // that the base index did. Silently ignore "index not found" — the base index
  // may already have been dropped on a previous deploy.
  await db
    .collection('assets')
    .dropIndex('fileinfo_lib_path_name')
    .catch((err: { codeName?: string }) => {
      if (err.codeName !== 'IndexNotFound') throw err;
    });

  uniqueLog.info(
    'promoted fileinfo compound index to unique; dropped redundant non-unique base index',
  );
  return { violations: 0, promoted: true };
}

// backfill-person-face-count-2026-06-27 — populate `face_count` on every live
// person so GET /api/people reads it directly instead of running an O(total-
// faces) $unwind per request (#1594). Impl in people-face-count.repo.ts.
export type { BackfillPersonFaceCountResult } from '../people/people-face-count.repo.ts';
export { backfillPersonFaceCount } from '../people/people-face-count.repo.ts';
