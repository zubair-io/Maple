/**
 * Trash garbage collector — purges trashed assets older than the
 * retention window. Per asset where `deleted_at < now - retentionDays`:
 *   - Another copy of the photo survives outside Trash (#5403): drop only the
 *     trashed location, unlink its file and sidecars, and return the photo to
 *     the library with its row and backups intact (`library/trash-purge-survivor.ts`).
 *   - Otherwise: unlink the recorded Apple companions, the trashed copy and
 *     its sidecars, erase its backups, and delete the asset row.
 * Every file unlink of a copy or sidecar refuses any path that does not
 * resolve inside the library's `.maple/trash/` (`library/trashed-copy.ts`).
 * EXCEPT reaped rows (`deleted_reason: 'reaped'`, #2977): those have no
 * trashed copy, so no file is touched. Reaped rows with backup
 * entries remain until explicit permanent delete; elapsed absence does not
 * authorize backup erasure. Other reaped rows are DB-only cleanup, so a file
 * that quietly returned to the original location is never unlinked.
 *
 * Idempotent. Companion resolution/unlink failure retains the row and its
 * association for retry. Original/sidecar unlinks retain their existing
 * best-effort behavior: failures are logged before the row is deleted.
 *
 * The candidate query and the delete both live in the repositories
 * (`listTrashedBefore`, `hardDeleteAdmittedPurge`) rather than here, so the one thing this
 * sweep must get right about the database — reaching the `assets_trashed`
 * index instead of scanning every asset on a daily timer — is stated beside
 * the table and not re-derived at each call site (#3787).
 *
 * NOT a stage controller — this is a library-wide, interval-fired job.
 * Started from `src/api/src/index.ts` via setInterval.
 */

import { refusesFileUnderMarker } from '../fs/mapleignore-guard.ts';
import { listTrashedBefore, type TrashedAsset } from '../db/repos/assets.sweeps.ts';
import {
  deleteReapedWithoutActiveBackup,
  hardDeleteAdmittedPurge,
} from '../db/repos/assets.trash.ts';
import { prepareTrashPurge, releaseTrashPurge } from '../cloud-backup/lifecycle.ts';
import { capturedTrashPurge } from '../cloud-backup/trash-purge-admission.ts';
import { oldNameEditUnreadable } from '../fs/legacy-backup-sidecar.ts';
import {
  libraryReachable,
  logPurgeFailure,
  purgeTrashedCopyCompanions,
  resolveTrashedCopy,
  unlinkTrashedCopy,
  type TrashedCopy,
} from '../library/trashed-copy.ts';
import { purgeKeepingSurvivor } from '../library/trash-purge-survivor.ts';
import { drainLocalPurges } from '../library/local-purge-drain.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('trash-gc');
const unlinkFailure = logPurgeFailure(log, 'purge unlink failed');
const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = DAY_MS;
const CLEANUP_INTERVAL_MS = 60_000;

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

/** Missing/reaped assets have no user Trash intent, even after the local GC clock expires. */
async function purgeReapedRow(doc: TrashedAsset): Promise<PurgeOutcome> {
  const result = await deleteReapedWithoutActiveBackup(doc._id, undefined, capturedTrashPurge(doc));
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

  const trashed = resolveTrashedCopy(doc.fileinfo, libs);
  if (trashed === null) {
    // Leave the row alone: with no location inside `.maple/trash/` there is no
    // copy this purge is allowed to erase (#5403), and an unregistered library
    // is a condition that can be fixed, after which the next pass purges.
    log.warn({ _id: doc._id.toHexString() }, 'purge skip — asset has no copy in Trash');
    return { purged: false, errors: 1 };
  }
  const absPath = trashed.absPath;

  // An offline volume makes every file look gone; keep the row until it is back.
  if (!(await libraryReachable(trashed.libraryRoot))) {
    log.warn({ _id: doc._id.toHexString() }, 'purge skip — the library is unreachable');
    return { purged: false, errors: 1 };
  }

  // Never unlink a file under a `.mapleignore` folder (#5398), whatever the
  // row says; `.maple/trash/` itself is never under the guard.
  if (await refusesFileUnderMarker(absPath)) {
    log.warn({ _id: doc._id.toHexString(), absPath }, 'purge skip — file is under .mapleignore');
    return { purged: false, errors: 1 };
  }

  // A purge would strand an old-name edit it can't read (#5063); keep both for a retry.
  if (await oldNameEditUnreadable(absPath)) {
    log.warn(
      { _id: doc._id.toHexString() },
      "purge skip — the photo's old-name edit can't be read",
    );
    return { purged: false, errors: 1 };
  }
  const kept = await purgeKeepingSurvivor(doc._id, doc, trashed, libs);
  if (kept.kind === 'kept') return { purged: true, errors: kept.pendingCleanup };
  if (kept.kind === 'changed') return candidateChanged(doc);
  if (kept.kind === 'retry') {
    log.warn(
      { _id: doc._id.toHexString(), err: String(kept.error) },
      'purge skip — backup cleanup of the trashed copy requires retry',
    );
    return { purged: false, errors: 1 };
  }
  return purgeWholeAsset(doc, trashed, libs);
}

