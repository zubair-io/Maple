/**
 * Assets repository — trash + restore workflows.
 *
 * Split out of `assets.repo.ts` so the file budget per #205 stays under
 * 400 LOC. These are the multi-step Mongo workflows the trash route
 * used to inline; pulling them in here lets the route stop touching
 * the collection directly while keeping the FS / Meilisearch /
 * change-feed orchestration in the route (the repo doesn't take a
 * Meilisearch dependency).
 *
 * Post drop-abs-path-2026-05-21 migration: the canonical location of
 * an asset lives in `fileinfo[0]`. Trash workflows rewrite that entry
 * in place and record the original absolute path in `original_path`
 * so restore can put the file back where it was.
 */

import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
import { type Db, type UpdateResult, type DeleteResult, type Collection } from 'mongodb';
import { assetsCollection } from './client.ts';
import { type AssetDoc } from './schema.ts';
import { MEILI_REARM_SET } from '../people/people-search-reindex.ts';

async function coll(dbOverride?: Db): Promise<Collection<AssetDoc>> {
  if (dbOverride) return dbOverride.collection<AssetDoc>('assets');
  return assetsCollection();
}

/**
 * Convert an absolute path to a `(path, filename)` pair relative to the
 * supplied library root. Returns null when the path doesn't fall under
 * the root — the caller MUST handle that defensively. POSIX-normalises
 * the directory component so the stored value obeys the FileInfo
 * docstring contract on every host.
 */
function relSplit(libraryRoot: string, absPath: string): { path: string; filename: string } | null {
  const relDir = path.relative(libraryRoot, path.dirname(absPath));
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) return null;
  const normalised = relDir === '' || relDir === '.' ? '' : relDir.split(path.sep).join('/');
  return { path: normalised, filename: path.basename(absPath) };
}

/**
 * `arrayFilters` for a surgical `fileinfo.$[entry]` update targeting the one
 * fileinfo entry identified by `source`. Shared by `markSoftDeleted` and
 * `restoreFromTrash` so the entry-matcher shape (library_id + path +
 * filename) can't drift between the trash and restore directions of the
 * same workflow.
 */
function sourceEntryArrayFilters(source: {
  libraryId: ObjectId;
  path: string;
  filename: string;
}): Array<Record<string, unknown>> {
  return [
    {
      'entry.library_id': source.libraryId,
      'entry.path': source.path,
      'entry.filename': source.filename,
    },
  ];
}

/**
 * Mark a live asset as soft-deleted and rewrite the matching fileinfo
 * entry to point at the trash destination. `originalAbsPath` is preserved
 * in `original_path` so the restore workflow can put the file back.
 *
 * The trash trigger is per-location: one fileinfo entry moves to trash,
 * not the whole asset. When an asset has multiple `fileinfo[]` records
 * (e.g. deduped across libraries), preserve the other entries in place.
 * `source` identifies which entry was moved — typically the primary
 * `fileinfo[0]`, which the trash route resolved before calling
 * `moveToTrash`. Falls back to overwriting `fileinfo[0]` only when no
 * `source` is given, matching the historical single-entry contract.
 *
 * Also resets `stages.meili` (`MEILI_REARM_SET`) in the SAME update that
 * stamps `deleted_at`. The rewritten trash entry stays "live" per
 * `isLiveFileInfo` (its own per-entry `deleted_at` is null — only the
 * top-level field is stamped), so the meili stage's claim query re-picks
 * the row, and `meiliHandler`'s `deleted_at` branch
 * (workers/stages/meili.ts) tombstones the search document with the
 * stage's retry/backoff — guaranteeing the asset leaves live search even
 * when the trash route's inline best-effort tombstone failed against a
 * transient Meilisearch outage (#2354). The inline call is a fast path;
 * this re-arm is the correctness mechanism.
 */
export async function markSoftDeleted(args: {
  id: ObjectId;
  /** The library root that owns this asset. Required so we can compute
   * `(path, filename)` for the trashed entry relative to it. */
  libraryRoot: string;
  libraryId: ObjectId;
  newAbsPath: string;
  originalAbsPath: string;
  /**
   * Identity of the fileinfo entry that was moved to trash. Required for
   * assets with multiple locations — without it we'd clobber the
   * non-trashed entries. When omitted, the function updates `fileinfo[0]`
   * via a positional fallback to preserve backwards compatibility.
   */
  source?: { libraryId: ObjectId; path: string; filename: string };
  dbOverride?: Db;
}): Promise<UpdateResult> {
  const c = await coll(args.dbOverride);
  const split = relSplit(args.libraryRoot, args.newAbsPath);
  if (!split) {
    throw new Error(
      `markSoftDeleted: newAbsPath ${args.newAbsPath} is outside libraryRoot ${args.libraryRoot}`,
    );
  }
  const newEntry = {
    path: split.path,
    filename: split.filename,
    library_id: args.libraryId,
    deleted_at: null,
  };
  if (args.source) {
    // Surgical update: rewrite only the matching fileinfo entry. Falls
    // back to fileinfo[0] if no entry matches (e.g. caller passed a
    // stale source).
    return c.updateOne(
      { _id: args.id },
      {
        $set: {
          'fileinfo.$[entry]': newEntry,
          deleted_at: new Date().toISOString(),
          original_path: args.originalAbsPath,
          ...MEILI_REARM_SET,
        },
      },
      {
        arrayFilters: sourceEntryArrayFilters(args.source),
      },
    );
  }
  // Legacy contract — no source supplied → overwrite the array with a
  // single entry. Kept so call sites that don't yet know the source can
  // still soft-delete single-location assets.
  return c.updateOne(
    { _id: args.id },
    {
      $set: {
        fileinfo: [newEntry],
        deleted_at: new Date().toISOString(),
        original_path: args.originalAbsPath,
        ...MEILI_REARM_SET,
      },
    },
  );
}

