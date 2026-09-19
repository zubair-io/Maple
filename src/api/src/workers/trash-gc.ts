/**
 * Trash garbage collector — purges trashed assets older than the
 * retention window. Per asset where `deleted_at < now - retentionDays`:
 *   1. Unlink the file at `abs_path` (already in .maple/trash/...).
 *   2. Unlink every paired sidecar.
 *   3. Delete the asset row from SQLite.
 * EXCEPT reaped rows (`deleted_reason: 'reaped'`, #2977): those have no
 * trashed copy — steps 1–2 are skipped entirely and the purge is a pure
 * DB delete, so a file that quietly returned to the original location can
 * never be unlinked by this sweep.
 *
 * Idempotent. Best-effort on per-file failures: a failed unlink is logged
 * and the asset row is still deleted so subsequent runs don't keep
 * retrying the same broken row.
 *
 * The candidate query and the delete both live in the repositories
 * (`listTrashedBefore`, `hardDelete`) rather than here, so the one thing this
 * sweep must get right about the database — reaching the `assets_trashed`
 * index instead of scanning every asset on a daily timer — is stated beside
 * the table and not re-derived at each call site (#3787).
 *
 * NOT a stage controller — this is a library-wide, interval-fired job.
 * Started from `src/api/src/index.ts` via setInterval.
 */

import { unlink } from 'node:fs/promises';
import { listTrashedBefore, type TrashedAsset } from '../db/sqlite/repos/assets.sweeps.ts';
import { hardDelete } from '../db/sqlite/repos/assets.trash.ts';
import { listPairedSidecars } from '../fs/xmp-conflict.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('trash-gc');
const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = DAY_MS;

export interface TrashGcOptions {
  retentionDays?: number;
}

export interface TrashGcSummary {
  scanned: number;
  purged: number;
  errors: number;
}

/**
 * What purging one asset cost: whether the row went away, and how many unlinks
 * failed for a reason other than "the file was already gone".
 *
 * `errors` is a count rather than a flag because one asset can fail several
 * times — the original plus each of its sidecars — and the summary reports
 * failures, not failed assets.
 */
interface PurgeOutcome {
  purged: boolean;
  errors: number;
}

/**
 * Unlink a path, treating "already gone" as success.
 *
 * ENOENT is the expected outcome for a sweep that re-runs over a row whose
 * files a previous pass removed before it crashed, and for a sidecar the user
 * deleted by hand. Counting it would make a retry look like a fault forever.
 */
async function unlinkTolerantly(target: string, message: string): Promise<boolean> {
  try {
    await unlink(target);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT') return true;
    log.warn({ target, err: err instanceof Error ? err.message : err }, message);
    return false;
  }
}

/** Purge one trashed asset: its file, its sidecars, then its row. */
async function purgeTrashedAsset(
  doc: TrashedAsset,
  libs: ReadonlyMap<string, string>,
): Promise<PurgeOutcome> {
  // A reaped row (#2977) has NO trashed file copy — its locations point at
  // ORIGINAL library paths, where a file may have quietly returned without a
  // revive having run yet. Never touch disk for these: purge is a pure DB
  // delete. (Orphaned previews are cache-gc's job.)
  if (doc.deleted_reason === 'reaped') {
    await hardDelete(doc._id);
    return { purged: true, errors: 0 };
  }

  const absPath = assetAbsPath(doc, libs);
  if (absPath === null) {
    // Leave the row alone: without a resolvable path there is nothing to
    // reclaim on disk, and an unregistered library is a condition that can be
    // fixed, after which the next pass purges properly.
    log.warn({ _id: doc._id.toHexString() }, 'purge skip — asset has no resolvable location');
    return { purged: false, errors: 1 };
  }

  const originalOk = await unlinkTolerantly(absPath, 'purge unlink failed');
  const sidecarResults: boolean[] = [];
  for (const sidecar of await listPairedSidecars(absPath)) {
    sidecarResults.push(await unlinkTolerantly(sidecar, 'purge sidecar unlink failed'));
  }
  await hardDelete(doc._id);
  return {
    purged: true,
    errors: (originalOk ? 0 : 1) + sidecarResults.filter((ok) => !ok).length,
  };
}

/** One pass. Exported for tests + callable from setInterval. */
export async function runTrashGcOnce(opts: TrashGcOptions = {}): Promise<TrashGcSummary> {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoffIso = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
  const candidates = await listTrashedBefore(cutoffIso);
  // A library-root lookup that fails leaves every path unresolvable, which the
  // per-asset branch above reports and skips — better than aborting the pass,
  // since reaped rows need no roots at all and still purge.
  const libs = await loadLibraryRoots().catch(() => new Map<string, string>());

  const outcomes: PurgeOutcome[] = [];
  for (const doc of candidates) {
    outcomes.push(await purgeTrashedAsset(doc, libs));
  }

  const summary = outcomes.reduce<TrashGcSummary>(
    (acc, outcome) => ({
      scanned: acc.scanned + 1,
      purged: acc.purged + (outcome.purged ? 1 : 0),
      errors: acc.errors + outcome.errors,
    }),
    { scanned: 0, purged: 0, errors: 0 },
  );
  if (summary.scanned > 0) log.info(summary, 'trash-gc pass complete');
  return summary;
}

export interface TrashGcHandle {
  stop: () => void;
}

/** Start a background loop. Returns a handle whose `stop()` cancels it. */
export function startTrashGc(opts: TrashGcOptions & { intervalMs?: number } = {}): TrashGcHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await runTrashGcOnce(opts);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'trash-gc pass crashed');
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Fire once on startup so a freshly-booted server doesn't wait 24h
  // before its first sweep. Errors are swallowed by tick() so a stray
  // failure doesn't crash boot.
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
