import type { Migration, MigrationDb } from '../migrate.ts';

/**
 * 0038 — Android Motion Photos (#5447).
 *
 * The `motion-photo` stage records where a still's embedded clip sits inside
 * the original: start and length of the byte range, the clip's content type,
 * and the original's size when that range was verified, so the clip route can
 * refuse a range the file no longer has. Every column is NULL for a plain still.
 *
 * Existing assets get their dense `motion-photo` stage row so the claim index
 * reaches them, and a change to an asset's size or mtime re-arms the stage: an
 * edit that strips or replaces the clip can keep the first 64 KB the content
 * guard compares, so nothing else would ever revisit the recorded range.
 */
export const motionPhotoMigration: Migration = {
  id: '0038-motion-photo',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`ALTER TABLE assets ADD COLUMN motion_video_start INTEGER
      CHECK (motion_video_start IS NULL OR motion_video_start >= 0)`);
    await db.exec(`ALTER TABLE assets ADD COLUMN motion_video_length INTEGER
      CHECK (motion_video_length IS NULL OR motion_video_length > 0)`);
    await db.exec(`ALTER TABLE assets ADD COLUMN motion_video_mime TEXT
      CHECK (motion_video_mime IS NULL OR motion_video_mime IN ('video/mp4', 'video/quicktime'))`);
    await db.exec(`ALTER TABLE assets ADD COLUMN motion_source_size INTEGER
      CHECK (motion_source_size IS NULL OR motion_source_size > 0)`);
    await db.exec(`INSERT INTO stage_state(asset_id,stage)
      SELECT id,'motion-photo' FROM assets WHERE true
      ON CONFLICT(asset_id,stage) DO NOTHING`);
    await db.exec(`CREATE TRIGGER motion_photo_source_changed AFTER UPDATE OF size,mtime ON assets
WHEN OLD.size IS NOT NEW.size OR OLD.mtime IS NOT NEW.mtime
BEGIN
  UPDATE stage_state SET version=0,attempts=0,dead=0,next_attempt_at=NULL
    WHERE asset_id=NEW.id AND stage='motion-photo';
END`);
  },
};
