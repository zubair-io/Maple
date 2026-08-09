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
 * The soft-delete and restore branches are thin HTTP wrappers around
 * `library/asset-trash.ts`'s `trashAssetById` / `restoreAssetById` (#2630)
 * — the same orchestration the recursive folder-trash routes
 * (`routes/folders-trash.ts`) call per asset, so the two surfaces can't
 * drift. The permanent-purge branch has no folder-level analogue and stays
 * inline here.
 */

import { Elysia, t } from 'elysia';
import type { ObjectId } from 'mongodb';
import { unlink } from 'node:fs/promises';
import { listPairedSidecars } from '../../fs/xmp-conflict.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { trashAssetById, restoreAssetById } from '../../library/asset-trash.ts';
import type { RestoreAssetOutcome } from '../../library/asset-trash.ts';
import { findCoreInfoById, hardDelete, parseAssetId } from '../../db/assets.repo.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';

/** Map a `restoreAssetById` outcome to its HTTP status + body. Split out of
 * the route handler below purely to keep that handler's own cyclomatic
 * complexity down — this is a pure, synchronous mapping with no I/O. */
function restoreOutcomeResponse(
  outcome: RestoreAssetOutcome,
  targetFolderId: string | undefined,
): { status: number; body: unknown } {
  switch (outcome.kind) {
    case 'ok':
      // Wire contract: `mtime` is serialised as an ISO-8601 string with
      // fractional seconds so the Swift `RestoreResponse.mtime: Date`
      // decoder (see RemoteCatalog.swift) accepts it. The DB column
      // remains epoch-ms (number) per AssetDoc.mtime — this is purely a
      // response-time transform.
      return {
        status: 200,
        body: {
          asset_id: outcome.assetId.toHexString(),
          abs_path: outcome.absPath,
          filename: outcome.filename,
          size: outcome.size,
          mtime: new Date(outcome.mtimeMs).toISOString(),
        },
      };
    case 'not-found':
      return { status: 404, body: { error: 'Asset not found' } };
    case 'not-trashed':
      return { status: 409, body: { error: 'Asset is not trashed' } };
    case 'no-location':
      return { status: 404, body: { error: 'Asset has no resolvable location' } };
    case 'no-folder':
      return { status: 500, body: { error: "Asset's folder is missing" } };
    case 'cross-library':
      return {
        status: 400,
        body: {
          error: 'Cross-library restore is not supported',
          asset_folder_id: outcome.assetFolderId,
          target_folder_id: targetFolderId,
        },
      };
    case 'invalid':
      return { status: 400, body: { error: outcome.error } };
    case 'error':
      return { status: 500, body: { error: outcome.error } };
  }
}

/** The permanent-purge branch of DELETE /:id — the asset is already
 * trashed; unlink the file + sidecars, hard-delete the doc, emit the
 * File Provider delete change. Extracted from the route handler purely
 * for unit-size; behavior is unchanged and it still has no folder-level
 * analogue (#2630).
 */
async function purgeTrashedAsset(
  id: ObjectId,
  info: NonNullable<Awaited<ReturnType<typeof findCoreInfoById>>>,
  set: { status?: number | string },
): Promise<{ error: string } | undefined> {
  const libs = await loadLibraryRoots();
  const absPathResolved = assetAbsPath(info, libs);
  if (!absPathResolved) {
    set.status = 404;
    return { error: 'Asset has no resolvable location' };
  }
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

export const trashRoutes = new Elysia()
  .delete('/:id', async ({ params, query, set }) => {
    const id = parseAssetId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'Invalid asset id' };
    }

    // `intent` closes the dual-mode staleness race (#2749): without it,
    // the same call means "trash" for a live asset and "PERMANENTLY purge"
    // for an already-trashed one, decided by server-side state the caller
    // may hold a stale copy of. A grid whose listing is stale can send
    // what its user believes is a reversible trash and irreversibly purge
    // the photo — or a stale Trash panel can "permanently delete" an asset
    // someone restored, quietly re-trashing a live photo instead while its
    // UI reports "cannot be undone". With `intent`, a state mismatch is a
    // 409 the client surfaces and refreshes on, never a silent flip.
    //
    // Omitting `intent` preserves the legacy dual-mode contract byte-for-
    // byte — the deployed File Provider extension depends on it and cannot
    // be flag-dayed. UI clients (web Trash node, Apple trash, Windows)
    // should always pass it.
    const intent = query.intent;
    if (intent !== undefined && intent !== 'trash' && intent !== 'purge') {
      set.status = 400;
      return { error: "intent must be 'trash' or 'purge' when provided" };
    }

    const info = await findCoreInfoById(id);
    if (!info) {
      set.status = 404;
      return { error: 'Asset not found' };
    }

    if (intent === 'trash' && info.deleted_at) {
      // Raced: someone else already trashed it. For an explicit trash
      // intent that is success-shaped (the asset IS in the trash), but a
      // 204 would hide that the caller's listing is stale — 409 with a
      // distinct error lets the client refresh and, critically, never
      // falls through to the purge branch below.
      set.status = 409;
      return { error: 'Asset is already trashed', state: 'trashed' };
    }
    if (intent === 'purge' && !info.deleted_at) {
      set.status = 409;
      return { error: 'Asset is not trashed — refusing to purge a live asset', state: 'live' };
    }

    if (info.deleted_at) {
      return await purgeTrashedAsset(id, info, set);
    }

    const outcome = await trashAssetById(id);
    switch (outcome.kind) {
      case 'ok':
        set.status = 204;
        return;
      case 'not-found':
        set.status = 404;
        return { error: 'Asset not found' };
      case 'already-trashed':
        // Raced with a concurrent trash of the same asset — nothing left
        // to do, report success.
        set.status = 204;
        return;
      case 'no-location':
        set.status = 404;
        return { error: 'Asset has no resolvable location' };
      case 'no-folder':
        set.status = 500;
        return { error: "Asset's folder is missing — refusing to trash" };
      case 'error':
        set.status = 500;
        return { error: outcome.error };
    }
  })

  .post(
    '/:id/restore',
    async ({ params, body, set }) => {
      const id = parseAssetId(params.id);
      if (!id) {
        set.status = 400;
        return { error: 'Invalid asset id' };
      }

      const targetFolderId = (body as { target_folder_id?: string } | null)?.target_folder_id;
      const targetRelativePath = (body as { target_relative_path?: string } | null)
        ?.target_relative_path;

      const outcome = await restoreAssetById(id, { targetFolderId, targetRelativePath });
      const response = restoreOutcomeResponse(outcome, targetFolderId);
      set.status = response.status;
      return response.body;
    },
    {
      body: t.Object({
        target_relative_path: t.Optional(t.String()),
        target_folder_id: t.Optional(t.String()),
      }),
    },
  );