function candidateChanged(doc: TrashedAsset): PurgeOutcome {
  log.info(
    { assetId: doc._id.toHexString() },
    'purge skip — Trash candidate changed or has an active move',
  );
  return { purged: false, errors: 0 };
}

/** No other copy survives: erase the trashed copy, its companions and backups, and the row. */
async function purgeWholeAsset(
  doc: TrashedAsset,
  trashed: TrashedCopy,
  libs: ReadonlyMap<string, string>,
): Promise<PurgeOutcome> {
  if (!(await prepareTrashPurge(doc._id.toHexString(), capturedTrashPurge(doc)))) {
    return candidateChanged(doc);
  }
  try {
    await purgeTrashedCopyCompanions(trashed, doc, libs);
  } catch (error) {
    await releaseTrashPurge(doc._id.toHexString());
    log.warn(
      { _id: doc._id.toHexString(), err: String(error) },
      'purge companion cleanup requires retry',
    );
    return { purged: false, errors: 1 };
  }
  const errors = await unlinkTrashedCopy(trashed, unlinkFailure);
  const deleted = await hardDeleteAdmittedPurge(doc._id);
  if (!deleted.deletedCount) return candidateChanged(doc);
  return { purged: true, errors };
}

/** One asset's failure is counted and logged; it never stops the pass. */
function purgeCrashed(doc: TrashedAsset, err: unknown): PurgeOutcome {
  log.error({ _id: doc._id.toHexString(), err: String(err) }, 'purge failed — retrying next pass');
  return { purged: false, errors: 1 };
}

let draining: Promise<void> | null = null;

/** Drain owed purge unlinks; overlapping calls share the one in flight. */
function drainCleanup(): Promise<void> {
  draining ??= drainLocalPurges()
    .then(() => undefined)
    .catch((err: unknown) => log.warn({ err: String(err) }, 'purge cleanup drain failed'))
    .finally(() => {
      draining = null;
    });
  return draining;
}

/** One pass. Exported for tests + callable from setInterval. */
export async function runTrashGcOnce(opts: TrashGcOptions = {}): Promise<TrashGcSummary> {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoffIso = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
  await drainCleanup();
  const candidates = await listTrashedBefore(cutoffIso);
  // A library-root lookup that fails leaves every path unresolvable, which the
  // per-asset branch above reports and skips — better than aborting the pass,
  // since reaped rows need no roots at all and still purge.
  const libs = await loadLibraryRoots().catch(() => new Map<string, string>());

  const outcomes: PurgeOutcome[] = [];
  for (const doc of candidates) {
    outcomes.push(
      await purgeTrashedAsset(doc, libs).catch((err: unknown) => purgeCrashed(doc, err)),
    );
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
  // Owed unlinks of kept-photo purges retry on the stage ladder, not daily.
  const cleanupTimer = setInterval(() => {
    if (!stopped) void drainCleanup();
  }, CLEANUP_INTERVAL_MS);
  // Fire once on startup so a freshly-booted server doesn't wait 24h
  // before its first sweep. Errors are swallowed by tick() so a stray
  // failure doesn't crash boot.
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      clearInterval(cleanupTimer);
    },
  };
}
