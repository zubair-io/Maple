import type { Migration } from '../migrate.ts';

export const removeUnusedIndexerQueueMigration: Migration = {
  id: '0008-remove-unused-indexer-queue',
  async up(db): Promise<void> {
    await db.exec('DROP TABLE indexer_queue');
  },
};
