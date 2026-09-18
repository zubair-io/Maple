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
 */

import type { Collection, Db } from 'mongodb';
import { assetChangesCollection } from '../db/client.ts';
import type { AssetChangeDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import { loadChangeLogRetentionDays } from './change-log-gc-config.repo.ts';

const log = childLogger('change-log-gc');
const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_MS = DAY_MS;
export const DEFAULT_CHANGE_LOG_GC_BATCH_SIZE = 1000;
export const BATCH_YIELD_MS = 10;

export interface ChangeLogGcOptions {
  retentionDays?: number;
  batchSize?: number;
  dbOverride?: Db;
}

export interface ChangeLogGcSummary {
  scanned: number;
  deleted: number;
  batches: number;
  cutoffCursor: number | null;
  durationMs: number;
}

/**
 * Finds the highest cursor where `at < cutoffDate` using indexed binary search over
 * `{ cursor: 1 }`. Since cursors are monotonically allocated over time, point lookups
 * on `cursor` find the boundary in O(log N) operations without scanning the collection
 * or requiring an index on `at`.
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

  if (!lowestDoc || lowestDoc.at >= cutoffDate) {
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

  if (highestDoc.at < cutoffDate) {
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

    if (doc.at < cutoffDate) {
      best = Math.max(best, doc.cursor);
      low = doc.cursor + 1;
    } else {
      high = doc.cursor - 1;
    }
  }

  return best;
}

/** One pass. Exported for tests + callable from setInterval or API run-now route. */
export async function runChangeLogGcOnce(
  opts: ChangeLogGcOptions = {},
): Promise<ChangeLogGcSummary> {
  const start = Date.now();
  const retentionDays = opts.retentionDays ?? (await loadChangeLogRetentionDays());
  const cutoffDate = new Date(Date.now() - retentionDays * DAY_MS);
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_CHANGE_LOG_GC_BATCH_SIZE);

  const coll = opts.dbOverride
    ? opts.dbOverride.collection<AssetChangeDoc>('asset_changes')
    : await assetChangesCollection();

  const cutoffCursor = await findRetentionCutoffCursor(coll, cutoffDate);

  if (cutoffCursor === null) {
    return {
      scanned: 0,
      deleted: 0,
      batches: 0,
      cutoffCursor: null,
      durationMs: Date.now() - start,
    };
  }

  let deleted = 0;
  let batches = 0;

  while (true) {
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

    deleted += res.deletedCount;
    batches++;

    if (docs.length < batchSize) break;

    // Yield to the event loop so ongoing HTTP / websocket traffic is never stalled
    await new Promise((resolve) => setTimeout(resolve, BATCH_YIELD_MS));
  }

  const durationMs = Date.now() - start;
  if (deleted > 0) {
    log.info(
      { deleted, batches, cutoffCursor, retentionDays, durationMs },
      'change-log-gc pass complete',
    );
  }

  return {
    scanned: deleted,
    deleted,
    batches,
    cutoffCursor,
    durationMs,
  };
}

export interface ChangeLogGcHandle {
  stop: () => void;
}

/** Start a background loop. Returns a handle whose `stop()` cancels it. */
export function startChangeLogGc(
  opts: ChangeLogGcOptions & { intervalMs?: number } = {},
): ChangeLogGcHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await runChangeLogGcOnce(opts);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'change-log-gc pass crashed');
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

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
