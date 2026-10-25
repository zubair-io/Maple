import type { Migration, MigrationDb } from '../migrate.ts';

/**
 * 0036 — files a kept-photo purge still owes the disk (#5403). Written in the
 * same transaction that takes the photo out of Trash, and drained until every
 * unlink lands, so a failed unlink or a crash never orphans a trashed copy.
 * `owner_rel_path` is the file whose reuse by any asset cancels the obligation.
 */
export const localPurgeObligationsMigration: Migration = {
  id: '0036-local-purge-obligations',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`CREATE TABLE local_purge_obligations (
      id              INTEGER PRIMARY KEY,
      asset_id        TEXT NOT NULL,
      library_id      TEXT NOT NULL,
      rel_path        TEXT NOT NULL,
      owner_rel_path  TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('trash', 'companion')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      UNIQUE (library_id, rel_path)
    )`);
    await db.exec(`CREATE INDEX local_purge_obligations_due
      ON local_purge_obligations (next_attempt_at)`);
    await db.exec(`CREATE INDEX local_purge_obligations_asset
      ON local_purge_obligations (asset_id)`);
  },
};
