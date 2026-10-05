/**
 * Trash garbage collector — purges trashed assets older than the
 * retention window. Per asset where `deleted_at < now - retentionDays`:
 *   1. Resolve and unlink the recorded Apple-rendered companion, if present.
 *   2. Unlink the file at `abs_path` (already in .maple/trash/...).
 *   3. Unlink every paired sidecar.
 *   4. Delete the asset row from SQLite.
 * EXCEPT reaped rows (`deleted_reason: 'reaped'`, #2977): those have no
 * trashed copy — steps 1–3 are skipped entirely. Reaped rows with backup
 * entries remain until explicit permanent delete; elapsed absence does not
 * authorize backup erasure. Other reaped rows are DB-only cleanup, so a file
 * that quietly returned to the original location is never unlinked.
 *
 * Idempotent. Companion resolution/unlink failure retains the row and its
 * association for retry. Original/sidecar unlinks retain their existing
 * best-effort behavior: failures are logged before the row is deleted.
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
import { listTrashedBefore, type TrashedAsset } from '../db/repos/assets.sweeps.ts';
import { deleteReapedWithoutActiveBackup, hardDelete } from '../db/repos/assets.trash.ts';
import { preparePurge } from '../cloud-backup/lifecycle.ts';
import { listPairedSidecars } from '../fs/xmp-conflict.ts';
import { assetAbsPath, assetLibraryPath } from '../indexer/images.repo.ts';
import { resolvePurgeCompanion } from '../library/purge-rendered-companion.ts';
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

/** Missing/reaped assets have no user Trash intent, even after the local GC clock expires. */
async function purgeReapedRow(doc: TrashedAsset): Promise<PurgeOutcome> {
  const result = await deleteReapedWithoutActiveBackup(doc._id);
  if (!result.deletedCount)
    log.info(
      { assetId: doc._id.toHexString(), reason: 'reaped-row-retained' },
      'retaining reaped asset with backups or changed live state',
    );
  return { purged: result.deletedCount > 0, errors: 0 };
}

/** Purge one intentionally trashed asset, or clean up an unbacked reaped row. */
async function purgeTrashedAsset(
  doc: TrashedAsset,
  libs: ReadonlyMap<string, string>,
): Promise<PurgeOutcome> {
  // A reaped row (#2977) has NO trashed file copy — its locations point at
  // ORIGINAL library paths, where a file may have quietly returned without a
  // revive having run yet. Never touch disk for these. Backed rows need an
  // explicit permanent-delete intent; local retention cannot erase them.
  if (doc.deleted_reason === 'reaped') {
    return purgeReapedRow(doc);
  }

  const absPath = assetAbsPath(doc, libs);
  if (absPath === null) {
    // Leave the row alone: without a resolvable path there is nothing to
    // reclaim on disk, and an unregistered library is a condition that can be
    // fixed, after which the next pass purges properly.
    log.warn({ _id: doc._id.toHexString() }, 'purge skip — asset has no resolvable location');
    return { purged: false, errors: 1 };
  }

  await preparePurge(doc._id.toHexString());
  try {
    const companion = await resolvePurgeCompanion(
      assetLibraryPath(doc, libs)!,
      doc.apple_rendered_path,
      absPath,
    );
    if (companion) await unlink(companion);
  } catch (error) {
    log.warn(
      { _id: doc._id.toHexString(), err: String(error) },
      'purge companion cleanup requires retry',
    );
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
