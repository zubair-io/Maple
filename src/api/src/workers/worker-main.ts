/**
 * Worker process entry. Runs the entire worker tier (stages, import, discover,
 * job runner, maintenance, enrichment) OFF the API event loop. The API spawns
 * this as one niced child; a crash/runaway here can never touch the HTTP server.
 */
import { installChildHardening } from '../runtime/child-process-worker.ts';
import { getDb, ensureIndexes, closeDb } from '../db/client.ts';
import { startWorkers, stopWorkers } from './start-workers.ts';
import { initOtel } from '../otel.ts';
import {
  resolveObservabilityConfig,
  loadObservabilityConfig,
} from '../observability/observability-config.repo.ts';
import { child as childLogger } from '../log.ts';

installChildHardening('worker');
const log = childLogger('worker-main');

async function main(): Promise<void> {
  await getDb();
  try {
    await ensureIndexes();
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : e }, 'ensureIndexes failed — continuing');
  }
  try {
    await initOtel(resolveObservabilityConfig(await loadObservabilityConfig()));
  } catch (e) {
    log.warn({ err: e }, 'otel init failed');
  }
  await startWorkers();
  log.info('worker tier started');
  const shutdown = async () => {
    try {
      await stopWorkers();
    } catch {
      /* best effort */
    }
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
main().catch((e) => {
  process.stderr.write(`[worker-main] fatal: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
