import { BackupEngine } from './engine.ts';
import { providerForDestination } from './google/factory.ts';
import { drainPurges } from './purge.ts';
import { reconcileLifecycle } from './lifecycle.ts';

export const backupEngine = new BackupEngine(async (destination) =>
  providerForDestination(destination),
);
/** Bounded lifecycle maintenance; asset bytes are transferred only by the stage. */
export async function maintainBackup(): Promise<void> {
  await reconcileLifecycle(backupEngine.repo);
  const destinations = await backupEngine.repo.destinations();
  for (const destination of destinations) await drainPurges(backupEngine, destination);
  // Indexed file/lifecycle changes rearm their stage transactionally; failed
  // transfers defer to their durable retry. Maintenance must not hash every
  // unchanged original or override a worker's current stage lease.
  // Applied records are history; prepared records block uploads until an
  // explicit move succeeds or the operator retries the local operation.
}
