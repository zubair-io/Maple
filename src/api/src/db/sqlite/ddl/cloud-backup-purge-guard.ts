/** Once purge admission commits, discovery cannot revive that identity with
 * another location while the original row awaits filesystem cleanup. */
export const CLOUD_BACKUP_PURGE_LOCATION_DDL = `
CREATE INDEX backup_lifecycle_asset ON backup_lifecycle(asset_id,kind,phase);
CREATE TRIGGER backup_location_purge_insert_guard BEFORE INSERT ON asset_locations
WHEN EXISTS (SELECT 1 FROM backup_lifecycle WHERE asset_id=NEW.asset_id AND kind='purge')
BEGIN
  SELECT RAISE(ABORT,'Asset has a durable backup purge intent');
END;
CREATE TRIGGER backup_location_purge_owner_guard BEFORE UPDATE OF asset_id ON asset_locations
WHEN OLD.asset_id IS NOT NEW.asset_id AND EXISTS
 (SELECT 1 FROM backup_lifecycle WHERE asset_id=NEW.asset_id AND kind='purge')
BEGIN
  SELECT RAISE(ABORT,'Asset has a durable backup purge intent');
END;
`;
