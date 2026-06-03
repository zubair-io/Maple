/**
 * Discover sweep child process. Runs the reconciliation SweeperLoop off the API
 * event loop (the freeze fix). Roots arrive as argv. Self-nices + self-exits if
 * orphaned via installChildHardening. Connects to Mongo independently.
 */
import { installChildHardening } from '../../runtime/child-process-worker.ts';
import { getDb, ensureIndexes, closeDb } from '../../db/client.ts';
import { startDiscover } from './index.ts';
import { child as childLogger } from '../../log.ts';

installChildHardening('discover');
const log = childLogger('discover-child');

async function main(): Promise<void> {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    process.stderr.write('discover child: no roots\n');
    process.exit(1);
  }
  await getDb();
  // The supervisor already ran ensureIndexes() at boot before spawning us, so
  // this is a redundant safety net. A failure here (e.g. a transient error, or
  // `ns not found` on a fresh DB) must NOT kill the sweep — mirror the parent's
  // log-and-continue (see index.ts) rather than letting main()'s catch exit(1).
  try {
    await ensureIndexes();
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : e }, 'ensureIndexes failed — continuing');
  }
  const handle = await startDiscover({ roots });
  log.info({ roots }, 'discover sweep started');
  const shutdown = async () => {
    await handle.stop();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
main().catch((e) => {
  process.stderr.write(
    `[discover-child] fatal: ${e instanceof Error ? e.message : e}\n`,
  );
  process.exit(1);
});
