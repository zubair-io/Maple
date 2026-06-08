/**
 * Migration: "Scrub mirror orphans".
 *
 * The deletion half of mirror reconcile. `mirror-scan`/`mirror-copy` only ADD
 * files to a backup mirror; nothing removes a mirror file whose primary moved or
 * was deleted. The most common source is a backup-folder migration that
 * relocated originals on the primary while the worker had no mirror registry
 * loaded (see `worker-main.ts`) — the old-layout copies are stranded on the
 * mirror. Enabling this migration in /settings/workers walks each mirror, finds
 * files with no counterpart under the primary, and deletes them in batches.
 *
 * ## Why this migration is shaped a little differently
 *
 * The other migrations have a cheap indexed DB count of remaining work; orphans
 * don't — finding them is a filesystem diff (mirror tree vs primary). And
 * `countRemaining()` is called from the API process (the status pill +
 * `/migration/migrations` list), so it MUST NOT walk the filesystem. So:
 *
 *  - The walk ("discovery") runs once per enablement inside `runBatch()`, which
 *    only ever executes in the worker process. It caches the orphan list in
 *    worker memory and persists the resulting count onto the migration state doc
 *    (extra `discovered_gen` + `remaining` keys).
 *  - `countRemaining()` reads that persisted count — cheap, and correct from any
 *    process. Until the first discovery of an enablement it returns `1` (a
 *    sentinel) so the worker stays active and actually runs the discovery batch
 *    instead of declaring itself "done" against an empty count.
 *  - A worker restart mid-run loses the in-memory list; the next batch simply
 *    re-discovers (idempotent — already-deleted files are gone from the mirror).
 *
 * Safety is inherited from `findMirrorOrphans`/`deleteOrphanRefs`: a mirror whose
 * PRIMARY root is offline is skipped wholesale (never deletes against an
 * unmounted primary), only a clean ENOENT marks a file orphaned, and every file
 * is re-verified immediately before deletion.
 */

import { child as childLogger } from '../../log.ts';
import {
  loadMigrationState,
  patchMigrationState,
  type MigrationState,
} from '../migration-config.repo.ts';
import { findMirrorOrphans, deleteOrphanRefs, type OrphanRef } from '../mirror/scrub.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:scrub-orphans');

export const SCRUB_MIRROR_ORPHANS_ID = 'scrub-mirror-orphans';

/** Scrub-specific bookkeeping persisted alongside the generic migration state
 * (extra keys on `migrations.<id>`): the enablement generation discovery last
 * ran for, and the orphan count that generation found. */
interface ScrubExtras {
  discovered_gen?: string | null;
  remaining?: number;
}

/** Worker-process memory: the orphan list discovered for the current
 * enablement. Lost on restart → re-discovered on the next batch. */
let discovered: { gen: string; refs: OrphanRef[] } | null = null;

/** The enablement generation = the `started_at` stamp (changes on every
 * enable/reset). Empty string when never enabled. */
function genOf(st: MigrationState): string {
  return st.started_at ?? '';
}

/** Walk the mirrors, cache the orphan refs in memory, and persist the count +
 * generation so `countRemaining()` can read it cheaply from any process. */
async function runDiscovery(gen: string): Promise<number> {
  const scan = await findMirrorOrphans();
  discovered = { gen, refs: scan.orphans };
  await patchMigrationState(SCRUB_MIRROR_ORPHANS_ID, {
    discovered_gen: gen,
    remaining: scan.orphans.length,
  } as Partial<MigrationState>);
  log.info(
    {
      orphans: scan.orphans.length,
      mirrorsScanned: scan.mirrorsScanned,
      filesChecked: scan.filesChecked,
      skippedOfflinePrimary: scan.skippedOfflinePrimary,
    },
    'scrub-orphans: discovery complete',
  );
  return scan.orphans.length;
}

export const scrubMirrorOrphans: Migration = {
  id: SCRUB_MIRROR_ORPHANS_ID,
  title: 'Scrub mirror orphans',
  description:
    'Delete files left on a backup mirror that no longer exist on the primary ' +
    '(e.g. old-layout copies stranded by a backup-folder migration). Walks each ' +
    'mirror, removes files with no primary counterpart, and prunes emptied ' +
    'folders. Skips any mirror whose primary is offline; never deletes when in doubt.',

  async countRemaining(): Promise<number> {
    const st = (await loadMigrationState(SCRUB_MIRROR_ORPHANS_ID)) as MigrationState & ScrubExtras;
    if (!st.enabled) return 0;
    const gen = genOf(st);
    // Discovered this enablement → the persisted count is authoritative & cheap.
    if (st.discovered_gen === gen) return st.remaining ?? 0;
    // Not yet discovered this enablement → 1 keeps the worker from declaring
    // "done" before runBatch performs the discovery walk.
    return 1;
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const st = (await loadMigrationState(SCRUB_MIRROR_ORPHANS_ID)) as MigrationState & ScrubExtras;
    const gen = genOf(st);

    // ── Discovery phase: first batch of a fresh enablement. ──────────────────
    if (st.discovered_gen !== gen) {
      await runDiscovery(gen);
      // No deletions this tick; the next tick drains the discovered list. The
      // worker re-reads countRemaining after this batch — it now reflects the
      // discovered count, so it idles straight to 'done' if zero.
      return { processed: 0, errors: 0 };
    }

    // ── Deletion phase. ──────────────────────────────────────────────────────
    // Re-discover if the worker restarted since discovery (memory lost). Idempotent:
    // already-deleted orphans are gone from the mirror, so the walk returns only
    // what still remains.
    if (discovered?.gen !== gen) await runDiscovery(gen);

    const refs = discovered!.refs.splice(0, batchSize);
    if (refs.length === 0) {
      await patchMigrationState(SCRUB_MIRROR_ORPHANS_ID, {
        remaining: 0,
      } as Partial<MigrationState>);
      return { processed: 0, errors: 0 };
    }

    const res = await deleteOrphanRefs(refs);
    await patchMigrationState(SCRUB_MIRROR_ORPHANS_ID, {
      remaining: discovered!.refs.length,
    } as Partial<MigrationState>);
    if (res.deleted > 0 || res.dirsPruned > 0 || res.errors > 0) {
      log.info(
        {
          deleted: res.deleted,
          notOrphan: res.notOrphan,
          dirsPruned: res.dirsPruned,
          errors: res.errors,
          remaining: discovered!.refs.length,
        },
        'scrub-orphans: batch complete',
      );
    }
    // `processed` = items resolved this batch (deleted + already-gone +
    // reappeared-on-primary); the worker adds it to cumulative progress.
    return { processed: res.deleted + res.notOrphan, errors: res.errors };
  },
};
