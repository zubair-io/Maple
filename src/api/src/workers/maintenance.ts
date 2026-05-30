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
 *
 * Both start UNCONDITIONALLY at boot — independent of MAPLE_INDEXER_AUTOSTART.
 * Trash finalisation and missing-file reaping are maintenance concerns that
 * must remain available (and, for the reaper, controllable) even when the
 * stage pipeline is paused, mirroring how trash-gc has always run. Each job is
 * still individually gated: trash-gc honours its retention window, and the
 * reaper boots paused so it does nothing until an operator resumes it.
 */

import { startTrashGc, type TrashGcHandle } from './trash-gc.ts';
import { startMissingReaper, type MissingReaperHandle } from './missing-reaper.ts';

let trashGc: TrashGcHandle | null = null;
let missingReaper: MissingReaperHandle | null = null;

/** Start every maintenance job. Idempotent — a second call is a no-op while a
 * prior set is still running. */
export function startMaintenanceJobs(): void {
  if (!trashGc) trashGc = startTrashGc({});
  if (!missingReaper) missingReaper = startMissingReaper();
}

/** Stop every maintenance job (cancels timers, unregisters the reaper). Safe to
 * call when nothing is running. */
export function stopMaintenanceJobs(): void {
  trashGc?.stop();
  trashGc = null;
  missingReaper?.stop();
  missingReaper = null;
}