/** Permanent purge: drop the doc. Called after the FS layer has
 * removed the file + sidecars. */
export async function hardDelete(id: ObjectId, dbOverride?: Db): Promise<DeleteResult> {
  const c = await coll(dbOverride);
  return c.deleteOne({ _id: id });
}

/**
 * Restore: drop a watcher-inserted transient row at the new abs path
 * (if any), then update the canonical row to point at its new location.
 *
 * The watcher-race delete is bundled in here so the workflow is atomic
 * at the repo layer.
 *
 * Also resets `stages.meili` (`MEILI_REARM_SET`) in the SAME update that
 * clears `deleted_at`. A restored asset's fileinfo entry was already "live"
 * per `isLiveFileInfo` while trashed (only the top-level `deleted_at` was
 * stamped, never the entry's own), so the meili stage's claim query never
 * naturally re-picks the row — without this reset the caller's inline
 * Meilisearch upsert (see `routes/assets/trash.ts`) is the ONLY thing that
 * ever repopulates the search document, and it writes a partial doc
 * missing `visionSceneType` / `visionActivity` / `visionSubjects` /
 * `isScreenshot` / `people`, permanently stripping those facets from the
 * live index (#2354). Resetting the stage version below target makes the
 * row reclaimable so the stage's own handler (`workers/stages/meili.ts`)
 * rebuilds the FULL document on its next poll tick — the inline call is a
 * fast-path convenience, this reset is the correctness guarantee.
 */
export async function restoreFromTrash(args: {
  id: ObjectId;
  libraryRoot: string;
  libraryId: ObjectId;
  newAbsPath: string;
  size: number;
  /**
   * Epoch-ms (typically `stat.mtimeMs`). `AssetDoc.mtime` is typed
   * `number` and the assets-list serialiser does `Math.floor(r.mtime /
   * 1000)` — writing an ISO string here NaNs out downstream. The wire
   * response's ISO representation is the route handler's concern (so
   * the Swift File Provider client's Date decoder accepts it); the
   * repo only stores epoch-ms.
   */
  mtimeMs: number;
  /**
   * Identity of the trashed fileinfo entry that's being restored. Same
   * semantics as `markSoftDeleted.source` — required when the asset has
   * multiple fileinfo entries; omitted forms still work for single-entry
   * assets (legacy contract).
   */
  source?: { libraryId: ObjectId; path: string; filename: string };
  dbOverride?: Db;
}): Promise<UpdateResult> {
  const c = await coll(args.dbOverride);
  const split = relSplit(args.libraryRoot, args.newAbsPath);
  if (!split) {
    throw new Error(
      `restoreFromTrash: newAbsPath ${args.newAbsPath} is outside libraryRoot ${args.libraryRoot}`,
    );
  }
  // Watcher race: between the FS move and this update, the discover
  // watcher may have observed the file at its restore location and
  // inserted a transient row. Delete any other doc that matches
  // `(library_id, path, filename)` so this update can adopt the slot.
  await c.deleteOne({
    _id: { $ne: args.id },
    fileinfo: {
      $elemMatch: {
        library_id: args.libraryId,
        path: split.path,
        filename: split.filename,
      },
    },
  });
  const newEntry = {
    path: split.path,
    filename: split.filename,
    library_id: args.libraryId,
    deleted_at: null,
  };
  if (args.source) {
    return c.updateOne(
      { _id: args.id },
      {
        $set: {
          'fileinfo.$[entry]': newEntry,
          size: args.size,
          mtime: args.mtimeMs,
          deleted_at: null,
          original_path: null,
          ...MEILI_REARM_SET,
        },
      },
      {
        arrayFilters: sourceEntryArrayFilters(args.source),
      },
    );
  }
  return c.updateOne(
    { _id: args.id },
    {
      $set: {
        fileinfo: [newEntry],
        size: args.size,
        mtime: args.mtimeMs,
        deleted_at: null,
        original_path: null,
        ...MEILI_REARM_SET,
      },
    },
  );
}
