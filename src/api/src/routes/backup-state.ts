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
import { ObjectId } from 'mongodb';
import { assetsCollection, foldersCollection } from '../db/client.ts';
import type { PhotoKitAssetLink, AssetDoc, FolderDoc } from '../db/schema.ts';
import path from 'node:path';

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

    // Resolve the folder so we can compute library-relative paths.
    const folder = await (
      await foldersCollection()
    ).findOne<{ path: string }>({ _id: libraryId }, { projection: { path: 1 } });
    if (!folder) {
      set.status = 404;
      return { error: 'library not found' };
    }

    type ProjectedAsset = Pick<AssetDoc, 'phasset_links' | 'maple_id' | 'fileinfo'> & {
      _id: ObjectId;
    };

    const a = await assetsCollection();
    const rows = await a
      .find<ProjectedAsset>({
        'fileinfo.library_id': libraryId,
        phasset_links: { $elemMatch: { device_id: deviceId, first_seen: { $gte: since } } },
      })
      .project<ProjectedAsset>({ fileinfo: 1, phasset_links: 1, maple_id: 1 })
      .toArray();

    const out = rows.flatMap((r: ProjectedAsset) => {
      const primary = (r.fileinfo ?? []).find(
        (e) => !e.deleted_at && e.library_id.equals(libraryId),
      );
      if (!primary) return [];
      const relPath =
        primary.path === '' ? primary.filename : `${primary.path}/${primary.filename}`;
      return (r.phasset_links ?? [])
        .filter(
          (l: PhotoKitAssetLink) => l.device_id === deviceId && new Date(l.first_seen) >= since,
        )
        .map((l: PhotoKitAssetLink) => ({
          phasset_local_id: l.phasset_local_id,
          first_seen: l.first_seen,
          maple_id: r.maple_id,
          rel_path: relPath,
        }));
    });
    return { assets: out };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    query: t.Object({ device_id: t.Optional(t.String()), since: t.Optional(t.String()) }),
  },
);
