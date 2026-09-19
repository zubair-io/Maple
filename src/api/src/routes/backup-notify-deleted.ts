/**
 * POST /api/libraries/:libraryId/backup/notify-deleted
 *
 * The device noticed one or more PHAssets are no longer in the user's Apple
 * Photos library. Mark the cloud copies with `deleted_from_photos: true`. The
 * asset rows stay — we keep the bytes.
 *
 * Headers:
 *   X-Maple-Device-Id — required
 *
 * Body (JSON):
 *   { "phasset_local_ids": ["B5C9.../L0/001", ...] }
 *
 * Responses:
 *   200 — { updated: <count> }
 *   400 — missing header or invalid body
 *   404 — library not found
 */
import { backupLibrary, backupLibraryId } from './backup-id.ts';
import { Elysia, t } from 'elysia';
import { markDeletedFromPhotos } from '../db/sqlite/repos/backup.repo.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('backup-notify-deleted');

export const backupNotifyDeletedRoutes = new Elysia().post(
  '/api/libraries/:libraryId/backup/notify-deleted',
  async ({ params, headers, body, set }) => {
    const libraryId = backupLibraryId(params.libraryId);
    if (libraryId instanceof Response) return libraryId;

    // Extract + validate required headers.
    const deviceId = headers['x-maple-device-id'];
    if (!deviceId) {
      set.status = 400;
      return { error: 'X-Maple-Device-Id header required' };
    }

    // Check library exists.
    const folder = await backupLibrary(libraryId);
    if (folder instanceof Response) return folder;

    // Parse and validate JSON body.
    const parsed =
      typeof body === 'object' && body !== null && !Buffer.isBuffer(body)
        ? body
        : (() => {
            try {
              return JSON.parse(
                body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : String(body),
              );
            } catch {
              return null;
            }
          })();

    if (!parsed || typeof parsed !== 'object') {
      set.status = 400;
      return { error: 'body must be JSON' };
    }

    const phassetLocalIds: unknown = (parsed as any).phasset_local_ids;
    if (!Array.isArray(phassetLocalIds)) {
      set.status = 400;
      return { error: 'phasset_local_ids must be an array' };
    }
    if (phassetLocalIds.length === 0) {
      return { updated: 0 };
    }
    if (!phassetLocalIds.every((id) => typeof id === 'string' && id.length > 0)) {
      set.status = 400;
      return {
        error: 'phasset_local_ids must be an array of non-empty strings',
      };
    }

    const ids = phassetLocalIds as string[];

    // Mark each matching asset as gone from Apple Photos.
    // v1 spec: set deleted_from_photos = true when this device reports deletion.
    //
    // Scoped by a location in this library, not the retired top-level
    // `folder_id` (dropped in drop-abs-path-2026-05-21). The legacy field
    // never matched a real row, so the previous query silently updated
    // nothing and devices' Photos-deletion reports were lost. Mirrors
    // backup-sidecar / backup-rendered scoping.
    const updated = await markDeletedFromPhotos(libraryId, deviceId, ids);

    log.debug({ deviceId, count: updated }, 'notify-deleted processed');
    set.status = 200;
    return { updated };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
