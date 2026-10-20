import type { Migration, MigrationDb } from '../migrate.ts';

/** 0033 — each stage's stall threshold, a setting on Settings → Workers (#5038). */
export const workerStallThresholdMigration: Migration = {
  id: '0033-worker-stall-threshold',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`ALTER TABLE worker_config ADD COLUMN stall_after_minutes INTEGER`);
  },
};
