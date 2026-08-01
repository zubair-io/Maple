/**
 * /api/assets trash + restore (Phase 3).
 *
 *   DELETE /api/assets/:id           — dual-mode:
 *       • deleted_at == null → soft-delete (move RAW + sidecars to
 *         .maple/trash/<rel>, set deleted_at + original_path), 204.
 *       • deleted_at != null → permanent purge (unlink files, delete
 *         asset doc), 204. This is the "user emptied this single item
 *         from Trash" signal from the File Provider extension.
 *   POST   /api/assets/:id/restore   — move file out of trash and clear
 *                                      deleted_at; returns the restored
 *                                      filename / size / mtime so the
 *                                      File Provider client can rebuild
 *                                      its metadata without statting
 *                                      the server's abs_path.
 *
 * The Phase-2 DELETE /:id/xmp route handles sidecar-only deletes via
 * the xmpRoutes plugin; this one is asset-level.
 *
 * Mounted into `assetsRoutes` (see ./index.ts) which provides the
 * `/api/assets` prefix.
 *
 * Mongo access lives in `src/db/assets.repo.ts`.
 */

import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import { stat, unlink } from 'node:fs/promises';
import { foldersCollection } from '../../db/client.ts';
import { listPairedSidecars } from '../../fs/xmp-conflict.ts';
import { moveToTrash, moveOutOfTrash } from '../../fs/trash.ts';
import { composeSearchBlob } from '../../enrichment/search-blob.ts';
import { classifyMediaType } from '../../indexer/media-types.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { meilisearchClient } from '../../enrichment/meilisearch-client.ts';
import { assetsLog } from './_shared.ts';
import {
  findCoreInfoById,
  hardDelete,
  markSoftDeleted,
  parseAssetId,
  restoreFromTrash,
} from '../../db/assets.repo.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';

