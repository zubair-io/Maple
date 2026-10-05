/** Durable backup state deliberately survives deletion of an asset row (#4228). */
export const CLOUD_BACKUP_DDL = `
CREATE TABLE backup_destinations (
  id TEXT PRIMARY KEY, library_id TEXT NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 1, path TEXT, root_id TEXT, account_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(library_id, kind, path)
);
CREATE TABLE backup_entries (
  id TEXT PRIMARY KEY, destination_id TEXT NOT NULL, asset_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active', source_path TEXT NOT NULL,
  manifest TEXT, snapshot_hash TEXT, verified_sequence INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE(destination_id, asset_id, ordinal)
);
CREATE INDEX backup_entries_pending ON backup_entries(destination_id,state,retry_at);
CREATE INDEX backup_entries_asset ON backup_entries(asset_id);
CREATE TABLE backup_objects (
  destination_id TEXT NOT NULL, key TEXT NOT NULL, object TEXT,
  checkpoint TEXT, entry_id TEXT NOT NULL,
  PRIMARY KEY(destination_id,key)
) WITHOUT ROWID;
CREATE TABLE backup_lifecycle (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, library_id TEXT,
  source_path TEXT, target_path TEXT, source_sha256 TEXT, kind TEXT NOT NULL, phase TEXT NOT NULL,
  created_at TEXT NOT NULL, last_error TEXT
);
CREATE INDEX backup_lifecycle_pending ON backup_lifecycle(phase,created_at);
CREATE TABLE backup_purges (
  destination_id TEXT NOT NULL, entry_id TEXT NOT NULL, record TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, PRIMARY KEY(destination_id,entry_id)
) WITHOUT ROWID;
CREATE TRIGGER backup_destination_delete_guard BEFORE DELETE ON backup_destinations
WHEN EXISTS (SELECT 1 FROM backup_purges WHERE destination_id=OLD.id AND completed=0)
 OR EXISTS (SELECT 1 FROM backup_entries WHERE destination_id=OLD.id AND lease_until>unixepoch('subsec')*1000)
BEGIN
  SELECT RAISE(ABORT,'Backup destination has pending cleanup or active transfers');
END;
-- UPDATE OF also fires for no-op assignments during discovery. Compare values,
-- including nullable lifecycle fields, before invalidating verified content.
CREATE TRIGGER backup_asset_dirty AFTER UPDATE OF mtime,size,sidecar_ver,hidden,apple_rendered_path,
  original_path,deleted_at,deleted_reason ON assets
WHEN OLD.mtime IS NOT NEW.mtime OR OLD.size IS NOT NEW.size
 OR OLD.sidecar_ver IS NOT NEW.sidecar_ver OR OLD.hidden IS NOT NEW.hidden
 OR OLD.apple_rendered_path IS NOT NEW.apple_rendered_path
 OR OLD.original_path IS NOT NEW.original_path OR OLD.deleted_at IS NOT NEW.deleted_at
 OR OLD.deleted_reason IS NOT NEW.deleted_reason
BEGIN
  UPDATE backup_entries SET sequence=sequence+1,snapshot_hash=NULL,retry_at=0,
    lease_owner=NULL,lease_until=0 WHERE asset_id=NEW.id AND state!='purged';
  UPDATE stage_state SET version=0,attempts=0,dead=0,next_attempt_at=NULL
    WHERE asset_id=NEW.id AND stage='cloud-backup';
END;
CREATE TRIGGER backup_location_dirty AFTER UPDATE OF path,filename,library_id ON asset_locations
WHEN OLD.path IS NOT NEW.path OR OLD.filename IS NOT NEW.filename
 OR OLD.library_id IS NOT NEW.library_id
BEGIN
  UPDATE backup_entries SET sequence=sequence+1,snapshot_hash=NULL,retry_at=0,
    lease_owner=NULL,lease_until=0 WHERE asset_id=NEW.asset_id AND ordinal=NEW.ordinal AND state!='purged';
  UPDATE stage_state SET version=0,attempts=0,dead=0,next_attempt_at=NULL
    WHERE asset_id=NEW.asset_id AND stage='cloud-backup';
END;
-- Discovery can deduplicate identical bytes into a new library location without
-- changing asset stat fields. Its destination still needs a first backup entry.
CREATE TRIGGER backup_location_inserted AFTER INSERT ON asset_locations
BEGIN
  UPDATE stage_state SET version=0,attempts=0,dead=0,next_attempt_at=NULL
    WHERE asset_id=NEW.asset_id AND stage='cloud-backup';
END;
`;
