/**
 * Operator "Scan now" runner for the mirror reconcile, plus the live progress it
 * exposes on `GET /api/mirror/status`.
 *
 * The background mirror-scan runs in the worker process on its hourly timer; that
 * is great for steady-state but useless when an operator wants to *see* a scan
 * happening right now (e.g. "is it even walking the filesystem?"). This runs a
 * single pass in the API process — which already has the mirror registry loaded —
 * tracking a live, in-memory snapshot (current file, files checked, copies
 * queued) that the status route returns. It enqueues into the same `mirror_queue`
 * the worker's copy worker drains, so triggering it here and copying there is
 * consistent.
 *
 * Detached + guarded: `startMirrorScanNow()` kicks the pass and returns
 * immediately (the walk can take a while on a big library); a second call while
 * one is in flight is a no-op. Poll `getMirrorScanProgress()` for updates.
 */

import { runMirrorScanOnce } from '../workers/mirror/scan.ts';
import { isMirroringActive } from '../fs/mirror-registry.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('mirror:scan-now');

export interface MirrorScanProgress {
  phase: 'idle' | 'scanning';
  /** Files checked so far this pass. */
  scanned: number;
  /** Mirror copies queued so far this pass. */
  enqueued: number;
  /** Files already up to date on the mirror this pass. */
  upToDate: number;
  /** The primary file currently being checked (the "it's walking" signal). */
  currentPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

function idle(): MirrorScanProgress {
  return {
    phase: 'idle',
    scanned: 0,
    enqueued: 0,
    upToDate: 0,
    currentPath: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

let progress: MirrorScanProgress = idle();
let inFlight = false;

/** Current snapshot (a copy, so callers can't mutate the live object). */
export function getMirrorScanProgress(): MirrorScanProgress {
  return { ...progress };
}

export interface ScanNowResult {
  started: boolean;
  phase: MirrorScanProgress['phase'];
  /** Set when `started` is false because mirroring isn't configured. */
  reason?: string;
}

/**
 * Kick a scan pass in this process, tracking live progress. Returns immediately;
 * poll `getMirrorScanProgress()` for updates. A no-op (started: false) when a
 * pass is already running or no mirror is configured.
 */
export function startMirrorScanNow(): ScanNowResult {
  if (inFlight) return { started: false, phase: progress.phase };
  if (!isMirroringActive()) {
    return { started: false, phase: 'idle', reason: 'no mirror configured' };
  }

  inFlight = true;
  progress = { ...idle(), phase: 'scanning', startedAt: new Date().toISOString() };

  void (async () => {
    try {
      const summary = await runMirrorScanOnce({
        onProgress: (s) => {
          progress.scanned = s.scanned;
          progress.enqueued = s.enqueued;
          progress.upToDate = s.upToDate;
          progress.currentPath = s.currentPath;
        },
      });
      progress.scanned = summary.scanned;
      progress.enqueued = summary.enqueued;
      progress.upToDate = summary.upToDate;
      log.info(summary, 'manual mirror scan complete');
    } catch (err) {
      progress.error = err instanceof Error ? err.message : String(err);
      log.error({ err: progress.error }, 'manual mirror scan failed');
    } finally {
      progress.phase = 'idle';
      progress.currentPath = null;
      progress.finishedAt = new Date().toISOString();
      inFlight = false;
    }
  })();

  return { started: true, phase: 'scanning' };
}
