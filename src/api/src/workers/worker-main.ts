/**
 * Worker process entry. Runs the entire worker tier (stages, import, discover,
 * job runner, maintenance, enrichment) OFF the API event loop. The API spawns
 * this as one niced child; a crash/runaway here can never touch the HTTP server.
 */
import { installChildHardening } from '../runtime/child-process-worker.ts';
import { getDb, ensureIndexes, closeDb } from '../db/client.ts';
import { startWorkers, stopWorkers } from './start-workers.ts';
import { loadMirrorConfig } from '../fs/mirror-config.ts';
import { flushOtelBeforeExit, initOtel, installOtelFatalFlush } from '../otel.ts';
import {
  resolveObservabilityConfig,
  loadObservabilityConfig,
} from '../observability/observability-config.repo.ts';
import { child as childLogger } from '../log.ts';

installChildHardening('worker');
// An uncaught exception or unhandled rejection flushes telemetry before the
// process exits (#2196). Installed before anything else runs so an early
// boot failure is covered too; a native abort is beyond any hook and is
// bounded only by the worker tier's short export cadence (see `otel.ts`).
installOtelFatalFlush();
const log = childLogger('worker-main');

async function main(): Promise<void> {
  await getDb();
  try {
    await ensureIndexes();
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : e }, 'ensureIndexes failed — continuing');
  }
  try {
    await initOtel(resolveObservabilityConfig(await loadObservabilityConfig()), 'worker');
  } catch (e) {
    log.warn({ err: e }, 'otel init failed');
  }
  // Load the library→mirror registry BEFORE the worker tier starts. Without it
  // the worker process has an empty registry, so every mirror-aware write here
  // (backup-folder migrations, imports, trash deletes) resolves to zero targets
  // and the mirror silently drifts — and the mirror-scan/copy reconcile that
  // should catch the drift is itself gated off (`isMirroringActive()` is false).
  // The API process loads this in index.ts; the worker tier must do the same.
  // After this initial load, `startMaintenanceJobs` re-reads the config on an
  // interval, so a failure here self-heals (and later config changes propagate)
  // without a worker restart.
  try {
    await loadMirrorConfig();
  } catch (e) {
    log.warn(
      { err: e instanceof Error ? e.message : e },
      'initial mirror config load failed — the periodic reload will retry; mirroring inactive until it succeeds',
    );
  }
  await startWorkers();
  log.info('worker tier started');
  const shutdown = async () => {
    try {
      await stopWorkers();
    } catch {
      /* best effort */
    }
    log.info('worker tier stopped');
    // SIGTERM is the one death this tier can see coming: drain the batch
    // exporters (bounded) so the last seconds of spans and logs — including
    // the line above — reach the collector instead of dying with the
    // process (#2196). The API process does the same in its own shutdown.
    await flushOtelBeforeExit();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
main().catch(async (e) => {
  process.stderr.write(`[worker-main] fatal: ${e instanceof Error ? e.message : e}\n`);
  await flushOtelBeforeExit();
  process.exit(1);
});
