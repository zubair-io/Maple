/**
 * Mirror copy worker — drains `mirror_queue`. Claims a pending copy, replicates
 * the primary file onto the mirror (atomic + mtime-faithful), and
 * completes/retries. The I/O-heavy half of the detect/copy split: detectors
 * (mirror-scan + the inline `onMirrorFailure` sink) only enqueue; this worker
 * does the copying, on its own interval and throttle, so a slow/network mirror
 * never blocks an edit or the indexer.
 *
 * Interval-fired like `trash-gc` (not a version-claim stage). Started from
 * `maintenance.ts` and gated on mirroring being configured.
 */

import { child as childLogger } from '../../log.ts';
import { isMirroringActive } from '../../fs/mirror-registry.ts';
import {
  claimNextMirrorCopy,
  completeMirrorCopy,
  failMirrorCopy,
} from '../../fs/mirror-queue.repo.ts';
import { copyFileToMirror, needsReplication, statOrNull } from './replicate.ts';

const log = childLogger('mirror-copy');

const DEFAULT_INTERVAL_MS = 30_000;
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
}

export interface MirrorCopySummary {
  claimed: number;
  copied: number;
  skipped: number;
  failed: number;
}

/** One drain pass. Exported for tests + driven by the interval loop. */
export async function runMirrorCopyOnce(opts: MirrorCopyOptions = {}): Promise<MirrorCopySummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const summary: MirrorCopySummary = { claimed: 0, copied: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < batchSize; i++) {
    const entry = await claimNextMirrorCopy(leaseMs);
    if (!entry) break;
    summary.claimed++;
    try {
      const primaryStat = await statOrNull(entry.primary_path);
      if (primaryStat === null || !primaryStat.isFile()) {
        // Primary vanished (or isn't a file) since enqueue — nothing to copy.
        // The missing-reaper owns deletions; just drop the stale task.
        await completeMirrorCopy(entry._id);
        summary.skipped++;
        continue;
      }
      // Idempotent: another pass (or an inline write) may have already brought
      // the mirror up to date between enqueue and claim.
      if (!needsReplication(primaryStat, await statOrNull(entry.mirror_path))) {
        await completeMirrorCopy(entry._id);
        summary.skipped++;
        continue;
      }
      await copyFileToMirror(entry.primary_path, entry.mirror_path);
      await completeMirrorCopy(entry._id);
      summary.copied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await failMirrorCopy(entry._id, msg, maxAttempts).catch(() => {});
      summary.failed++;
      log.warn({ mirror: entry.mirror_path, err: msg }, 'mirror copy failed — will retry');
    }
  }

  if (summary.claimed > 0) log.info(summary, 'mirror-copy pass complete');
  return summary;
}

export interface MirrorCopyHandle {
  stop: () => void;
}

/** Start the drain loop. No-op passes are cheap when the queue is empty or
 * mirroring is unconfigured, so the timer always runs once mirroring may be on. */
export function startMirrorCopyWorker(
  opts: MirrorCopyOptions & { intervalMs?: number } = {},
): MirrorCopyHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight || !isMirroringActive()) return;
    inFlight = true;
    try {
      await runMirrorCopyOnce(opts);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'mirror-copy pass crashed');
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
