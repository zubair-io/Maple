/**
 * Change log garbage collector — purges `asset_changes` rows older than the
 * retention window.
 *
 * Problem (#3741):
 * asset_changes has no retention policy and dominated the database (176M rows,
 * 83% of all index bytes on prod MongoDB).
 *
 * Why pruning is safe by design:
 * The cursor counter does not live in the journal. `asset_changes.cursor` is an
 * INTEGER PRIMARY KEY — a rowid alias — and the value is handed out by the
 * `asset_changes_cursor` row of `server_state`: the counter bump and the row
 * insert go in as one `BEGIN IMMEDIATE` batch, and that insert's
 * `lastInsertRowid` IS the cursor (`db/sqlite/repos/changes.repo.ts`). Emptying
 * the journal therefore leaves the counter standing, which is exactly what lets
 * a swept server still answer 409 instead of silently serving nothing:
 * `isChangeCursorTooOld` compares a client's saved cursor against the surviving
 * floor, and clients (File Provider extension, RemoteCatalog, ChangeFeedClient)
 * recover through that stale-cursor path by re-enumerating their working set. A
 * sweep that reset the counter would turn that 409 into a 200 over an empty
 * stream — the one outcome a client cannot detect.
 *
 * Invariants:
 * 1. Library-wide, interval-fired job in `maintenance.ts` (mirrors `trash-gc.ts`).
 * 2. Deletes in bounded batches, yielding between batches so HTTP handlers are never starved,
 *    and so the single SQLite writer is never held for longer than one batch.
 * 3. The retention window is a DB-backed setting with a control on Settings → Workers,
 *    defaulting to 30 days to match trash-gc.
 * 4. `server_state` cursor stays monotonic; pruning NEVER rewinds it.
 * 5. Cooperative cancellation, single-flight guard, and per-pass batch cap prevent
 *    event-loop starvation and runaway sweeps.
 *
 * This module decides *when* and *how much*; every statement it drives lives
 * beside the table in `db/sqlite/repos/changes.retention.ts`, including the
 * binary search that finds the cutoff cursor without an index on `at`.
 */

import {
  countChanges,
  findRetentionCutoffCursor,
  pruneChangesBatch,
} from '../db/sqlite/repos/changes.retention.ts';
import type { SqliteDb } from '../db/sqlite/repos/db-handle.ts';
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
  dbOverride?: SqliteDb;
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

/** One pass. Exported for tests + callable from setInterval. */
// fallow-ignore-next-line complexity
export async function runChangeLogGcOnce(
  opts: ChangeLogGcOptions = {},
): Promise<ChangeLogGcSummary> {
  const startedAt = Date.now();
  const config = await loadChangeLogGcConfig(opts.dbOverride);
  const retentionDays = opts.retentionDays ?? config.retention_days;
  if (!config.enabled) {
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

  const cutoffDate = new Date(startedAt - retentionDays * DAY_MS);
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? BATCH_SIZE));
  const pauseMs = opts.pauseMs ?? BATCH_PAUSE_MS;

  const cutoffCursor = await findRetentionCutoffCursor(cutoffDate, opts.dbOverride);

  if (cutoffCursor === null) {
    const remaining = await countChanges(opts.dbOverride).catch(() => 0);
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

  let deleted = 0;
  let batches = 0;
  let prunedThrough = 0;
  let error: string | undefined;

  try {
    while (batches < MAX_BATCHES_PER_PASS) {
      if (opts.shouldStop?.()) break;

      const batch = await pruneChangesBatch(cutoffCursor, batchSize, opts.dbOverride);

      if (batch.deleted === 0) break; // no progress — bail rather than spin

      deleted += batch.deleted;
      batches++;
      if (batch.prunedThrough > prunedThrough) {
        prunedThrough = batch.prunedThrough;
      }

      // A batch that came up short took everything still below the cutoff, so
      // the next one would be the empty round trip the guard above catches.
      if (batch.deleted < batchSize) break;

      // Yield to the event loop so ongoing HTTP / websocket traffic is never starved
      await delay(pauseMs);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error({ err: error, deleted, batches }, 'change-log-gc pass failed mid-sweep');
  }

  const remaining = await countChanges(opts.dbOverride).catch(() => 0);
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
