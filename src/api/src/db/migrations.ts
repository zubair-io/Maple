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

export type MigrationId =
  | 'exif-captured-year-month-backfill'
  | 'place-search-blob-backfill'
  | 'asset-search-blob-backfill'
  | 'reset-describe-dead-vision-parse-2026-05-20'
  | 'reset-describe-dead-vision-parse-2026-05-21'
  | 'reset-describe-dead-vision-parse-2026-05-22'
  | 'fileinfo-backfill-2026-05-20';

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