export const trashRoutes = new Elysia()
  .delete('/:id', async ({ params, set }) => {
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }

    const info = await findCoreInfoById(id);
    if (!info) {
      set.status = 404;
      return { error: 'Asset not found' };
    }

    const libs = await loadLibraryRoots();
    const absPathResolved = assetAbsPath(info, libs);
    if (!absPathResolved) {
      set.status = 404;
      return { error: 'Asset has no resolvable location' };
    }

    // Already trashed → permanent purge.
    if (info.deleted_at) {
      const absPath = absPathResolved;
      try {
        await unlink(absPath);
      } catch {
        /* file may already be gone */
      }
      const sidecars = await listPairedSidecars(absPath);
      for (const sidecar of sidecars) {
        try {
          await unlink(sidecar);
        } catch {}
      }
      await hardDelete(id);
      // The doc was already tombstoned in Meilisearch by the prior
      // soft-delete (`tombstone` sets `deletedAt`, which the search filter
      // excludes) — no per-asset delete-document call is made here.
      // That tombstoned document is NOT garbage-collected by a later bulk
      // backfill: the backfill cursor scans live Mongo rows and only
      // re-tombstones/re-upserts documents for rows it still finds there.
      // `hardDelete` just removed this asset's Mongo row, so no future
      // backfill pass will ever see this id again to clean it up — the
      // tombstoned Meilisearch document accumulates in the index
      // permanently. It stays invisible to every route/service query
      // because they all filter `deletedAt IS NULL`, so this is a storage
      // leak in Meilisearch, not a correctness bug. An actual GC would
      // need a dedicated sweep (diff Meilisearch document ids against live
      // Mongo `maple_id`s and hard-delete the stragglers) — not implemented.
      set.status = 204;
      // Emit a delete change so the File Provider extension drops this
      // item from its working set on the next pull.
      await recordAndPublishAssetChange({
        kind: 'delete',
        asset_id: id,
        folder_id: info.folder_id,
        abs_path: absPath,
      }).catch(() => {});
      return;
    }

    // Locate the owning folder root. `info.folder_id` resolves from the
    // asset's primary fileinfo entry — null when the asset has no live
    // location at all.
    if (!info.folder_id) {
      set.status = 500;
      return { error: 'Asset has no resolvable library — refusing to trash' };
    }
    const folders = await foldersCollection();
    const folder = await folders.findOne({ _id: info.folder_id });
    if (!folder) {
      set.status = 500;
      return { error: "Asset's folder is missing — refusing to trash" };
    }

    const result = await moveToTrash(absPathResolved, folder.path);
    if (result.kind !== 'ok') {
      set.status = 500;
      return { error: result.error };
    }

    // Identify the fileinfo entry that backs `absPathResolved`. Mirrors
    // `resolvePrimary` in assets.transform.ts — first live entry, else the
    // first entry on the array. Passing it as `source` tells the repo to
    // rewrite ONLY that entry instead of clobbering the whole array; when
    // the asset has multiple `fileinfo[]` (deduped across libraries) we
    // must preserve the non-trashed locations.
    const sourceEntry = (info.fileinfo ?? []).find((e) => !e.deleted_at) ?? info.fileinfo?.[0];
    const originalAbsPath = absPathResolved;
    await markSoftDeleted({
      id,
      libraryRoot: folder.path,
      libraryId: info.folder_id,
      newAbsPath: result.newAbsPath,
      originalAbsPath,
      source: sourceEntry
        ? {
            libraryId: sourceEntry.library_id,
            path: sourceEntry.path,
            filename: sourceEntry.filename,
          }
        : undefined,
    });

    // Best-effort Meilisearch tombstone — mirrors the indexer's
    // `softDelete()` pattern (src/api/src/indexer/images.repo.ts). The
    // search route's `deletedAt IS NULL` filter excludes the row from
    // results. Mongo is canonical; a Meilisearch failure here must NOT
    // roll back the soft-delete or change the 204 response. This is a FAST
    // PATH only, not the correctness mechanism (#2354): `markSoftDeleted`
    // above reset `stages.meili` in the same atomic update that stamped
    // `deleted_at`, so the meili stage re-claims the row and its handler's
    // `deleted_at` branch (workers/stages/meili.ts) tombstones the document
    // itself, with the stage's retry/backoff — a transient Meilisearch
    // outage here cannot leave the asset in live search forever.
    if (info.maple_id) {
      try {
        await meilisearchClient().tombstone(info.maple_id);
      } catch (err) {
        assetsLog.warn(
          {
            assetId: id.toHexString(),
            mapleId: info.maple_id,
            err: err instanceof Error ? err.message : String(err),
          },
          'meilisearch tombstone on trash failed — Mongo is canonical, search will exclude via deleted_at filter',
        );
      }
    }
    set.status = 204;
    // Emit a delete change keyed on the path the OS / File Provider knows
    // about (the pre-trash location). The asset row stays for restore.
    await recordAndPublishAssetChange({
      kind: 'delete',
      asset_id: id,
      folder_id: info.folder_id,
      abs_path: originalAbsPath,
    }).catch(() => {});
    return;
  })

  .post(
    '/:id/restore',
    async ({ params, body, set }) => {
      const id = parseAssetId(params.id);
      if (!id) {
        set.status = 400;
        return { error: 'Invalid asset id' };
      }

      const info = await findCoreInfoById(id);
      if (!info) {
        set.status = 404;
        return { error: 'Asset not found' };
      }
      if (!info.deleted_at) {
        set.status = 409;
        return { error: 'Asset is not trashed' };
      }

      const libs = await loadLibraryRoots();
      const trashedAbsPath = assetAbsPath(info, libs);
      if (!trashedAbsPath) {
        set.status = 404;
        return { error: 'Asset has no resolvable location' };
      }

      if (!info.folder_id) {
        set.status = 500;
        return { error: 'Asset has no resolvable library' };
      }
      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: info.folder_id });
      if (!folder) {
        set.status = 500;
        return { error: "Asset's folder is missing" };
      }
      const assetFolderId = info.folder_id;

      // Cross-library restore guard. Phase 3 only restores into the
      // SAME library the asset belongs to; dragging from Library A's
      // Trash into Library B is out of scope and currently UNDEFINED
      // — the server moves the file using the ORIGINAL folder root, so
      // an unguarded request would silently restore into the wrong
      // place. The File Provider client sends the new parent's
      // folder_id; reject the request if it doesn't match.
      const targetFolderID = (body as { target_folder_id?: string } | null)?.target_folder_id;
      if (typeof targetFolderID === 'string' && targetFolderID.length > 0) {
        if (targetFolderID !== assetFolderId.toHexString()) {
          set.status = 400;
          return {
            error: 'Cross-library restore is not supported',
            asset_folder_id: assetFolderId.toHexString(),
            target_folder_id: targetFolderID,
          };
        }
      }

      const targetRel = (body as { target_relative_path?: string } | null)?.target_relative_path;
      let targetAbs: string;
      if (typeof targetRel === 'string' && targetRel.length > 0) {
        if (targetRel.startsWith('/')) {
          set.status = 400;
          return { error: 'Target must be relative' };
        }
        const parts = targetRel.split('/').filter((p) => p.length > 0);
        for (const part of parts) {
          if (part === '..' || part === '.') {
            set.status = 400;
            return { error: 'Path traversal not allowed' };
          }
          if (part.startsWith('.')) {
            set.status = 400;
            return { error: 'Hidden path components not allowed' };
          }
        }
        targetAbs = path.join(folder.path, targetRel);
      } else {
        if (!info.original_path) {
          set.status = 500;
          return { error: 'Asset has no original_path; supply target_relative_path' };
        }
        targetAbs = info.original_path;
      }

      const result = await moveOutOfTrash(trashedAbsPath, targetAbs);
      if (result.kind !== 'ok') {
        set.status = 500;
        return { error: result.error };
      }
      // Re-stat the restored file: `moveOutOfTrash` may have appended a
      // `.restored[.N]` suffix on collision, so the doc's `filename`,
      // `size`, and `mtime` must be refreshed to match the new on-disk
      // state. Without this update the `{folder_id, filename}` unique
      // index would still reserve the OLD filename, blocking re-upload
      // with the same basename even though the file is at a new path.
      const restoredFilename = path.basename(result.newAbsPath);
      let restoredSize = info.size;
      // `AssetDoc.mtime` is epoch-ms (number) per db/schema.ts. Persist as
      // a number so the assets-list serialiser's `Math.floor(r.mtime /
      // 1000)` stays finite (#166). The wire response converts to
      // ISO-8601 below for the Swift File Provider client's `Date`
      // decoder.
      let restoredMtimeMs = Date.now();
      try {
        const st = await stat(result.newAbsPath);
        restoredSize = st.size;
        restoredMtimeMs = st.mtimeMs;
      } catch (err) {
        assetsLog.warn(
          { absPath: result.newAbsPath, err: err instanceof Error ? err.message : String(err) },
          'restore: stat of new path failed — using prior doc values',
        );
      }
      // Identify the trashed fileinfo entry — the asset is in trash so its
      // primary entry is the one we just moved. Same logic as the delete
      // branch above; passing `source` rewrites that single entry rather
      // than clobbering any sibling locations.
      const restoreSource = (info.fileinfo ?? []).find((e) => !e.deleted_at) ?? info.fileinfo?.[0];
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

      // Best-effort Meilisearch re-index — symmetric with the tombstone
      // on DELETE. Resurrects the row by upserting with `deletedAt: null`
      // so the search filter `deletedAt IS NULL` picks it up again. This is
      // a FAST PATH only, not the correctness mechanism: the payload here
      // is built from whatever enrichment fields happen to be present on
      // `info` and — unlike `meiliHandler` (workers/stages/meili.ts) —
      // omits `visionSceneType` / `visionActivity` / `visionSubjects` /
      // `isScreenshot` / `people` entirely, so on its own it would
      // permanently strip those facets from the live document (#2354). The
      // actual guarantee is `restoreFromTrash` (db/assets.trash.ts), which
      // resets `stages.meili` atomically in the same DB update that clears
      // `deleted_at` — that re-arms the meili stage's claim query so its
      // own handler rebuilds the FULL document on its next poll tick, even
      // if this inline call fails, only partially succeeds, or Meilisearch
      // was unreachable at restore time.
      if (info.maple_id) {
        try {
          await meilisearchClient().upsert({
            id: info.maple_id,
            filename: restoredFilename,
            searchBlob:
              info.search_blob ??
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
            hidden: info.hidden === true,
          });
        } catch (err) {
          assetsLog.warn(
            {
              assetId: id.toHexString(),
              mapleId: info.maple_id,
              err: err instanceof Error ? err.message : String(err),
            },
            'meilisearch re-index on restore failed — Mongo restored OK, search will lag until next meili stage pass',
          );
        }
      }

      set.status = 200;
      // Emit a restore change so the File Provider extension reinstates
      // the item at its new location.
      await recordAndPublishAssetChange({
        kind: 'restore',
        asset_id: id,
        folder_id: info.folder_id,
        abs_path: result.newAbsPath,
      }).catch(() => {});
      // `size` and `mtime` are included so the File Provider extension
      // can synthesise the restored item's metadata directly from the
      // response rather than statting `abs_path` (which is the SERVER's
      // path, not the client's, and would fail/return zeros on the Mac).
      //
      // Wire contract: `mtime` is serialised as an ISO-8601 string with
      // fractional seconds so the Swift `RestoreResponse.mtime: Date`
      // decoder (see RemoteCatalog.swift) accepts it. The DB column
      // remains epoch-ms (number) per AssetDoc.mtime — this is purely a
      // response-time transform.
      return {
        asset_id: id.toHexString(),
        abs_path: result.newAbsPath,
        filename: restoredFilename,
        size: restoredSize,
        mtime: new Date(restoredMtimeMs).toISOString(),
      };
    },
    {
      body: t.Object({
        target_relative_path: t.Optional(t.String()),
        target_folder_id: t.Optional(t.String()),
      }),
    },
  );
