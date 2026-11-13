import type { Migration, MigrationDb } from '../migrate.ts';

/**
 * 0039 — Apple Live Photo pairing (#5540, part of #5448).
 *
 * The `live-photo` stage records the content identifier Apple writes into a
 * Live Photo's still and its clip; a folder listing pairs a still and a clip
 * that share a stem and an identifier. The column is NULL for any file that
 * carries none.
 *
 * Existing assets get their dense `live-photo` stage row so the claim index
 * reaches them, and a change to an asset's size or mtime re-arms the stage: an
 * edit that strips or replaces the identifier would otherwise leave a stale one.
 */
export const livePhotoMigration: Migration = {
  id: '0039-live-photo',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(
      `ALTER TABLE assets ADD COLUMN live_content_id TEXT
         CHECK (live_content_id IS NULL OR length(live_content_id) BETWEEN 8 AND 64)`,
    );
    await db.exec(`INSERT INTO stage_state(asset_id,stage)
      SELECT id,'live-photo' FROM assets WHERE true
      ON CONFLICT(asset_id,stage) DO NOTHING`);
    await db.exec(`CREATE TRIGGER live_photo_source_changed AFTER UPDATE OF size,mtime ON assets
WHEN OLD.size IS NOT NEW.size OR OLD.mtime IS NOT NEW.mtime
BEGIN
  UPDATE stage_state SET version=0,attempts=0,dead=0,next_attempt_at=NULL
    WHERE asset_id=NEW.id AND stage='live-photo';
END`);
  },
};
