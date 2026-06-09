/**
 * Operator "Reconcile now" runner — runs a full mirror reconcile (scan → copy) in
 * the API process so the whole operation is observable live: which stage is on
 * (scanning vs copying), the per-stage counts, the current file, and an error
 * log. Progress is exposed on `GET /api/mirror/status`.
 *
 * Why here, not the worker: the background worker does the same two steps
 * continuously (hourly scan + a 30s copy drain), but its progress isn't surfaced.
 * For a discrete, operator-triggered reconcile we run both steps here — the API
 * process already has the mirror registry loaded — and stream progress. Copy I/O
 * is async (libuv threadpool), so it doesn't block the HTTP event loop; the run
 * is bounded and guarded against concurrent presses. The background worker keeps
 * running for automatic reconcile; both drain the same lease-guarded
 * `mirror_queue`, so no file is ever copied twice.
 *
 * Observability:
 *   - Stage transitions + per-stage results are logged informationally
 *     (scanning started → scan complete {results} → copying started {expected} →
 *     copy complete {results} → done).
 *   - Per-file copy failures go to the logger AND a capped in-memory error log
 *     surfaced in the UI.
 */

import { runMirrorScanOnce } from '../workers/mirror/scan.ts';
import { runMirrorCopyOnce } from '../workers/mirror/copy.ts';
import { mirrorQueueCounts } from '../fs/mirror-queue.repo.ts';
import { isMirroringActive } from '../fs/mirror-registry.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('mirror:reconcile');

const ERROR_LOG_CAP = 50;
const COPY_BATCH = 50;
const MAX_COPY_PASSES = 100_000; // safety net against an unbounded drain loop

export interface MirrorReconcileError {
  path: string;
  error: string;
  at: string;
}

export interface MirrorReconcileProgress {
  /** Which stage is active. */
  phase: 'idle' | 'scanning' | 'copying';
  scan: {
    /** Files checked against the mirror. */
    scanned: number;
    /** Found missing/stale → queued to copy. */
    toCopy: number;
    /** Already current on the mirror. */
    upToDate: number;
    /** Stat errors while scanning (swallowed; never block). */
    errors: number;
  };
  copy: {
    /** Files queued to copy when the copy stage began. */
    total: number;
    /** Copied so far — derived from the live queue so it's consistent whether
     * this run or the background worker drained a given row. */
    copied: number;
    /** Still waiting to be copied. */
    remaining: number;
    /** Failed every retry (dead-lettered) during this run. */
    errors: number;
  };
  /** The file currently being scanned or copied (the "it's working" signal). */
  currentPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Recent per-file errors (most-recent-last, capped); also sent to the logger. */
  errorLog: MirrorReconcileError[];
}

function idle(): MirrorReconcileProgress {
  return {
    phase: 'idle',
    scan: { scanned: 0, toCopy: 0, upToDate: 0, errors: 0 },
    copy: { total: 0, copied: 0, remaining: 0, errors: 0 },
    currentPath: null,
    startedAt: null,
    finishedAt: null,
    errorLog: [],
  };
}

let progress: MirrorReconcileProgress = idle();
let inFlight = false;

/** A snapshot copy so callers (the status route) can't mutate the live object. */
export function getMirrorReconcileProgress(): MirrorReconcileProgress {
  return {
    ...progress,
    scan: { ...progress.scan },
    copy: { ...progress.copy },
    errorLog: progress.errorLog.slice(),
  };
}

export interface ReconcileResult {
  started: boolean;
  phase: MirrorReconcileProgress['phase'];
  /** Set when `started` is false (already running, or no mirror configured). */
  reason?: string;
}

function recordError(path: string, error: string): void {
  progress.errorLog.push({ path, error, at: new Date().toISOString() });
  if (progress.errorLog.length > ERROR_LOG_CAP) progress.errorLog.shift();
  log.error({ path, err: error }, 'reconcile: file error');
}

/**
 * Run a full reconcile (scan → copy) now, tracking live progress. Returns
 * immediately; poll `getMirrorReconcileProgress()` for updates. A no-op
 * (`started: false`) when one is already running or no mirror is configured.
 */
export function startMirrorReconcileNow(): ReconcileResult {
  if (inFlight) return { started: false, phase: progress.phase };
  if (!isMirroringActive())
    return { started: false, phase: 'idle', reason: 'no mirror configured' };

  inFlight = true;
  progress = { ...idle(), phase: 'scanning', startedAt: new Date().toISOString() };

  void (async () => {
    try {
      // ── Stage 1: scan (detect + enqueue) ──────────────────────────────────
      log.info('reconcile: scanning started');
      const scan = await runMirrorScanOnce({
        onProgress: (s) => {
          progress.scan.scanned = s.scanned;
          progress.scan.toCopy = s.enqueued;
          progress.scan.upToDate = s.upToDate;
          progress.currentPath = s.currentPath;
        },
      });
      progress.scan = {
        scanned: scan.scanned,
        toCopy: scan.enqueued,
        upToDate: scan.upToDate,
        errors: scan.errors,
      };
      log.info(
        {
          scanned: scan.scanned,
          toCopy: scan.enqueued,
          upToDate: scan.upToDate,
          errors: scan.errors,
        },
        'reconcile: scan complete',
      );

      // ── Stage 2: copy (drain the queue) ───────────────────────────────────
      progress.phase = 'copying';
      progress.currentPath = null;
      const atStart = await mirrorQueueCounts();
      const total = atStart.pending;
      const baselineDead = atStart.dead;
      progress.copy = { total, copied: 0, remaining: total, errors: 0 };
      log.info({ toCopy: total }, 'reconcile: copying started');

      for (let pass = 0; pass < MAX_COPY_PASSES; pass++) {
        const res = await runMirrorCopyOnce({
          batchSize: COPY_BATCH,
          onProgress: (s) => {
            progress.currentPath = s.currentPath;
          },
          onError: (e) => recordError(e.path, e.error),
        });
        // Derive counts from the live queue so they stay correct regardless of
        // whether this run or the background worker copied/failed a given row.
        const counts = await mirrorQueueCounts();
        const newDead = Math.max(0, counts.dead - baselineDead);
        progress.copy.remaining = counts.pending;
        progress.copy.errors = newDead;
        progress.copy.copied = Math.max(0, total - counts.pending - newDead);
        // Nothing left we can claim (all copied, dead, or leased by the
        // background worker) → our side of the drain is done.
        if (res.claimed === 0) break;
      }
      log.info(
        {
          copied: progress.copy.copied,
          remaining: progress.copy.remaining,
          errors: progress.copy.errors,
        },
        'reconcile: copy complete',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordError('(reconcile)', msg);
      log.error({ err: msg }, 'reconcile: run failed');
    } finally {
      progress.phase = 'idle';
      progress.currentPath = null;
      progress.finishedAt = new Date().toISOString();
      inFlight = false;
      log.info({ scan: progress.scan, copy: progress.copy }, 'reconcile: done');
    }
  })();

  return { started: true, phase: 'scanning' };
}
