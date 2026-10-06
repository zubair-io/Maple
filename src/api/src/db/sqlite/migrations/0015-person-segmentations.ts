import {
  PERSON_SEGMENTATIONS_INDEX_DDL,
  PERSON_SEGMENTATIONS_TABLE_DDL,
} from '../ddl/subject-masks.ts';
import type { Migration } from '../migrate.ts';

export const personSegmentationsMigration: Migration = {
  id: '0015-person-segmentations',
  async up(db): Promise<void> {
    await db.exec(PERSON_SEGMENTATIONS_TABLE_DDL);
    await db.exec(PERSON_SEGMENTATIONS_INDEX_DDL);
    // Dense stage rows are required by the claim index; UPDATE-only rearming cannot create them.
    await db.exec(`INSERT INTO stage_state(asset_id,stage)
      SELECT id,'person-segmentation' FROM assets WHERE true
      ON CONFLICT(asset_id,stage) DO NOTHING`);
  },
};
