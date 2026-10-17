import type { Migration, MigrationDb } from '../migrate.ts';

/** 0030 — enroll assets that backup ingest and pano stitching created without stage rows (#4723). */
export const seedMissingStageStateMigration: Migration = {
  id: '0030-seed-missing-stage-state',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`
      INSERT INTO stage_state (asset_id, stage)
      SELECT a.id, s.stage
        FROM assets a CROSS JOIN (SELECT DISTINCT stage FROM stage_state) s
       WHERE true
      ON CONFLICT (asset_id, stage) DO NOTHING`);
  },
};
