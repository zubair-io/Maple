/**
 * What the worker tier keeps in-process around its scheduled maintenance: the
 * Settings → Workers entries for the pausable maintenance workers, the sink
 * that queues failed inline mirror copies, and the mirror registry refresh the
 * mirror tasks read. The passes themselves run as Temporal maintenance tasks
 * (`tasks.ts`).
 */

import { loadMirrorConfig } from '../../fs/mirror-config.ts';
import { child as childLogger } from '../../log.ts';
import { registerDeDuplicate } from '../dedupe.ts';
import { registerMigration } from '../migration.ts';
import { installMirrorQueueSink } from '../mirror/sink.ts';
import { registerMissingReaper } from '../missing-reaper.ts';
import type { RegisteredWorker } from '../pause-control.ts';

const log = childLogger('maintenance');

/**
 * A mirror enabled, disabled or repointed through the API (a different
 * process) reaches this one's registry within a minute, without a restart.
 * worker-main does the initial load; this catches later changes and retries a
 * failed initial load.
 */
const MIRROR_CONFIG_RELOAD_MS = 60_000;

let registered: RegisteredWorker[] = [];
let mirrorConfigReload: ReturnType<typeof setInterval> | null = null;

function reloadMirrorConfig(): void {
  void loadMirrorConfig().catch((err: unknown) => {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'periodic mirror config reload failed — keeping previous registry',
    );
  });
}

/** Idempotent while already started. */
export function startMaintenanceSupport(): void {
  if (mirrorConfigReload) return;
  registered = [registerMissingReaper(), registerDeDuplicate(), registerMigration()];
  installMirrorQueueSink();
  mirrorConfigReload = setInterval(reloadMirrorConfig, MIRROR_CONFIG_RELOAD_MS);
  mirrorConfigReload.unref?.();
}

export function stopMaintenanceSupport(): void {
  if (mirrorConfigReload) clearInterval(mirrorConfigReload);
  mirrorConfigReload = null;
  for (const worker of registered) worker.stop();
  registered = [];
}
