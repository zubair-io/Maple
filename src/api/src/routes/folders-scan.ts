/**
 * The two folder scan routes. Both re-walk the library as a `folder_scan`
 * operation the worker tier runs, and wait for it:
 *
 *   POST /api/folders/:id/rescan — zeroes every stage version on the library's
 *     assets, then re-walks, so a file whose only location was a soft-deleted
 *     old path is found and relinked.
 *   POST /api/folders/:id/scan   — the content-aware re-discover the web fires
 *     when a folder is opened. It does not zero stage versions, and a folder
 *     scanned in the last few minutes is not walked again.
 */

import { Elysia } from 'elysia';
import { requireFileAccessBeforeHandle } from '../auth/middleware.ts';
import { safeObjectId } from '../db/object-id.ts';
import { resetFolderStages } from '../db/repos/folder-assets.repo.ts';
import { findFolderById } from '../db/repos/folders.repo.ts';
import type { FolderWithId } from '../db/schema.ts';
import {
  awaitOperation,
  DEFAULT_OPERATION_WAIT,
  operationDeadline,
  startOperation,
  type OperationWait,
} from '../job-runner/operations.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('folders');

/** Long enough to absorb a burst of navigation, short enough that a folder reopened later picks up moves. */
const SCAN_RECENT_WINDOW_MS = 3 * 60 * 1000;

/**
 * The folder for a scan route, or its refusal. The scan routes' refusals carry
 * `ok: false` and spell the field `folderId`, unlike the other folder routes',
 * and both envelopes are on the wire.
 */
async function scanTargetOrError(rawId: string): Promise<FolderWithId | Response> {
  const id = safeObjectId(rawId);
  if (id === null) {
    return Response.json({ ok: false, error: 'Invalid folderId' }, { status: 400 });
  }
  const folder = await findFolderById(id);
  return folder ?? Response.json({ ok: false, error: 'Folder not found' }, { status: 404 });
}

/**
 * Re-walks a library on the worker tier and waits for it, answering the new
 * `last_scan` stamp or the response to send instead. A scan of the folder
 * already queued or running is joined rather than doubled: a walk of a large
 * library outlasts the de-bounce by hours, and overlapping walks once
 * saturated the database.
 */
async function rewalkFolder(
  folder: FolderWithId,
  wait: OperationWait,
  signal: AbortSignal,
): Promise<string | Response> {
  const until = operationDeadline(wait, signal);
  const { job } = await startOperation('folder_scan', { folderId: folder._id.toHexString() });
  const finished = await awaitOperation(job._id, until);
  if (finished === null) {
    return Response.json(
      { ok: false, error: 'The scan is still running and will finish in the background' },
      { status: 504 },
    );
  }
  const scannedAt = finished.result?.['last_scan'];
  if (finished.status !== 'done' || typeof scannedAt !== 'string') {
    return Response.json(
      { ok: false, error: finished.error ?? `The scan was ${finished.status}` },
      { status: 500 },
    );
  }
  return scannedAt;
}

export const folderScanRoutes = (wait: OperationWait = DEFAULT_OPERATION_WAIT) =>
  new Elysia({ prefix: '/api/folders' })
    .post(
      '/:id/rescan',
      async ({ params, request }) => {
        const folder = await scanTargetOrError(params.id);
        if (folder instanceof Response) return folder;
        const resetCount = await resetFolderStages(folder._id);
        const scannedAt = await rewalkFolder(folder, wait, request.signal);
        if (scannedAt instanceof Response) return scannedAt;

        log.info(
          { folderId: params.id, path: folder.path, modified: resetCount },
          'rescan: stage versions zeroed + folder re-walked',
        );
        return {
          ok: true,
          folderId: params.id,
          path: folder.path,
          reset: resetCount,
          last_scan: scannedAt,
        };
      },
      { beforeHandle: requireFileAccessBeforeHandle },
    )
    .post(
      '/:id/scan',
      async ({ params, request }) => {
        const folder = await scanTargetOrError(params.id);
        if (folder instanceof Response) return folder;
        const lastScan = folder.last_scan ? Date.parse(folder.last_scan) : NaN;
        if (Number.isFinite(lastScan) && Date.now() - lastScan < SCAN_RECENT_WINDOW_MS) {
          return {
            ok: true,
            folderId: params.id,
            path: folder.path,
            skipped: 'recent' as const,
            last_scan: folder.last_scan,
          };
        }
        const scannedAt = await rewalkFolder(folder, wait, request.signal);
        if (scannedAt instanceof Response) return scannedAt;

        log.info(
          { folderId: params.id, path: folder.path },
          'scan: folder re-walked (discover-only)',
        );
        return { ok: true, folderId: params.id, path: folder.path, last_scan: scannedAt };
      },
      { beforeHandle: requireFileAccessBeforeHandle },
    );
