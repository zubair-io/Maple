import type { Migration } from '../migrate.ts';

export const removeUnusedStageHandlersMigration: Migration = {
  id: '0042-remove-unused-stage-handlers',
  async up(db): Promise<void> {
    await db.exec('DROP TABLE stage_handlers');
  },
};
