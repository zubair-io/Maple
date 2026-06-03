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
 *
 * Both start as part of the worker tier (via `start-workers.ts`) and are
 * therefore gated by MAPLE_INDEXER_AUTOSTART. Each job is still individually
 * gated: trash-gc honours its retention window, and the reaper boots paused so
 * it does nothing until an operator resumes it.
 */

import { startTrashGc, type TrashGcHandle } from './trash-gc.ts';
import { startMissingReaper, type MissingReaperHandle } from './missing-reaper.ts';
import { startMigration, type MigrationHandle } from './migration.ts';

let trashGc: TrashGcHandle | null = null;
let missingReaper: MissingReaperHandle | null = null;
let migration: MigrationHandle | null = null;

/** Start every maintenance job. Idempotent — a second call is a no-op while a
 * prior set is still running. */
export function startMaintenanceJobs(): void {
  if (!trashGc) trashGc = startTrashGc({});
  if (!missingReaper) missingReaper = startMissingReaper();
  if (!migration) migration = startMigration();
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
}
