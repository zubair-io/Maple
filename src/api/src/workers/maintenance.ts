/**
 * Background maintenance jobs — library-wide, interval-fired work that is NOT
 * part of the per-asset stage pipeline. Grouped here so `index.ts` wires the
 * whole set with one start + one stop call.
 *
 * Members:
 *   - trash-gc       — purge trashed assets (`deleted_at`) past the retention
 *                      window: unlink the file + sidecars, delete the row.
 *   - missing-reaper — hard-delete rows whose on-disk original vanished
 *                      (`missing_since`). Always starts PAUSED; operator-gated
 *                      via /api/workers/missing-reaper/{pause,resume}.
 *   - migration      — runs registered one-shot library migrations. Runs by
 *                      default but idles until an operator enables a specific
 *                      migration via /settings/workers (each migration has its
 *                      own toggle; the worker-level pause is the standard one).
 *   - deduplicate    — collapses assets with >1 live on-disk location, moving
 *                      the surplus copies into `_duplicates/`. Starts PAUSED;
 *                      operator-gated via /api/workers/deduplicate/{pause,resume}.
 *
 * Both start as part of the worker tier (via `start-workers.ts`) and are
 * therefore gated by MAPLE_INDEXER_AUTOSTART. Each job is still individually
 * gated: trash-gc honours its retention window, and the reaper boots paused so
 * it does nothing until an operator resumes it.
 */

import { startTrashGc, type TrashGcHandle } from './trash-gc.ts';
import { startMissingReaper, type MissingReaperHandle } from './missing-reaper.ts';
import { startMigration, type MigrationHandle } from './migration.ts';
import { startDeDuplicate, type DeDuplicateHandle } from './dedupe.ts';
import { startMirrorScan, type MirrorScanHandle } from './mirror/scan.ts';
import { startMirrorCopyWorker, type MirrorCopyHandle } from './mirror/copy.ts';
import { installMirrorQueueSink } from './mirror/sink.ts';
import { startDerivativeAudit, type DerivativeAuditHandle } from './derivative-audit/scan.ts';
import { loadMirrorConfig } from '../fs/mirror-config.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('maintenance');

/** How often the worker re-reads the library→mirror config from Mongo, so a
 * mirror enabled/disabled/repointed via the API (a different process) takes
 * effect here without a worker restart — the API process reloads its own
 * registry inline on the PUT, this keeps the worker's in sync. */
const MIRROR_CONFIG_RELOAD_MS = 60_000;

let trashGc: TrashGcHandle | null = null;
let missingReaper: MissingReaperHandle | null = null;
let migration: MigrationHandle | null = null;
let deduplicate: DeDuplicateHandle | null = null;
let mirrorScan: MirrorScanHandle | null = null;
let mirrorCopy: MirrorCopyHandle | null = null;
let mirrorConfigReload: ReturnType<typeof setInterval> | null = null;
let derivativeAudit: DerivativeAuditHandle | null = null;

/** Start every maintenance job. Idempotent — a second call is a no-op while a
 * prior set is still running. */
export function startMaintenanceJobs(): void {
  if (!trashGc) trashGc = startTrashGc({});
  if (!missingReaper) missingReaper = startMissingReaper();
  if (!migration) migration = startMigration();
  if (!deduplicate) deduplicate = startDeDuplicate({});
  // Mirror reconcile: detector (scan → enqueue) + copy worker (drain queue).
  // Both no-op cheaply when no library has a mirror configured. The sink
  // routes inline replication failures (this process's mirrored writes — e.g.
  // migration relocations) into the same queue.
  installMirrorQueueSink();
  if (!mirrorScan) mirrorScan = startMirrorScan({});
  if (!mirrorCopy) mirrorCopy = startMirrorCopyWorker({});
  // Derivative-audit: verify each asset's thumb/preview/description on disk and
  // its thumbnail in R2; re-arm the owning stage when a derivative has drifted
  // (most often after a move left the .maple cache behind). Self-gates on its
  // own `enabled` config each tick.
  if (!derivativeAudit) derivativeAudit = startDerivativeAudit();
  // Periodically re-read mirror config so a change made via the API process
  // (PUT /api/folders/:id/mirror) propagates to this worker without a restart.
  // worker-main does the initial load; this only catches later changes + retries
  // a failed initial load.
  if (!mirrorConfigReload) {
    mirrorConfigReload = setInterval(() => {
      void loadMirrorConfig().catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          'periodic mirror config reload failed — keeping previous registry',
        );
      });
    }, MIRROR_CONFIG_RELOAD_MS);
    mirrorConfigReload.unref?.();
  }
}

/** Stop every maintenance job (cancels timers, unregisters the workers). Safe to
 * call when nothing is running. */
export function stopMaintenanceJobs(): void {
  trashGc?.stop();
  trashGc = null;
  missingReaper?.stop();
  missingReaper = null;
  migration?.stop();
  migration = null;
  deduplicate?.stop();
  deduplicate = null;
  mirrorScan?.stop();
  mirrorScan = null;
  mirrorCopy?.stop();
  mirrorCopy = null;
  derivativeAudit?.stop();
  derivativeAudit = null;
  if (mirrorConfigReload) {
    clearInterval(mirrorConfigReload);
    mirrorConfigReload = null;
  }
}
