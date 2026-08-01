/**
 * Mirror-scan detector — the "check, don't copy" half of the detect/copy split.
 *
 * Iterates live assets (the DB already knows every on-disk file + its
 * locations), resolves each live location's mirror target(s), and enqueues a
 * `mirror_queue` row for any that are missing or stale on the mirror. It never
 * copies — the mirror copy worker drains the queue. Decoupled from the discover
 * sweep so it can't slow indexing, and independently throttled.
 *
 * Mount guard: a mirror root whose directory isn't present this pass is treated
 * as offline and SKIPPED — an unmounted backup disk must not enqueue every file
 * as "missing" and flood the queue.
 */

import * as path from 'node:path';
import { assetsCollection } from '../../db/client.ts';
import { liveFileInfoElemMatch } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { resolveMirrorTargets, isMirroringActive } from '../../fs/mirror-registry.ts';
import { enqueueMirrorCopy } from '../../fs/mirror-queue.repo.ts';
import { xmpSidecarPath, resolveThumbPath, cachePathFor } from '../../fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { needsReplication, statOrNull } from './replicate.ts';
import { child as childLogger } from '../../log.ts';

const log = childLogger('mirror-scan');

const DEFAULT_INTERVAL_MS = 3_600_000; // hourly
const DEFAULT_MAX_ENQUEUE = 10_000; // safety cap per pass

export interface MirrorScanOptions {
  /** Stop enqueueing after this many rows in one pass (runaway guard). */
  maxEnqueue?: number;
  /** Optional live-progress hook, fired once per primary file checked. Powers the
   * operator "Scan now" readout so you can see the walk is actually touching the
   * filesystem. Must be cheap + synchronous (an in-memory snapshot) — no I/O. */
  onProgress?: (snapshot: {
    scanned: number;
    enqueued: number;
    upToDate: number;
    currentPath: string;
  }) => void;
}

export interface MirrorScanSummary {
  scanned: number;
  enqueued: number;
  upToDate: number;
  skippedOffline: number;
  errors: number;
}

/** One detection pass. Exported for tests + driven by the interval loop. */
export async function runMirrorScanOnce(opts: MirrorScanOptions = {}): Promise<MirrorScanSummary> {
  const maxEnqueue = opts.maxEnqueue ?? DEFAULT_MAX_ENQUEUE;
  const summary: MirrorScanSummary = {
    scanned: 0,
    enqueued: 0,
    upToDate: 0,
    skippedOffline: 0,
    errors: 0,
  };
  if (!isMirroringActive()) return summary;

  const libs = await loadLibraryRoots();
  const coll = await assetsCollection();
  // Per-pass mirror-root reachability cache so we stat each root once, not once
  // per file. Offline roots are skipped to avoid flooding on an unmounted disk.
  const rootOnline = new Map<string, boolean>();
  const isRootOnline = async (root: string): Promise<boolean> => {
    const cached = rootOnline.get(root);
    if (cached !== undefined) return cached;
    const online = (await statOrNull(root)) !== null;
    rootOnline.set(root, online);
    return online;
  };

  // Check one primary file against its mirror target(s); enqueue any that are
  // missing/stale. Returns 'cap' once the per-pass enqueue ceiling is hit so
  // the caller can stop the whole pass. A primary that doesn't exist (or has no
  // mirror target) is a no-op.
  const checkOne = async (primaryAbs: string): Promise<'cap' | 'ok'> => {
    const targets = resolveMirrorTargets(primaryAbs);
    if (targets.length === 0) return 'ok';
    const primaryStat = await statOrNull(primaryAbs);
    if (primaryStat === null) return 'ok'; // primary gone (or sidecar absent)
    summary.scanned++;
    for (const t of targets) {
      if (!(await isRootOnline(t.mirrorRoot))) {
        summary.skippedOffline++;
        continue;
      }
      if (needsReplication(primaryStat, await statOrNull(t.mirrorPath))) {
        if (summary.enqueued >= maxEnqueue) return 'cap';
        await enqueueMirrorCopy(primaryAbs, t.mirrorPath, 'scan-missing');
        summary.enqueued++;
      } else {
        summary.upToDate++;
      }
    }
    return 'ok';
  };

  // `liveFileInfoElemMatch()` already returns the full
  // `{ fileinfo: { $elemMatch: … } }` fragment — use it as the query directly,
  // don't wrap it again.
  const cursor = coll.find(liveFileInfoElemMatch(), { projection: { fileinfo: 1 } });

  for await (const doc of cursor) {
    for (const entry of doc.fileinfo ?? []) {
      // Live entry only: holds this asset's content at a present path.
      if (entry.deleted_at != null || entry.missing_since != null) continue;
      const root = libs.get(entry.library_id.toHexString());
      if (!root) continue;
      const segments = entry.path === '' ? [] : entry.path.split('/');
      const primaryAbs = path.join(root, ...segments, entry.filename);

      // Everything this asset owns on disk, in priority order. `checkOne`
      // no-ops on any of these that the primary doesn't have.
      const replicable = [
        primaryAbs,
        // The canonical XMP sidecar carries the user's edits (the
        // non-destructive contract), so it must back up too.
        xmpSidecarPath(primaryAbs),
        // The derived `.maple/` cache. Fresh renders reach the mirror inline via
        // `fs/mirrored.ts:replicatePath`; this is what carries the pre-existing
        // backlog — and anything a dropped inline copy missed — across, so a
        // mirror-served read hits the cache instead of regenerating (#926).
        resolveThumbPath(primaryAbs),
        cachePathFor(primaryAbs, 'previews', PREVIEW_CACHE_SUFFIX),
      ];

      try {
        for (const candidate of replicable) {
          if ((await checkOne(candidate)) === 'cap') {
            log.warn({ maxEnqueue }, 'mirror-scan hit per-pass enqueue cap — deferring rest');
            return summary;
          }
        }
      } catch (err) {
        summary.errors++;
        log.warn({ primaryAbs, err: err instanceof Error ? err.message : err }, 'scan row failed');
      }

      // Surface live progress (the file just checked + running counts) so the
      // "Scan now" UI can show the walk in motion.
      opts.onProgress?.({
        scanned: summary.scanned,
        enqueued: summary.enqueued,
        upToDate: summary.upToDate,
        currentPath: primaryAbs,
      });
    }
  }

  if (summary.scanned > 0) log.info(summary, 'mirror-scan pass complete');
  return summary;
}

export interface MirrorScanHandle {
  stop: () => void;
}

/** Start the detection loop. Fires once on boot, then on the interval. */
export function startMirrorScan(
  opts: MirrorScanOptions & { intervalMs?: number } = {},
): MirrorScanHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight || !isMirroringActive()) return;
    inFlight = true;
    try {
      await runMirrorScanOnce(opts);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'mirror-scan pass crashed');
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
