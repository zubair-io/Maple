import { WORKER_STATUS_MEMORY_DDL } from '../ddl/settings.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

/**
 * 0021 — the worker tier's memory samples on `worker_status` (#4445), so the
 * API process can put the worker's and its native children's RSS on the
 * Settings → Workers page without sampling another process.
 */
export const workerStatusMemoryMigration: Migration = {
  id: '0021-worker-status-memory',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(WORKER_STATUS_MEMORY_DDL);
  },
};
