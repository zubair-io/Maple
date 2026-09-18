/**
 * Change log garbage collector — purges `asset_changes` rows older than the
 * retention window.
 *
 * Problem (#3741):
 * asset_changes has no retention policy and dominates the database (176M rows,
 * 83% of all index bytes on prod).
 *
 * Why pruning is safe by design:
 * Cursor allocation ($inc on `server_state`) and row insert are separate operations.
 * Cursors are monotonic and tolerate gaps. Clients (File Provider extension,
 * RemoteCatalog, ChangeFeedClient) recover through the 409 stale-cursor path,
 * which triggers full working-set re-enumeration. Rows dropped by a retention sweep
 * land in exactly that path.
 *
 * Invariants:
 * 1. Library-wide, interval-fired job in `maintenance.ts` (mirrors `trash-gc.ts`).
 * 2. Deletes in bounded batches, yielding between batches so HTTP handlers are never starved.
 * 3. The retention window is a DB-backed setting with a control on Settings → Workers,
 *    defaulting to 30 days to match trash-gc.
 * 4. `server_state` cursor stays monotonic; pruning NEVER rewinds it.
 * 5. Cooperative cancellation, single-flight guard, and per-pass batch cap prevent
 *    event-loop starvation and runaway sweeps.
 * 6. Every pass raises a monotonic retention floor in `server_state` BEFORE it
 *    deletes anything. That ordering is what makes the poll route's staleness
 *    check race-free — see `raiseChangeLogPruneFloor` in `db/changes.repo.ts`.
 * 7. An unreadable config skips the pass. Deleting is irreversible, so "we could
 *    not read the operator's retention window" must never mean "use the default".
 */

