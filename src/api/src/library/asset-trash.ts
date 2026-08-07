/**
 * Single-asset trash + restore orchestration (#2630) — the Mongo+FS
 * workflow shared by the per-asset HTTP routes (`routes/assets/trash.ts`)
 * and the recursive folder-trash orchestrator (`library/folder-trash.ts`).
 *
 * Factored out so folder trash/restore reuses the EXACT soft-delete /
 * restore workflow a single asset uses — the `moveToTrash`/`moveOutOfTrash`
 * file move (itself built on the generic crash-safe `relocateFile`
 * primitive, `fs/relocate.ts`, #2629), the `markSoftDeleted`/
 * `restoreFromTrash` DB repoint, the best-effort Meilisearch
 * tombstone/re-index, and the change-feed emission — rather than
 * re-implementing a parallel path that could drift from the single-asset
 * one. `routes/assets/trash.ts` calls these two functions directly for its
 * soft-delete / restore branches; the folder orchestrator calls them once
 * per asset under a subtree.
 *
 * Deliberately covers only the SOFT-delete direction of
 * `DELETE /api/assets/:id` (a live asset -> trash) and restore. The
 * permanent-purge branch (an already-trashed asset -> hard delete) stays
 * inline in the route: it has no folder-level analogue in this ticket's
 * scope and pulling it in here would add an unused branch to every caller.
 */

import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import type { ObjectId } from 'mongodb';
import { foldersCollection } from '../db/client.ts';
import { moveToTrash, moveOutOfTrash } from '../fs/trash.ts';
import { composeSearchBlob } from '../enrichment/search-blob.ts';
import { classifyMediaType } from '../indexer/media-types.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { meilisearchClient } from '../enrichment/meilisearch-client.ts';
import { findCoreInfoById, markSoftDeleted, restoreFromTrash } from '../db/assets.repo.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('library/asset-trash');

export type TrashAssetOutcome =
  | {
      kind: 'ok';
      assetId: ObjectId;
      folderId: ObjectId;
      newAbsPath: string;
      originalAbsPath: string;
    }
  | { kind: 'not-found' }
  | { kind: 'already-trashed' }
  | { kind: 'no-location' }
  | { kind: 'no-folder' }
  | { kind: 'error'; error: string };

export interface TrashAssetOptions {
  /**
   * Explicit fileinfo entry identifying WHICH location to trash. The
   * folder-trash orchestrator (`library/folder-trash.ts`) always passes
   * this: a multi-location asset (deduped across libraries) may not have
   * its globally "primary" fileinfo entry under the folder being trashed,
   * so the caller must say exactly which entry it means — reusing
   * `assetAbsPath`'s primary-selection here would risk moving the WRONG
   * file (one outside the folder the user asked to trash). Omitted by the
   * single-asset HTTP route, which keeps its historical "first live
   * entry" selection.
   */
  entry?: { libraryId: ObjectId; path: string; filename: string };
}

/**
 * Soft-delete one live asset: move its RAW + sidecars into
 * `.maple/trash/<rel>` (via `moveToTrash`), repoint its fileinfo entry and
 * stamp `deleted_at` (via `markSoftDeleted`), best-effort tombstone it in
 * Meilisearch, and emit a delete change for the File Provider extension.
 * Mirrors the soft-delete branch of `DELETE /api/assets/:id` exactly when
 * called without `opts.entry`.
 */
