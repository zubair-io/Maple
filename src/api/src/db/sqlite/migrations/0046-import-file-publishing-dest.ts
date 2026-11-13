import type { Migration } from '../migrate.ts';

/**
 * 0046 — the publish marker on an import file row (#5932).
 *
 * An import attempt writes the library-relative name it is about to publish an
 * image or movie under before the publish, and clears it once that file's
 * sidecars and indexer hand-off are finished. NULL everywhere else, including
 * every row an earlier release wrote.
 */
export const importFilePublishingDestMigration: Migration = {
  id: '0046-import-file-publishing-dest',
  async up(db): Promise<void> {
    await db.exec(`ALTER TABLE import_files ADD COLUMN publishing_dest TEXT`);
  },
};
