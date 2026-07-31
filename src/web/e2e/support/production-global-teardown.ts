import {
  cleanupProductionFixtures,
  readProductionFixtureManifest,
  type ProductionFixtureManifest,
  verifyOriginalRawHashes,
} from './production-fixtures';

export default async function productionGlobalTeardown(): Promise<void> {
  let manifest: ProductionFixtureManifest;
  try {
    manifest = await readProductionFixtureManifest();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    await verifyOriginalRawHashes(manifest);
  } finally {
    await cleanupProductionFixtures(manifest);
  }
}