export async function trashAssetById(
  id: ObjectId,
  opts: TrashAssetOptions = {},
): Promise<TrashAssetOutcome> {
  const info = await findCoreInfoById(id);
  if (!info) return { kind: 'not-found' };
  if (info.deleted_at) return { kind: 'already-trashed' };

  // Resolve WHICH fileinfo entry this call trashes, and the absolute path
  // it currently lives at. `opts.entry` (folder-trash) bypasses
  // `assetAbsPath`'s "globally primary" selection entirely — the target
  // entry is already known from the folder-membership query that found
  // this asset. Without `opts.entry` (the single-asset route), fall back
  // to the historical `assetAbsPath` primary-entry resolution.
  let libraryId: ObjectId;
  let entryPath: string;
  let entryFilename: string;
  let absPathForJoin: string | null = null;
  if (opts.entry) {
    libraryId = opts.entry.libraryId;
    entryPath = opts.entry.path;
    entryFilename = opts.entry.filename;
  } else {
    const libs = await loadLibraryRoots();
    const resolved = assetAbsPath(info, libs);
    if (!resolved) return { kind: 'no-location' };
    if (!info.folder_id) return { kind: 'no-folder' };
    // Identify the fileinfo entry that backs `resolved`. Mirrors
    // `resolvePrimary` in assets.transform.ts — first live entry, else the
    // first entry on the array.
    const primary = (info.fileinfo ?? []).find((e) => !e.deleted_at) ?? info.fileinfo?.[0];
    if (!primary) return { kind: 'no-location' };
    libraryId = info.folder_id;
    entryPath = primary.path;
    entryFilename = primary.filename;
    absPathForJoin = resolved;
  }

  const folders = await foldersCollection();
  const folder = await folders.findOne({ _id: libraryId });
  if (!folder) return { kind: 'no-folder' };
  const absPathResolved = absPathForJoin ?? path.join(folder.path, entryPath, entryFilename);

  const result = await moveToTrash(absPathResolved, folder.path);
  if (result.kind !== 'ok') return { kind: 'error', error: result.error };

  // `source` tells the repo to rewrite ONLY the matched fileinfo entry
  // instead of clobbering the whole array — when the asset has multiple
  // `fileinfo[]` (deduped across libraries) this preserves the non-trashed
  // locations.
  const originalAbsPath = absPathResolved;
  await markSoftDeleted({
    id,
    libraryRoot: folder.path,
    libraryId,
    newAbsPath: result.newAbsPath,
    originalAbsPath,
    source: { libraryId, path: entryPath, filename: entryFilename },
  });

  // Best-effort Meilisearch tombstone — mirrors the indexer's
  // `softDelete()` pattern. Mongo is canonical; a Meilisearch failure here
  // must NOT roll back the soft-delete. `markSoftDeleted` above reset
  // `stages.meili` in the same atomic update that stamped `deleted_at`, so
  // the meili stage's own handler tombstones the document with retry/
  // backoff even when this inline call fails (#2354).
  if (info.maple_id) {
    try {
      await meilisearchClient().tombstone(info.maple_id);
    } catch (err) {
      log.warn(
        {
          assetId: id.toHexString(),
          mapleId: info.maple_id,
          err: err instanceof Error ? err.message : String(err),
        },
        'meilisearch tombstone on trash failed — Mongo is canonical, search will exclude via deleted_at filter',
      );
    }
  }

  // Emit a delete change keyed on the path the OS / File Provider knows
  // about (the pre-trash location). The asset row stays for restore.
  await recordAndPublishAssetChange({
    kind: 'delete',
    asset_id: id,
    folder_id: info.folder_id,
    abs_path: originalAbsPath,
  }).catch(() => {});

  return {
    kind: 'ok',
    assetId: id,
    folderId: libraryId,
    newAbsPath: result.newAbsPath,
    originalAbsPath,
  };
}

export interface RestoreAssetOptions {
  /** Cross-library restore guard — same semantics as the HTTP route's
   * `target_folder_id` body field: rejected unless it matches the asset's
   * own folder. */
  targetFolderId?: string;
  /** POSIX relative path (under the asset's library root) to restore to,
   * validated the same way as the HTTP route's `target_relative_path`.
   * Defaults to the asset's recorded `original_path`. */
  targetRelativePath?: string;
  /**
   * Explicit fileinfo entry identifying WHICH trashed location to restore
   * — same rationale as `TrashAssetOptions.entry`. `assetAbsPath`'s
   * "fully live" primary selection can't distinguish the trashed entry
   * from an untouched entry in a different library (a trashed entry's OWN
   * `deleted_at`/`missing_since` stay null — only the doc's top-level
   * `deleted_at` differs), so the folder-restore orchestrator
   * (`library/folder-trash.ts`) always passes this explicitly. Also
   * bypasses the cross-library guard, since the caller already knows the
   * asset's restore-relevant library.
   */
  entry?: { libraryId: ObjectId; path: string; filename: string };
}

export type RestoreAssetOutcome =
  | {
      kind: 'ok';
      assetId: ObjectId;
      folderId: ObjectId;
      absPath: string;
      filename: string;
      size: number;
      mtimeMs: number;
    }
  | { kind: 'not-found' }
  | { kind: 'not-trashed' }
  | { kind: 'no-location' }
  | { kind: 'no-folder' }
  | { kind: 'cross-library'; assetFolderId: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'error'; error: string };

/**
 * Restore one trashed asset: move its file back out of trash (via
 * `moveOutOfTrash`, collision-safe via `pickFreeRestoredPath`), repoint its
 * fileinfo entry and clear `deleted_at` (via `restoreFromTrash`),
 * best-effort re-index it in Meilisearch, and emit a restore change.
 * Mirrors `POST /api/assets/:id/restore` exactly.
 */
