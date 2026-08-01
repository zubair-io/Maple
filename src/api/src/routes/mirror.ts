/**
 * /api/folders/:id/mirror — operator config for a library's backup/mirror
 * locations, plus a standalone path health-check.
 *
 *   GET  /api/folders/:id/mirror   — current mirror locations for a library
 *   PUT  /api/folders/:id/mirror   — replace the mirror set (validates roots,
 *                                    reloads the in-memory registry)
 *   POST /api/mirror/test          — validate a candidate mirror path without
 *                                    saving (UI "Test" button)
 *   GET  /api/mirror/status        — standing queue depth (pending/dead) + live
 *                                    two-stage "Reconcile now" progress
 *   POST /api/mirror/retry-dead    — re-arm dead-lettered mirror copies
 *   POST /api/mirror/reconcile     — run a full reconcile now (scan → copy) with
 *                                    live progress on /status
 *   GET  /api/mirror/orphans       — dry-run report of mirror files with no
 *                                    primary counterpart (deletes nothing). The
 *                                    deletion itself is the operator-toggled
 *                                    `scrub-mirror-orphans` migration in
 *                                    /settings/workers, not a route here.
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
import { realpath } from 'node:fs/promises';
import { child as childLogger } from '../log.ts';
import { foldersCollection } from '../db/client.ts';
import { validateRoot } from '../fs/root.ts';
import { loadMirrorConfig } from '../fs/mirror-config.ts';
import { mirrorQueueCounts, retryDeadMirrorCopies } from '../fs/mirror-queue.repo.ts';
import { benchedMirrors } from '../fs/mirror-read.ts';
import { runMirrorScrubOnce } from '../workers/mirror/scrub.ts';
import { getMirrorReconcileProgress, startMirrorReconcileNow } from './mirror-reconcile-runner.ts';
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

/** Lexical overlap test: is either path the other, or nested under it. */
function pathsOverlap(x: string, y: string): boolean {
  if (x === y) return true;
  const xSep = x.endsWith(path.sep) ? x : x + path.sep;
  const ySep = y.endsWith(path.sep) ? y : y + path.sep;
  return x.startsWith(ySep) || y.startsWith(xSep);
}

/**
 * Reject a mirror root that would alias the library's own tree (mirror inside
 * primary, or primary inside mirror) — replication would recurse or clobber.
 *
 * Resolves symlinks first (`realpath`) so a mirror root that is a symlink INTO
 * the primary tree is caught: mirrored writes use the raw mirror path with the
 * real fs, bypassing the registry, so a symlink alias would otherwise recurse
 * into the primary. realpath needs the path to exist; falls back to a lexical
 * resolve when it doesn't (a disabled/offline mirror), which still catches the
 * plain-path cases.
 */
async function aliases(a: string, b: string): Promise<boolean> {
  const real = async (p: string) => {
    try {
      return await realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  return pathsOverlap(await real(a), await real(b));
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

        // The alias check always applies — a mirror that overlaps the library
        // tree is a config error regardless of state (symlink-aware for enabled
        // mirrors, whose directory exists and can be realpath'd).
        if (await aliases(resolved, folder.path)) {
          set.status = 400;
          return {
            error: `mirror "${m.path}" overlaps the library's own path`,
          };
        }
        // Only stat the disk for a mirror being *enabled*. A disabled mirror
        // may legitimately be offline/unmounted — validating it would block
        // the operator from pausing a mirror whose disk is currently down,
        // defeating the "disable without losing configuration" intent.
        if (m.enabled) {
          const v = await validateRoot(resolved);
          if (!v.ok) {
            set.status = 400;
            return {
              error: `mirror "${m.path}" is not a usable directory: ${v.error}`,
            };
          }
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
  )
  // Mirror reconcile status — the standing queue depth (pending/dead) plus the
  // live two-stage "Reconcile now" progress, for the mirror section of the
  // Workers settings page.
  // Also reports the read-replica health bench: mirror roots this API process
  // has stopped routing reads to after an I/O failure or timeout, with the
  // remaining cooldown. Empty in the normal case. Process-local by design —
  // this is the state of the process that actually serves the reads.
  .get('/api/mirror/status', async () => {
    const counts = await mirrorQueueCounts();
    return {
      queue: counts,
      reconcile: getMirrorReconcileProgress(),
      reads: { benched: benchedMirrors() },
    };
  })
  // Run a full reconcile now (operator "Reconcile now" button): scan (enqueue
  // missing/stale) then copy (drain the queue), with live two-stage progress on
  // GET /api/mirror/status. Returns immediately; a run already in flight is a
  // no-op. The background worker still auto-reconciles on its own cadence.
  .post('/api/mirror/reconcile', async () => {
    return startMirrorReconcileNow();
  })
  // Re-arm every dead-lettered copy (operator "retry" button). Returns how
  // many rows were revived.
  .post('/api/mirror/retry-dead', async () => {
    const revived = await retryDeadMirrorCopies();
    return { ok: true, revived };
  })
  // Orphan report (DRY RUN): mirror files with no primary counterpart — e.g. the
  // old-layout copies a backup-folder migration relocated on the primary but
  // (before the worker loaded the mirror registry) never removed on the mirror.
  // Reports only; deletes nothing. Skips any mirror whose primary is offline.
  // The actual deletion is the operator-toggled `scrub-mirror-orphans` migration
  // (/settings/workers), which batches + tracks progress — not a route here.
  .get('/api/mirror/orphans', async () => {
    const report = await runMirrorScrubOnce({ apply: false });
    return { report };
  });
