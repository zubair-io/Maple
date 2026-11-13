import type { Migration, MigrationDb } from '../migrate.ts';

export const STAGES_AT_0030 = [
  'exif',
  'thumb',
  'preview',
  'face-detect',
  'face-embed',
  'describe',
  'geocode',
  'search-blob',
  'sidecar-metadata-index',
  'cf-thumb-sync',
  'transcribe',
  'video-describe',
  'cloud-backup',
  'person-segmentation',
  'embed',
] as const;

/** 0030 — enroll assets that backup ingest and pano stitching created without stage rows (#4723). */
export const seedMissingStageStateMigration: Migration = {
  id: '0030-seed-missing-stage-state',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`
      INSERT INTO stage_state (asset_id, stage)
      SELECT a.id, s.value FROM assets a, json_each('${JSON.stringify(STAGES_AT_0030)}') s
      WHERE true
      ON CONFLICT (asset_id, stage) DO NOTHING`);
  },
};