import type { Collection, Db } from 'mongodb';
import { assetChangesCollection } from '../db/client.ts';
import { raiseChangeLogPruneFloor } from '../db/changes.repo.ts';
import type { AssetChangeDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { loadChangeLogGcConfig, recordChangeLogGcRun } from './change-log-gc-config.repo.ts';

const log = childLogger('change-log-gc');
const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = DAY_MS;
const BATCH_SIZE = 5_000;
const BATCH_PAUSE_MS = 25;
const MAX_BATCHES_PER_PASS = 20_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ChangeLogGcOptions {
  retentionDays?: number;
  batchSize?: number;
  pauseMs?: number;
  shouldStop?: () => boolean;
  dbOverride?: Db;
}

export interface ChangeLogGcSummary {
  skipped: boolean;
  deleted: number;
  batches: number;
  cutoffCursor: number | null;
  prunedThrough: number;
  durationMs: number;
  remaining: number;
  retentionDays: number;
}

/**
 * Is this row definitively older than the cutoff?
 *
 * A row whose `at` is missing or unparseable answers `false` — it is kept, not
 * pruned. `at` is required by `AssetChangeDoc` and stamped by every writer, so
 * this is a belt-and-braces guard rather than a live case; the direction is
 * what matters. `undefined < Date` is `false` in JavaScript, which would have
 * given the same answer by accident, but an accident is a bad thing to rest an
 * irreversible delete on. Keeping an undatable row costs storage the operator
 * can see on the settings panel (the row count stops falling, and the warning
 * below says why); deleting one on a silently-false comparison costs change
 * history nobody can get back.
 */
function isOlderThanCutoff(at: Date | undefined, cutoffDate: Date): boolean {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return false;
  return at < cutoffDate;
}

/**
 * Finds the highest cursor where `at < cutoffDate` using indexed binary search over
 * `{ cursor: 1 }`. Since cursors are allocated in increasing order over time, point
 * lookups on `cursor` find the boundary in O(log N) operations without scanning the
 * collection or requiring an index on `at`.
 *
 * Precision: the boundary is exact only to the extent that `at` rises with
 * `cursor`, and the write path guarantees that only loosely — `recordAssetChangeRow`
 * allocates the cursor and stamps `at: new Date()` as two separate steps, so two
 * writers racing can commit cursor N with a marginally later timestamp than N+1.
 * A binary search over a sequence with a local inversion settles a few rows off,
 * and since the delete is `cursor <= best`, rows a few milliseconds newer than the
 * cutoff can go with them. At a 30-day boundary that is immaterial; do not read
 * the result as a precise timestamp partition.
 */
export async function findRetentionCutoffCursor(
  coll: Collection<AssetChangeDoc>,
  cutoffDate: Date,
): Promise<number | null> {
  const lowestDoc = await coll
    .find({}, { projection: { cursor: 1, at: 1 } })
    .sort({ cursor: 1 })
    .limit(1)
    .next();

  if (!lowestDoc) return null;

  if (!isOlderThanCutoff(lowestDoc.at, cutoffDate)) {
    if (!(lowestDoc.at instanceof Date)) {
      log.warn(
        { cursor: lowestDoc.cursor },
        'oldest change row has no usable `at`; retention cannot date it, so nothing is pruned this pass',
      );
    }
    return null;
  }

  const highestDoc = await coll
    .find({}, { projection: { cursor: 1, at: 1 } })
    .sort({ cursor: -1 })
    .limit(1)
    .next();

  if (!highestDoc) {
    return null;
  }

  if (isOlderThanCutoff(highestDoc.at, cutoffDate)) {
    return highestDoc.cursor;
  }

  let low = lowestDoc.cursor;
  let high = highestDoc.cursor;
  let best = lowestDoc.cursor;

  while (low <= high) {
    const mid = Math.floor(low + (high - low) / 2);
    const doc = await coll.findOne(
      { cursor: { $gte: mid } },
      { projection: { cursor: 1, at: 1 }, sort: { cursor: 1 } },
    );

    if (!doc || doc.cursor > high) {
      high = mid - 1;
      continue;
    }

    if (isOlderThanCutoff(doc.at, cutoffDate)) {
      best = Math.max(best, doc.cursor);
      low = doc.cursor + 1;
    } else {
      high = doc.cursor - 1;
    }
  }

  return best;
}

/** A pass that deliberately did nothing: the job is off, or its config was unreadable. */
function skippedPass(retentionDays: number): ChangeLogGcSummary {
  return {
    skipped: true,
    deleted: 0,
    batches: 0,
    cutoffCursor: null,
    prunedThrough: 0,
    durationMs: 0,
    remaining: 0,
    retentionDays,
  };
}

/** One pass. Exported for tests + callable from setInterval. */
// fallow-ignore-next-line complexity
export async function runChangeLogGcOnce(
  opts: ChangeLogGcOptions = {},
): Promise<ChangeLogGcSummary> {
  const startedAt = Date.now();
  // A config read that FAILS is not a config that says "defaults". The operator
  // may have set a 365-day window, or switched the job off entirely; running a
  // destructive sweep on the 30-day default because a `findOne` timed out
  // during a replica-set election would delete eleven months of journal they
  // explicitly asked to keep, and no amount of re-reading the setting
  // afterwards brings it back. Skip the pass and try again on the next tick.
  const config = await loadChangeLogGcConfig(opts.dbOverride).catch((err: unknown) => {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'could not read change-log-gc config; skipping this pass rather than pruning on defaults',
    );
    return null;
  });
  if (!config) return skippedPass(opts.retentionDays ?? 0);
  const retentionDays = opts.retentionDays ?? config.retention_days;
  if (!config.enabled) return skippedPass(retentionDays);

  const cutoffDate = new Date(startedAt - retentionDays * DAY_MS);
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? BATCH_SIZE));
  const pauseMs = opts.pauseMs ?? BATCH_PAUSE_MS;

  const coll = opts.dbOverride
    ? opts.dbOverride.collection<AssetChangeDoc>('asset_changes')
    : await assetChangesCollection();

  const cutoffCursor = await findRetentionCutoffCursor(coll, cutoffDate);

  if (cutoffCursor === null) {
    const remaining = await coll.estimatedDocumentCount().catch(() => 0);
    const durationMs = Date.now() - startedAt;
    await recordChangeLogGcRun(
      {
        deleted: 0,
        batches: 0,
        duration_ms: durationMs,
        pruned_through: 0,
        remaining,
        finished_at: new Date().toISOString(),
      },
      opts.dbOverride,
    );
    return {
      skipped: false,
      deleted: 0,
      batches: 0,
      cutoffCursor: null,
      prunedThrough: 0,
      durationMs,
      remaining,
      retentionDays,
    };
  }

  // Raise the retention floor BEFORE the first delete, never after.
  //
  // The floor is what `isChangeCursorTooOld` answers from, and the ordering is
  // the whole reason the poll route can't hand a client a page with a hole in
  // it: by the time any row in `cursor <= cutoffCursor` starts disappearing,
  // every client anchored inside that range is already being told its anchor
  // expired. Raising it afterwards would leave exactly the window this sweep
  // spends deleting — hours, on the first pass over a production backlog —
  // during which a poll can be served rows from the far side of a fresh hole.
  //
  // Last chance to stand down: a `stop()` that landed while the config read and
  // the cutoff search were in flight should leave no trace at all, and this is
  // the pass's first write. `shouldStop` is polled here, then once per batch.
  if (opts.shouldStop?.()) return skippedPass(retentionDays);
  await raiseChangeLogPruneFloor(opts.dbOverride, cutoffCursor);

  let deleted = 0;
  let batches = 0;
  let prunedThrough = 0;
  let error: string | undefined;

  try {
    while (batches < MAX_BATCHES_PER_PASS) {
      if (opts.shouldStop?.()) break;

      const docs = await coll
        .find({ cursor: { $lte: cutoffCursor } }, { projection: { _id: 1, cursor: 1 } })
        .sort({ cursor: 1 })
        .limit(batchSize)
        .toArray();

      if (docs.length === 0) break;

      const minCursor = docs[0]!.cursor;
      const maxCursor = docs[docs.length - 1]!.cursor;

      const res = await coll.deleteMany({
        cursor: { $gte: minCursor, $lte: maxCursor },
      });

      if (res.deletedCount === 0) break; // no progress — bail rather than spin

      deleted += res.deletedCount;
      batches++;
      if (maxCursor > prunedThrough) {
        prunedThrough = maxCursor;
      }

      if (docs.length < batchSize) break;

      // Yield to the event loop so ongoing HTTP / websocket traffic is never starved
      await delay(pauseMs);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error({ err: error, deleted, batches }, 'change-log-gc pass failed mid-sweep');
  }

  const remaining = await coll.estimatedDocumentCount().catch(() => 0);
  const durationMs = Date.now() - startedAt;

  await recordChangeLogGcRun(
    {
      deleted,
      batches,
      duration_ms: durationMs,
      pruned_through: prunedThrough,
      remaining,
      finished_at: new Date().toISOString(),
      ...(error ? { error } : {}),
    },
    opts.dbOverride,
  );

  if (deleted > 0 || error) {
    log.info(
      { deleted, batches, cutoffCursor, prunedThrough, remaining, retentionDays, durationMs },
      'change-log-gc pass complete',
    );
  }

  return {
    skipped: false,
    deleted,
    batches,
    cutoffCursor,
    prunedThrough,
    durationMs,
    remaining,
    retentionDays,
  };
}

export interface ChangeLogGcHandle {
  stop: () => void;
}

/** Start the background loop. Returns a handle whose `stop()` cancels it —
 * including mid-sweep, via the cooperative `shouldStop` check. */
export function startChangeLogGc(
  opts: ChangeLogGcOptions & { intervalMs?: number } = {},
): ChangeLogGcHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    // A backlog sweep can outlive the interval. Single-flight so two passes
    // never race each other over the same rows.
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await runChangeLogGcOnce({ ...opts, shouldStop: () => stopped });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'change-log-gc pass crashed');
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  // Fire once on startup so a freshly-booted server doesn't wait 24h for its
  // first sweep. Errors are swallowed by tick() so a stray failure can't crash
  // boot.
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
