/**
 * GET /api/libraries/:libraryId/backup/state
 *
 * Reconciliation feed — returns the assets the server has seen from a given
 * device within a given library, optionally filtered by `first_seen >= since`.
 * The device calls this on launch and during periodic safety walks to learn
 * which PhotoKit assets are already backed up so it doesn't re-enqueue them.
 *
 * Query:
 *   device_id  — required
 *   since      — optional ISO timestamp; defaults to epoch
 *
 * Response 200:
 *   { assets: [ { phasset_local_id, first_seen, maple_id, rel_path }, ... ] }
 *
 * Response 400 on missing device_id or invalid library id.
 *
 * Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §20.
 */
import { Elysia, t } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import { listBackupState } from '../db/sqlite/repos/backup.repo.ts';
import { findFolderById } from '../db/sqlite/repos/folders.repo.ts';

export const backupStateRoutes = new Elysia().get(
  '/api/libraries/:libraryId/backup/state',
  async ({ params, query, set }) => {
    let libraryId: ObjectId;
    try {
      libraryId = new ObjectId(params.libraryId);
    } catch {
      set.status = 400;
      return { error: 'invalid library id' };
    }

    const deviceId = query.device_id;
    if (!deviceId) {
      set.status = 400;
      return { error: 'device_id required' };
    }

    const since = query.since ? new Date(query.since) : new Date(0);
    if (isNaN(since.getTime())) {
      set.status = 400;
      return { error: 'since must be a valid ISO timestamp' };
    }

    // The library has to exist before we answer — an unknown id is a 404, not
    // an empty feed the device would read as "nothing is backed up".
    const folder = await findFolderById(libraryId);
    if (!folder) {
      set.status = 404;
      return { error: 'library not found' };
    }

    return { assets: await listBackupState(libraryId, deviceId, since) };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    query: t.Object({ device_id: t.Optional(t.String()), since: t.Optional(t.String()) }),
  },
);
