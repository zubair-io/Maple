import type { Migration, MigrationDb } from '../migrate.ts';

/**
 * 0041 — the retired Meilisearch vector-coverage index is dropped (#5840).
 *
 * Nothing has queried `assets_vector_fingerprint` since 0026, yet SQLite kept it current on every
 * write that changed an asset's liveness: 28 MB at 335k assets. The column it indexed,
 * `semantic_vector_fingerprint`, stays as unread storage on purpose. `ALTER TABLE assets DROP
 * COLUMN` works against this schema but rewrites every row inside the migration's transaction:
 * measured at 335k assets, 4 s of CPU and a 0.7 GB write-ahead log for 2 KB rows, 18 s and
 * 2.8 GB for 6 KB rows, and it reclaims no file space.
 */
export const dropVectorFingerprintIndexMigration: Migration = {
  id: '0041-drop-vector-fingerprint-index',
  async up(db: MigrationDb): Promise<void> {
    await db.exec('DROP INDEX IF EXISTS assets_vector_fingerprint');
  },
};
