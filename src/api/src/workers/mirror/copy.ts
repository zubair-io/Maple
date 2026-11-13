/**
 * Mirror copy worker — drains `mirror_queue`. Claims a pending copy, replicates
 * the primary file onto the mirror (atomic + mtime-faithful), and
 * completes/retries. The I/O-heavy half of the detect/copy split: detectors
 * (mirror-scan + the inline `onMirrorFailure` sink) only enqueue; this worker
 * does the copying, on its own interval and throttle, so a slow/network mirror
 * never blocks an edit or the indexer.
 *
 * Scheduled every 30 seconds as the `mirror-copy` maintenance task (not a
 * version-claim stage), paused while no library has a mirror configured.
 */

import { child as childLogger } from '../../log.ts';
import {
  claimNextMirrorCopy,
  completeMirrorCopy,
  failMirrorCopy,
} from '../../fs/mirror-queue.repo.ts';
import { copyFileToMirror, needsReplication, statOrNull } from './replicate.ts';

const log = childLogger('mirror-copy');

const DEFAULT_BATCH = 50;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export interface MirrorCopyOptions {
  /** Max rows to drain in one pass. */
  batchSize?: number;
  /** Claim lease — long enough to copy a large RAW over a network mirror. */
  leaseMs?: number;
  /** Dead-letter a row after this many failed attempts. */
  maxAttempts?: number;
  /** Stops the pass before claiming another row; unclaimed rows stay queued. */
  signal?: AbortSignal;
  /** Per-claimed-row progress hook: the source file being copied + running
   * counts. Used by the manual reconcile to surface the current file. */
  onProgress?: (snapshot: {
    claimed: number;
    copied: number;
    skipped: number;
    failed: number;
    currentPath: string;
  }) => void;
  /** Per-failure hook: source path + message, for an operator-visible error log. */
  onError?: (failure: { path: string; error: string }) => void;
  /** Per-success hook: the source path that was just copied to the mirror, for
   * an operator-visible "copied" log. */
  onCopied?: (path: string) => void;
}

export interface MirrorCopySummary {
  claimed: number;
  copied: number;
  skipped: number;
  failed: number;
}

type QueuedCopy = NonNullable<Awaited<ReturnType<typeof claimNextMirrorCopy>>>;

/** Copies one claimed row, or drops it when there is nothing to copy; a failure goes back to the queue. */
async function settleEntry(
  entry: QueuedCopy,
  summary: MirrorCopySummary,
  opts: MirrorCopyOptions,
  maxAttempts: number,
): Promise<void> {
  try {
    const primaryStat = await statOrNull(entry.primary_path);
    // Primary vanished (or isn't a file) since enqueue — nothing to copy. The
    // missing-reaper owns deletions; just drop the stale task. Idempotent:
    // another pass (or an inline write) may have already brought the mirror up
    // to date between enqueue and claim.
    if (
      primaryStat === null ||
      !primaryStat.isFile() ||
      !needsReplication(primaryStat, await statOrNull(entry.mirror_path))
    ) {
      await completeMirrorCopy(entry._id);
      summary.skipped++;
      return;
    }
    await copyFileToMirror(entry.primary_path, entry.mirror_path);
    await completeMirrorCopy(entry._id);
    summary.copied++;
    opts.onCopied?.(entry.primary_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failMirrorCopy(entry._id, msg, maxAttempts).catch(() => {});
    summary.failed++;
    opts.onError?.({ path: entry.primary_path, error: msg });
    log.warn({ mirror: entry.mirror_path, err: msg }, 'mirror copy failed — will retry');
  }
}

/** One drain pass, scheduled as the `mirror-copy` maintenance task and run by the manual reconcile. */
export async function runMirrorCopyOnce(opts: MirrorCopyOptions = {}): Promise<MirrorCopySummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const summary: MirrorCopySummary = { claimed: 0, copied: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < batchSize && !opts.signal?.aborted; i++) {
    const entry = await claimNextMirrorCopy(leaseMs);
    if (!entry) break;
    summary.claimed++;
    // Surface the file we're about to act on (the "current file" readout).
    opts.onProgress?.({
      claimed: summary.claimed,
      copied: summary.copied,
      skipped: summary.skipped,
      failed: summary.failed,
      currentPath: entry.primary_path,
    });
    await settleEntry(entry, summary, opts, maxAttempts);
  }

  if (summary.claimed > 0) log.info(summary, 'mirror-copy pass complete');
  return summary;
}

/** Ends a little inside the 30-second schedule, so the next run is not skipped as an overlap. */
const DRAIN_BUDGET_MS = 25_000;

/**
 * One scheduled run: batch after batch until the queue is empty, the time
 * budget is spent, or the run is stopped — one run per backlog rather than one
 * per batch. A batch with a failure ends the run: a failed row goes straight
 * back to the head of the queue, so an unreachable mirror would otherwise
 * spend every row's attempts within one run.
 */
export async function drainMirrorCopyQueue(
  signal?: AbortSignal,
  budgetMs = DRAIN_BUDGET_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { claimed, failed } = await runMirrorCopyOnce({ signal });
    if (claimed < DEFAULT_BATCH || failed > 0 || signal?.aborted || Date.now() >= deadline) return;
  }
}
