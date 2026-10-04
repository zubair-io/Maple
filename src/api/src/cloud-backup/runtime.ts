import { BackupEngine } from './engine.ts';
import { providerForDestination } from './google/factory.ts';
import { drainPurges } from './purge.ts';
import { reconcileLifecycle } from './lifecycle.ts';

export const backupEngine = new BackupEngine(async (destination) =>
  providerForDestination(destination),
);
let maintenanceAt = 0;
/** Bounded lifecycle maintenance; asset bytes are transferred only by the stage. */
export async function maintainBackup(): Promise<void> {
  await reconcileLifecycle(backupEngine.repo);
  const destinations = await backupEngine.repo.destinations();
  for (const destination of destinations) await drainPurges(backupEngine, destination);
  if (Date.now() - maintenanceAt < 3_600_000) return;
  maintenanceAt = Date.now();
  for (const destination of destinations.filter((d) => d.kind === 'google-drive' && d.enabled)) {
    await backupEngine.repo.rearmLibrary(destination.libraryId);
  }
  // Applied records are history; prepared records block uploads until an
  // explicit move succeeds or the operator retries the local operation.
}
