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

import { refusesFileUnderMarker } from '../../fs/mapleignore-guard.ts';
import { Elysia, t } from 'elysia';
import type { ObjectId } from '../../db/object-id.ts';
import { oldNameEditUnreadable } from '../../fs/legacy-backup-sidecar.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { trashAssetById, restoreAssetById } from '../../library/asset-trash.ts';
import { prepareTrashPurge } from '../../cloud-backup/lifecycle.ts';
import { capturedTrashPurge } from '../../cloud-backup/trash-purge-admission.ts';
import {
  LibraryUnreachableError,
  libraryReachable,
  logPurgeFailure,
  purgeTrashedCopyCompanions,
  resolveTrashedCopy,
  unlinkTrashedCopy,
  type TrashedCopy,
} from '../../library/trashed-copy.ts';
import {
  purgeKeepingSurvivor,
  type SurvivorPurgeOutcome,
} from '../../library/trash-purge-survivor.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import type { RestoreAssetOutcome } from '../../library/asset-trash.ts';
import { findCoreInfoById, hardDelete, parseAssetId } from '../../db/assets.repo.ts';
import { requireFileAccessBeforeHandle } from '../../auth/middleware.ts';
import { assetsLog } from './_shared.ts';

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

const unlinkFailure = logPurgeFailure(assetsLog, 'permanent delete unlink failed');

/** Answered when the purge kept the photo through its surviving copy (#5403). */
interface SurvivorKeptBody {
  asset_id: string;
  state: 'live';
  abs_path: string | null;
  /** `pending` while removing the trashed copy's files still awaits a retry. */
  cleanup: 'done' | 'pending';
}

/** The permanent-purge branch of DELETE /:id — the asset is already
 * trashed. With another copy surviving outside Trash, only the trashed
 * copy goes and the photo returns to the library (200). Otherwise unlink
 * its `.maple/trash/` copy + sidecars, hard-delete the doc, emit the File
 * Provider delete change (204). It has no folder-level analogue (#2630).
 */
async function purgeTrashedAsset(
  id: ObjectId,
  info: NonNullable<Awaited<ReturnType<typeof findCoreInfoById>>>,
  set: { status?: number | string },
): Promise<{ error: string } | SurvivorKeptBody | undefined> {
  // A reaped row (#2977) has NO trashed copy — its fileinfo paths point at
  // ORIGINAL library locations, where a file may have quietly returned.
  // Explicit permanent delete authorizes backup erasure, but never unlink a
  // returned original at these stored local paths.
  if (info.deleted_reason === 'reaped') {
    if (!(await admitTrashPurge(id, info, set)))
      return { error: 'Trash state changed — refresh before deleting' };
    await hardDelete(id);
    set.status = 204;
    await recordAndPublishAssetChange({
      kind: 'delete',
      asset_id: id,
      folder_id: info.folder_id,
      abs_path: null,
    }).catch(() => {});
    return;
  }
  const libs = await loadLibraryRoots();
  const trashed = resolveTrashedCopy(info.fileinfo, libs);
  if (trashed === null) {
    // Only the copy the trash action moved into `.maple/trash/` may be erased
    // (#5403); without one there is nothing this purge is allowed to unlink.
    set.status = 404;
    return { error: 'Asset has no copy in Trash' };
  }
  const absPath = trashed.absPath;
  const refusal = await purgeRefusal(trashed, set);
  if (refusal) return refusal;
  const kept = await purgeKeepingSurvivor(id, info, trashed);
  if (kept.kind !== 'full-purge') return survivorResponse(id, kept, set);
  if (!(await admitTrashPurge(id, info, set)))
    return { error: 'Trash state changed — refresh before deleting' };
  try {
    await purgeTrashedCopyCompanions(trashed, info, libs);
  } catch {
    set.status = 500;
    return { error: 'Apple-rendered companion cleanup requires retry' };
  }
  await unlinkTrashedCopy(trashed, unlinkFailure);
  await hardDelete(id);
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

/** Why the trashed copy cannot be purged right now, or null when it can. */
async function purgeRefusal(
  trashed: TrashedCopy,
  set: { status?: number | string },
): Promise<{ error: string } | null> {
  if (!(await libraryReachable(trashed.libraryRoot))) {
    set.status = 503;
    return { error: "The photo's library is unreachable — retry once it is back" };
  }
  if (await refusesFileUnderMarker(trashed.absPath)) {
    set.status = 409;
    return { error: 'The file is under a .mapleignore folder — it is never deleted from there' };
  }
  // A purge would strand an old-name edit it can't read (#5063); the user retries.
  // Not 409: clients read that as "restored elsewhere".
  if (await oldNameEditUnreadable(trashed.absPath)) {
    set.status = 500;
    return { error: "The photo's old-name backup edit can't be read — retry once it can" };
  }
  return null;
}

function survivorResponse(
  id: ObjectId,
  kept: Exclude<SurvivorPurgeOutcome, { kind: 'full-purge' }>,
  set: { status?: number | string },
): { error: string } | SurvivorKeptBody {
  switch (kept.kind) {
    case 'kept':
      set.status = 200;
      return {
        asset_id: id.toHexString(),
        state: 'live',
        abs_path: kept.survivor.absPath,
        cleanup: kept.pendingCleanup > 0 ? 'pending' : 'done',
      };
    case 'changed':
      set.status = 409;
      return { error: 'Trash state changed — refresh before deleting' };
    case 'retry':
      set.status = kept.error instanceof LibraryUnreachableError ? 503 : 500;
      return { error: 'Backup cleanup of the trashed copy requires retry' };
  }
}

async function admitTrashPurge(
  id: ObjectId,
  info: NonNullable<Awaited<ReturnType<typeof findCoreInfoById>>>,
  set: { status?: number | string },
): Promise<boolean> {
  const admitted = await prepareTrashPurge(id.toHexString(), capturedTrashPurge(info));
  if (!admitted) set.status = 409;
  return admitted;
}

// Trash/restore move files on disk — file-access-gated (#2893).
export const trashRoutes = new Elysia()
  .delete(
    '/:id',
    async ({ params, query, set }) => {
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
    },
    { beforeHandle: requireFileAccessBeforeHandle },
  )

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
      beforeHandle: requireFileAccessBeforeHandle,
      body: t.Object({
        target_relative_path: t.Optional(t.String()),
        target_folder_id: t.Optional(t.String()),
      }),
    },
  );
