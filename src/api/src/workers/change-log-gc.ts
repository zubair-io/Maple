/**
 * Change-log garbage collector — prunes `asset_changes` rows older than the
 * retention window (#3741).
 *
 * The change feed is an append-only journal with no expiry, so it grows
 * linearly in library size AND time: measured at 176M rows / 42 GB of data and
 * 8.3 GB of index on a 335k-asset library, 524 rows per asset and 99.6% of
 * every document in the database.
 *
 * Why dropping rows is safe: `db/changes.repo.ts` already treats the journal as
 * gap-tolerant. Cursor allocation and row insert are separate operations, an
 * insert can fail after its cursor was handed out, and every consumer is built
 * to cope. A client that falls behind the window lands in the same
 * cursor-too-old 409 path and re-enumerates — the designed fallback, not a
 * regression. The sweep records how far it pruned (`recordPrunedThrough`) so
 * the feed can answer that 409 positively rather than returning a short list.
 *
 * Two invariants:
 *   - The allocator row (`server_state._id = "asset_changes_cursor"`) is never
 *     written here. Pruning removes history; it never rewinds the sequence.
 *   - Deletes are batched with a pause between batches. The API and the whole
 *     worker tier share one event loop, and a single unbounded `deleteMany` over
 *     a 176M-row backlog would hold it.
 *
 * NOT a stage controller — this is library-wide, interval-fired work, started
 * from `maintenance.ts` alongside trash-gc, which it is modelled on.
 *
 * Operator note: WiredTiger does not return freed space to the filesystem on
 * delete alone. Reclaiming the on-disk bytes after the first large sweep needs
 * a `compact`, run by hand.
 */

import { ObjectId } from 'mongodb';
import { assetChangesCollection } from '../db/client.ts';
import { recordPrunedThrough } from '../db/changes.repo.ts';
import { loadChangeLogGcConfig, recordChangeLogGcRun } from './change-log-gc-config.repo.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('change-log-gc');
const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = DAY_MS;

/** Rows removed per delete batch. Large enough that the 176M-row first sweep
 * is tens of thousands of round trips rather than millions, small enough that
 * one delete is a few tens of milliseconds of write lock. */
const BATCH_SIZE = 5_000;
/** Pause between batches. Gives the shared event loop a turn — HTTP handlers
 * and stage work run in the same process. */
const BATCH_PAUSE_MS = 25;
/** Runaway guard. At BATCH_SIZE this caps one pass at 100M rows; a pass that
 * hits it simply resumes on the next interval. */
const MAX_BATCHES_PER_PASS = 20_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ChangeLogGcOptions {
  /** Rows per delete batch. Defaults to `BATCH_SIZE`; tests lower it to
   * exercise the multi-batch path. */
  batchSize?: number;
  /** Pause between batches. Defaults to `BATCH_PAUSE_MS`. */
  pauseMs?: number;
  /** Cooperative cancellation, checked before every batch, so shutdown does
   * not have to wait out a long backlog sweep. */
  shouldStop?: () => boolean;
}

export interface ChangeLogGcSummary {
  /** True when the job is disabled in `worker_config` — nothing was read or
   * written. */
  skipped: boolean;
  deleted: number;
  batches: number;
  durationMs: number;
  /** Highest `cursor` this pass removed; 0 when it removed nothing. */
  prunedThrough: number;
  /** Rows left afterwards. Collection metadata, not a scan. */
  remaining: number;
  /** The window actually applied, as read from `worker_config`. */
  retentionDays: number;
}

/**
 * One pass. Exported for tests + callable from the interval loop.
 *
 * The retention window is read from `worker_config` on every pass, so an
 * operator edit on Settings → Workers takes effect on the next sweep with no
 * restart. There is deliberately no option to override it — config is the only
 * source.
 */
export async function runChangeLogGcOnce(
  opts: ChangeLogGcOptions = {},
): Promise<ChangeLogGcSummary> {
  const config = await loadChangeLogGcConfig();
  const retentionDays = config.retention_days;
  if (!config.enabled) {
    return {
      skipped: true,
      deleted: 0,
      batches: 0,
      durationMs: 0,
      prunedThrough: 0,
      remaining: 0,
      retentionDays,
    };
  }

  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? BATCH_SIZE));
  const pauseMs = opts.pauseMs ?? BATCH_PAUSE_MS;
  const startedAt = Date.now();
  const coll = await assetChangesCollection();

  // An ObjectId's leading four bytes are the insert time in whole seconds, so
  // an id synthesised from the cutoff is an exact boundary on the `_id` index —
  // which every collection has. `at` carries the same instant (it is stamped
  // microseconds earlier, in the same function that inserts the row) but has no
  // index, and a predicate on it would collection-scan 176M documents.
  const cutoffSeconds = Math.floor((startedAt - retentionDays * DAY_MS) / 1000);
  const boundary = ObjectId.createFromTime(cutoffSeconds);

  let deleted = 0;
  let batches = 0;
  let prunedThrough = 0;
  let error: string | undefined;

  try {
    while (batches < MAX_BATCHES_PER_PASS) {
      if (opts.shouldStop?.()) break;
      // Ascending by `_id` so the page is always the oldest surviving rows,
      // which lets the delete below be a contiguous range rather than a
      // 5,000-element `$in`.
      const page = await coll
        .find({ _id: { $lt: boundary } }, { projection: { _id: 1, cursor: 1 } })
        .sort({ _id: 1 })
        .limit(batchSize)
        .toArray();
      if (page.length === 0) break;

      const highWater = page[page.length - 1]!;
      // Everything at or below the page's last `_id` is also below `boundary`,
      // because we scanned from the smallest id upwards. Concurrent inserts
      // always land above it, so this can never take a row the window still
      // covers.
      const res = await coll.deleteMany({ _id: { $lte: highWater._id } });
      if (res.deletedCount === 0) break; // no progress — bail rather than spin

      deleted += res.deletedCount;
      batches++;
      for (const row of page) {
        if (typeof row.cursor === 'number' && row.cursor > prunedThrough)
          prunedThrough = row.cursor;
      }
      await delay(pauseMs);
    }

    // Raise the retention floor so `GET /api/changes` can answer 409 to a
    // client whose cursor predates what we removed, instead of handing it a
    // silently-short list. Monotonic: `$max`, never a rewind.
    if (prunedThrough > 0) await recordPrunedThrough(prunedThrough);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error({ err: error, deleted, batches }, 'change-log-gc pass failed mid-sweep');
  }

  const remaining = await coll.estimatedDocumentCount().catch(() => 0);
  const durationMs = Date.now() - startedAt;
  await recordChangeLogGcRun({
    deleted,
    batches,
    duration_ms: durationMs,
    pruned_through: prunedThrough,
    remaining,
    finished_at: new Date().toISOString(),
    ...(error ? { error } : {}),
  });
  if (deleted > 0 || error) {
    log.info(
      { deleted, batches, durationMs, prunedThrough, remaining, retentionDays },
      'change-log-gc pass complete',
    );
  }

  return { skipped: false, deleted, batches, durationMs, prunedThrough, remaining, retentionDays };
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
