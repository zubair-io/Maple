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
import type { AnyBulkWriteOperation, Db, ObjectId } from 'mongodb';
import { child as childLogger } from '../log.ts';

const log = childLogger('db:migrations');

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
  | 'swap-maple-id-partial-filter-2026-05-23';

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

// ---------------------------------------------------------------------------
// merge-duplicate-assets-2026-05-21
//
// Healing pass: collapse pre-existing rows that share a `maple_id` into a
// single row with a union of every group member's `fileinfo[]`.
//
// Why this exists even though the unique partial index `maple_id_gt_1`
// forbids the state: on deploys where the index was never built (or was
// dropped at some point) and PR 1's hash-stage races didn't merge cleanly,
// the collection can carry "physical" duplicates that the runtime
// constraint would now reject on insert. `ensureIndexes` calls this
// BEFORE the `maple_id_gt_1` createIndex so the index creation succeeds
// on the cleaned-up state — without this ordering, `createIndex` would
// throw `DuplicateKey` and the boot would abort.
//
// Survivor rule: earliest `indexed_at` wins. This is the row most likely to
// carry user-edited fields (rating, flag, color_label, faces, sidecar
// mirrors). Ties on `indexed_at` are broken by `_id.toString()` so the
// outcome is deterministic across boots.
//
// User-edited fields are NOT merged across rows — only the survivor's are
// kept. Operators are expected to redo any edits made on losers; we log
// the survivor + loser ids so audit is possible.
//
// Idempotent: a second call finds zero groups and is a no-op. Sentinel-gated
// in `ensureIndexes` so it only runs once per database.
// ---------------------------------------------------------------------------

export interface MergeDuplicatesResult {
  scanned_groups: number;
  merged_groups: number;
  deleted_rows: number;
}

interface DupGroup {
  _id: string;
  ids: ObjectId[];
  count: number;
}

interface FileInfoEntryShape {
  path: string;
  filename: string;
  library_id: ObjectId;
  deleted_at?: string | null;
}

export async function mergeDuplicateAssets(db: Db): Promise<MergeDuplicatesResult> {
  const dupes = await db
    .collection('assets')
    .aggregate<DupGroup>([
      { $match: { maple_id: { $type: 'string' } } },
      { $group: { _id: '$maple_id', ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  let merged_groups = 0;
  let deleted_rows = 0;

  for (const group of dupes) {
    // Projection: we only need the fields used by the survivor pick and the
    // fileinfo union. Pulling whole docs would drag along `vision`,
    // `search_blob`, etc. for every loser we're about to delete.
    const rows = await db
      .collection('assets')
      .find(
        { _id: { $in: group.ids } },
        {
          projection: {
            _id: 1,
            indexed_at: 1,
            fileinfo: 1,
            rating: 1,
            flag: 1,
            color_label: 1,
          },
        },
      )
      .toArray();
    if (rows.length < 2) continue;

    // Earliest indexed_at survives; ties broken by _id for determinism.
    rows.sort((a, b) => {
      const ai = (a.indexed_at as string) ?? '';
      const bi = (b.indexed_at as string) ?? '';
      if (ai === bi) return a._id.toString().localeCompare(b._id.toString());
      return ai.localeCompare(bi);
    });
    const survivor = rows[0]!;
    const losers = rows.slice(1);

    // Union fileinfo across the group, de-duped by (library_id, path, filename).
    // Key uses JSON.stringify so `|` (or any other separator) appearing inside
    // `path` / `filename` can't cause collisions.
    //
    // When two entries share the key but one is live (`deleted_at` absent/null)
    // and the other is tombstoned, prefer the live entry — otherwise the
    // first-wins ordering could preserve a deleted entry for a path that's
    // actually still on disk on another row.
    const seen = new Map<string, FileInfoEntryShape>();
    for (const row of rows) {
      const list = (row.fileinfo ?? []) as FileInfoEntryShape[];
      for (const entry of list) {
        const key = JSON.stringify([entry.library_id.toHexString(), entry.path, entry.filename]);
        const existing = seen.get(key);
        if (!existing) {
          seen.set(key, entry);
          continue;
        }
        const existingDead = existing.deleted_at != null;
        const candidateDead = entry.deleted_at != null;
        if (existingDead && !candidateDead) {
          seen.set(key, entry);
        }
        // Otherwise (both live, both dead, or candidate dead while existing
        // live) keep the existing entry — first-seen wins.
      }
    }
    const merged = Array.from(seen.values());

    await db.collection('assets').updateOne({ _id: survivor._id }, { $set: { fileinfo: merged } });
    const del = await db
      .collection('assets')
      .deleteMany({ _id: { $in: losers.map((l) => l._id) } });
    merged_groups += 1;
    deleted_rows += del.deletedCount ?? 0;
    log.info(
      {
        maple_id: group._id,
        survivor: survivor._id.toHexString(),
        losers: losers.map((l) => l._id.toHexString()),
        merged_locations: merged.length,
      },
      'merge-duplicate-assets: collapsed group',
    );
  }

  return {
    scanned_groups: dupes.length,
    merged_groups,
    deleted_rows,
  };
}

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
