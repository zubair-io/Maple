import type { Migration } from '../migrate.ts';

/** Materialized live-location counts and indexes for fast backup coverage status. */
export const cloudBackupDestinationStatusMigration: Migration = {
  id: '0016-cloud-backup-destination-status',
  async up(db): Promise<void> {
    await db.exec(`CREATE TABLE backup_coverage_counts (
      library_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
      live_locations INTEGER NOT NULL DEFAULT 0 CHECK (live_locations >= 0)
    )`);
    await db.exec(`INSERT INTO backup_coverage_counts(library_id,live_locations)
      SELECT f.id,COALESCE(counts.live_locations,0) FROM folders f LEFT JOIN (
        SELECT l.library_id,COUNT(*) AS live_locations
        FROM asset_locations l JOIN assets a ON a.id=l.asset_id
        WHERE l.deleted_at IS NULL AND l.missing_since IS NULL AND a.deleted_reason IS NULL
        GROUP BY l.library_id
      ) counts ON counts.library_id=f.id`);
    await db.exec(`CREATE INDEX asset_locations_library_missing
      ON asset_locations (library_id) WHERE missing_since IS NOT NULL`);
    await db.exec(`CREATE INDEX assets_reaped ON assets (id) WHERE deleted_reason='reaped'`);
    await db.exec(`CREATE TRIGGER backup_coverage_location_insert AFTER INSERT ON asset_locations
      WHEN NEW.deleted_at IS NULL AND NEW.missing_since IS NULL AND
        (SELECT deleted_reason FROM assets WHERE id=NEW.asset_id) IS NULL
      BEGIN
        INSERT INTO backup_coverage_counts(library_id,live_locations) VALUES(NEW.library_id,1)
        ON CONFLICT(library_id) DO UPDATE SET live_locations=live_locations+1;
      END`);
    await db.exec(`CREATE TRIGGER backup_coverage_location_update
      AFTER UPDATE OF asset_id,library_id,deleted_at,missing_since ON asset_locations
      BEGIN
        UPDATE backup_coverage_counts SET live_locations=live_locations-1
        WHERE library_id=OLD.library_id AND OLD.deleted_at IS NULL AND OLD.missing_since IS NULL
          AND (SELECT deleted_reason FROM assets WHERE id=OLD.asset_id) IS NULL;
        INSERT INTO backup_coverage_counts(library_id,live_locations)
        SELECT NEW.library_id,1 WHERE NEW.deleted_at IS NULL AND NEW.missing_since IS NULL
          AND (SELECT deleted_reason FROM assets WHERE id=NEW.asset_id) IS NULL
        ON CONFLICT(library_id) DO UPDATE SET live_locations=live_locations+1;
      END`);
    await db.exec(`CREATE TRIGGER backup_coverage_location_delete AFTER DELETE ON asset_locations
      WHEN OLD.deleted_at IS NULL AND OLD.missing_since IS NULL AND
        EXISTS (SELECT 1 FROM assets WHERE id=OLD.asset_id AND deleted_reason IS NULL)
      BEGIN
        UPDATE backup_coverage_counts SET live_locations=live_locations-1
        WHERE library_id=OLD.library_id;
      END`);
    await db.exec(`CREATE TRIGGER backup_coverage_asset_delete BEFORE DELETE ON assets
      WHEN OLD.deleted_reason IS NULL
      BEGIN
        INSERT INTO backup_coverage_counts(library_id,live_locations)
        SELECT l.library_id,COUNT(*) FROM asset_locations l JOIN assets a ON a.id=l.asset_id
        WHERE l.library_id IN (SELECT library_id FROM asset_locations
          WHERE asset_id=OLD.id AND deleted_at IS NULL AND missing_since IS NULL)
          AND l.deleted_at IS NULL AND l.missing_since IS NULL AND a.deleted_reason IS NULL
        GROUP BY l.library_id ON CONFLICT(library_id) DO NOTHING;
        UPDATE backup_coverage_counts SET live_locations=live_locations -
          (SELECT COUNT(*) FROM asset_locations l WHERE l.asset_id=OLD.id
            AND l.library_id=backup_coverage_counts.library_id
            AND l.deleted_at IS NULL AND l.missing_since IS NULL)
        WHERE library_id IN (SELECT library_id FROM asset_locations WHERE asset_id=OLD.id
          AND deleted_at IS NULL AND missing_since IS NULL);
      END`);
    await db.exec(`CREATE TRIGGER backup_coverage_asset_reaped AFTER UPDATE OF deleted_reason ON assets
      WHEN OLD.deleted_reason IS NOT NEW.deleted_reason
      BEGIN
        UPDATE backup_coverage_counts SET live_locations=live_locations +
          (CASE WHEN NEW.deleted_reason IS NULL THEN 1 ELSE -1 END) *
          (SELECT COUNT(*) FROM asset_locations l WHERE l.asset_id=NEW.id
            AND l.library_id=backup_coverage_counts.library_id
            AND l.deleted_at IS NULL AND l.missing_since IS NULL)
        WHERE library_id IN (SELECT library_id FROM asset_locations WHERE asset_id=NEW.id
          AND deleted_at IS NULL AND missing_since IS NULL);
        INSERT INTO backup_coverage_counts(library_id,live_locations)
        SELECT l.library_id,COUNT(*) FROM asset_locations l JOIN assets a ON a.id=l.asset_id
        WHERE l.library_id IN (SELECT library_id FROM asset_locations
          WHERE asset_id=NEW.id AND deleted_at IS NULL AND missing_since IS NULL)
          AND l.deleted_at IS NULL AND l.missing_since IS NULL AND a.deleted_reason IS NULL
        GROUP BY l.library_id ON CONFLICT(library_id) DO NOTHING;
      END`);
  },
};