export async function restoreAssetById(
  id: ObjectId,
  opts: RestoreAssetOptions = {},
): Promise<RestoreAssetOutcome> {
  const info = await findCoreInfoById(id);
  if (!info) return { kind: 'not-found' };
  if (!info.deleted_at) return { kind: 'not-trashed' };

  let assetFolderId: ObjectId;
  let trashedAbsPath: string;
  if (opts.entry) {
    assetFolderId = opts.entry.libraryId;
  } else {
    if (!info.folder_id) return { kind: 'no-folder' };
    assetFolderId = info.folder_id;
  }
  const folders = await foldersCollection();
  const folder = await folders.findOne({ _id: assetFolderId });
  if (!folder) return { kind: 'no-folder' };

  if (opts.entry) {
    trashedAbsPath = path.join(folder.path, opts.entry.path, opts.entry.filename);
  } else {
    const libs = await loadLibraryRoots();
    const resolved = assetAbsPath(info, libs);
    if (!resolved) return { kind: 'no-location' };
    trashedAbsPath = resolved;
  }

  // Cross-library restore guard. Phase 3 only restores into the SAME
  // library the asset belongs to; the server moves the file using the
  // ORIGINAL folder root, so an unguarded caller would silently restore
  // into the wrong place. Skipped when `opts.entry` is given — the
  // folder-restore orchestrator already resolved the correct library.
  if (
    !opts.entry &&
    typeof opts.targetFolderId === 'string' &&
    opts.targetFolderId.length > 0 &&
    opts.targetFolderId !== assetFolderId.toHexString()
  ) {
    return { kind: 'cross-library', assetFolderId: assetFolderId.toHexString() };
  }

  let targetAbs: string;
  if (typeof opts.targetRelativePath === 'string' && opts.targetRelativePath.length > 0) {
    const targetRel = opts.targetRelativePath;
    if (targetRel.startsWith('/')) {
      return { kind: 'invalid', error: 'Target must be relative' };
    }
    const parts = targetRel.split('/').filter((p) => p.length > 0);
    for (const part of parts) {
      if (part === '..' || part === '.') {
        return { kind: 'invalid', error: 'Path traversal not allowed' };
      }
      if (part.startsWith('.')) {
        return { kind: 'invalid', error: 'Hidden path components not allowed' };
      }
    }
    targetAbs = path.join(folder.path, targetRel);
  } else {
    if (!info.original_path) {
      return { kind: 'error', error: 'Asset has no original_path; supply targetRelativePath' };
    }
    targetAbs = info.original_path;
  }

  const result = await moveOutOfTrash(trashedAbsPath, targetAbs);
  if (result.kind !== 'ok') return { kind: 'error', error: result.error };

  // Re-stat the restored file: `moveOutOfTrash` may have appended a
  // `.restored[.N]` suffix on collision, so `filename`/`size`/`mtime` must
  // be refreshed to match the new on-disk state.
  const restoredFilename = path.basename(result.newAbsPath);
  let restoredSize = info.size;
  let restoredMtimeMs = Date.now();
  try {
    const st = await stat(result.newAbsPath);
    restoredSize = st.size;
    restoredMtimeMs = st.mtimeMs;
  } catch (err) {
    log.warn(
      { absPath: result.newAbsPath, err: err instanceof Error ? err.message : String(err) },
      'restore: stat of new path failed — using prior doc values',
    );
  }

  // Identify the trashed fileinfo entry — `opts.entry` when the caller
  // already knows it (folder restore); otherwise the asset is in trash so
  // its primary entry is the one we just moved.
  const restoreSource = opts.entry
    ? { library_id: opts.entry.libraryId, path: opts.entry.path, filename: opts.entry.filename }
    : ((info.fileinfo ?? []).find((e) => !e.deleted_at) ?? info.fileinfo?.[0]);
  await restoreFromTrash({
    id,
    libraryRoot: folder.path,
    libraryId: assetFolderId,
    newAbsPath: result.newAbsPath,
    size: restoredSize,
    mtimeMs: restoredMtimeMs,
    source: restoreSource
      ? {
          libraryId: restoreSource.library_id,
          path: restoreSource.path,
          filename: restoreSource.filename,
        }
      : undefined,
  });

  // Best-effort Meilisearch re-index — symmetric with the tombstone on
  // trash. `restoreFromTrash` resets `stages.meili` in the same update
  // that clears `deleted_at`, which is the correctness guarantee (#2354);
  // this inline call is a fast-path convenience only. `search_blob` /
  // `hidden` aren't on the typed `AssetCoreInfo` projection (the fields
  // predate that DTO), so they're read through an untyped view here —
  // same pattern `assets.transform.ts` uses for `description_meta`.
  const rawInfo = info as unknown as { search_blob?: string | null; hidden?: boolean };
  if (info.maple_id) {
    try {
      await meilisearchClient().upsert({
        id: info.maple_id,
        filename: restoredFilename,
        searchBlob:
          rawInfo.search_blob ??
          composeSearchBlob({
            place: info.place,
            description: info.description,
            ocrText: info.ocr_text,
          }),
        description: info.description,
        ocrText: info.ocr_text,
        folderId: assetFolderId.toHexString(),
        capturedAt: info.exif?.captured_at ?? null,
        deletedAt: null,
        mediaType: classifyMediaType(restoredFilename),
        hidden: rawInfo.hidden === true,
      });
    } catch (err) {
      log.warn(
        {
          assetId: id.toHexString(),
          mapleId: info.maple_id,
          err: err instanceof Error ? err.message : String(err),
        },
        'meilisearch re-index on restore failed — Mongo restored OK, search will lag until next meili stage pass',
      );
    }
  }

  await recordAndPublishAssetChange({
    kind: 'restore',
    asset_id: id,
    folder_id: info.folder_id,
    abs_path: result.newAbsPath,
  }).catch(() => {});

  return {
    kind: 'ok',
    assetId: id,
    folderId: assetFolderId,
    absPath: result.newAbsPath,
    filename: restoredFilename,
    size: restoredSize,
    mtimeMs: restoredMtimeMs,
  };
}
