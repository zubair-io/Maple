import type { Migration, MigrationDb } from '../migrate.ts';

/**
 * 0035 — a Live Photo's `.mov` twin gets its own companion slot (#5243).
 *
 * Both companions used to share `apple_rendered_path`, so an edited Live
 * Photo's `.mov` replaced its rendered image there and the image was orphaned.
 * A `.mov` already recorded in that slot can only be a Live twin (the rendered
 * companion is always an image), so it moves across. The cloud-backup dirty
 * trigger is recreated to watch the new column too.
 */
export const appleLiveVideoPathMigration: Migration = {
  id: '0035-apple-live-video-path',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`ALTER TABLE assets ADD COLUMN apple_live_video_path TEXT`);
    await db.exec(`UPDATE assets
      SET apple_live_video_path = apple_rendered_path, apple_rendered_path = NULL
      WHERE lower(apple_rendered_path) LIKE '%.mov'`);
    await db.exec(`DROP TRIGGER backup_asset_dirty`);
    await db.exec(`CREATE TRIGGER backup_asset_dirty AFTER UPDATE OF mtime,size,sidecar_ver,hidden,
  apple_rendered_path,apple_live_video_path,original_path,deleted_at,deleted_reason ON assets
WHEN OLD.mtime IS NOT NEW.mtime OR OLD.size IS NOT NEW.size
 OR OLD.sidecar_ver IS NOT NEW.sidecar_ver OR OLD.hidden IS NOT NEW.hidden
 OR OLD.apple_rendered_path IS NOT NEW.apple_rendered_path
 OR OLD.apple_live_video_path IS NOT NEW.apple_live_video_path
 OR OLD.original_path IS NOT NEW.original_path OR OLD.deleted_at IS NOT NEW.deleted_at
 OR OLD.deleted_reason IS NOT NEW.deleted_reason
BEGIN
  UPDATE backup_entries SET sequence=sequence+1,snapshot_hash=NULL,retry_at=0,
    lease_owner=NULL,lease_until=0 WHERE asset_id=NEW.id AND state!='purged';
  UPDATE stage_state SET version=0,attempts=0,dead=0,next_attempt_at=NULL
    WHERE asset_id=NEW.id AND stage='cloud-backup';
END`);
  },
};
