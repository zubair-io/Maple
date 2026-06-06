/**
 * /api/folders/:id/mirror — operator config for a library's backup/mirror
 * locations, plus a standalone path health-check.
 *
 *   GET  /api/folders/:id/mirror   — current mirror locations for a library
 *   PUT  /api/folders/:id/mirror   — replace the mirror set (validates roots,
 *                                    reloads the in-memory registry)
 *   POST /api/mirror/test          — validate a candidate mirror path without
 *                                    saving (UI "Test" button)
 *
 * Mounted behind `requireAuth` — see `src/index.ts`.
 *
 * Setting a mirror here makes every durable write/move the server performs
 * under the library's primary root replicate to each enabled mirror root (see
 * `fs/mirrored.ts`). Existing files are NOT back-filled by this call — a fresh
 * mirror is populated lazily as files are written/moved, or in bulk by the
 * reconcile worker (tracked separately); see the PR description.
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import * as path from 'node:path';
import { child as childLogger } from '../log.ts';
import { foldersCollection } from '../db/client.ts';
import { validateRoot } from '../fs/root.ts';
import { loadMirrorConfig } from '../fs/mirror-config.ts';
import type { MirrorLocation } from '../db/schema.ts';

const log = childLogger('mirror:routes');

const MirrorBody = t.Object({
  mirrors: t.Array(
    t.Object({
      path: t.String({ minLength: 1 }),
      enabled: t.Boolean(),
    }),
  ),
});

/**
 * Reject a mirror root that would alias the library's own tree (mirror inside
 * primary, or primary inside mirror) — replication would recurse or clobber.
 */
function aliases(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  if (x === y) return true;
  const xSep = x.endsWith(path.sep) ? x : x + path.sep;
  const ySep = y.endsWith(path.sep) ? y : y + path.sep;
  return x.startsWith(ySep) || y.startsWith(xSep);
}

export const mirrorRoutes = new Elysia()
  .get('/api/folders/:id/mirror', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'invalid folder id' };
    }
    const coll = await foldersCollection();
    const folder = await coll.findOne({ _id: new ObjectId(params.id) });
    if (!folder) {
      set.status = 404;
      return { error: 'folder not found' };
    }
    return { mirrors: folder.mirrors ?? [] };
  })
  .put(
    '/api/folders/:id/mirror',
    async ({ params, body, set }) => {
      if (!ObjectId.isValid(params.id)) {
        set.status = 400;
        return { error: 'invalid folder id' };
      }
      const coll = await foldersCollection();
      const folder = await coll.findOne({ _id: new ObjectId(params.id) });
      if (!folder) {
        set.status = 404;
        return { error: 'folder not found' };
      }

      // Validate + de-dupe the requested mirror roots.
      const seen = new Set<string>();
      const mirrors: MirrorLocation[] = [];
      for (const m of body.mirrors) {
        const resolved = path.resolve(m.path);
        if (seen.has(resolved)) continue;
        seen.add(resolved);

        if (aliases(resolved, folder.path)) {
          set.status = 400;
          return {
            error: `mirror "${m.path}" overlaps the library's own path`,
          };
        }
        const v = await validateRoot(resolved);
        if (!v.ok) {
          set.status = 400;
          return {
            error: `mirror "${m.path}" is not a usable directory: ${v.error}`,
          };
        }
        mirrors.push({ path: resolved, enabled: m.enabled });
      }

      await coll.updateOne({ _id: folder._id }, { $set: { mirrors } });
      await loadMirrorConfig(); // refresh the in-memory registry — no restart
      log.info({ folder: folder.path, mirrors: mirrors.length }, 'updated library mirrors');
      return { ok: true, mirrors };
    },
    { body: MirrorBody },
  )
  .post(
    '/api/mirror/test',
    async ({ body, set }) => {
      const resolved = path.resolve(body.path);
      const v = await validateRoot(resolved);
      if (!v.ok) {
        set.status = 400;
        return { ok: false, error: v.error };
      }
      return { ok: true, path: resolved };
    },
    { body: t.Object({ path: t.String({ minLength: 1 }) }) },
  );
