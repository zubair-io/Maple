const RESET_SET = `version = 0, attempts = 0, last_error = NULL, processed_at = NULL, dead = 0,
         next_attempt_at = NULL, claim_token = NULL`;

// The filename in the searchable text is the primary location's: the lowest-ordinal live one. A
// trashed asset is skipped: it is not searchable, and restoring it re-arms the stages itself.
function noLiveLowerOrdinal(row: 'NEW' | 'OLD'): string {
  return `(SELECT deleted_at FROM assets WHERE id = ${row}.asset_id) IS NULL
    AND NOT EXISTS (SELECT 1 FROM asset_locations o WHERE o.asset_id = ${row}.asset_id
    AND o.ordinal < ${row}.ordinal AND o.deleted_at IS NULL AND o.missing_since IS NULL)`;
}

// Stage rows are dense, so a location change only ever updates the rows that exist.
function rearmExistingAssetStages(assetIdExpr: string): string {
  return `UPDATE stage_state SET ${RESET_SET}
   WHERE asset_id = ${assetIdExpr} AND stage IN ('meili', 'embed');`;
}

function rearmExistingUntrashedAssetStages(assetIdExpr: string): string {
  return `UPDATE stage_state SET ${RESET_SET}
   WHERE asset_id = ${assetIdExpr} AND stage IN ('meili', 'embed')
     AND (SELECT deleted_at FROM assets WHERE id = ${assetIdExpr}) IS NULL;`;
}

/**
 * The searchable filename is the primary location's: the lowest-ordinal live one. These triggers
 * re-queue `meili` and `embed` whenever that can change: a location becoming or ceasing to be the
 * live primary, a rename of the primary, a lower-ordinal live location arriving, a live location moving between
 * assets or being renumbered (a dedup merge), or the primary being deleted. Changes to higher-ordinal copies re-queue nothing.
 */
export const LOCATION_SEARCH_TRIGGER_DDL = `
CREATE TRIGGER locations_search_inserted AFTER INSERT ON asset_locations
WHEN NEW.deleted_at IS NULL AND NEW.missing_since IS NULL AND ${noLiveLowerOrdinal('NEW')}
BEGIN
  ${rearmExistingAssetStages('NEW.asset_id')}
END;

CREATE TRIGGER locations_search_changed
AFTER UPDATE OF filename, deleted_at, missing_since ON asset_locations
WHEN (OLD.filename IS NOT NEW.filename OR OLD.deleted_at IS NOT NEW.deleted_at
      OR OLD.missing_since IS NOT NEW.missing_since)
  AND ${noLiveLowerOrdinal('NEW')}
BEGIN
  ${rearmExistingAssetStages('NEW.asset_id')}
END;

CREATE TRIGGER locations_search_moved AFTER UPDATE OF asset_id, ordinal ON asset_locations
WHEN (OLD.asset_id IS NOT NEW.asset_id OR OLD.ordinal IS NOT NEW.ordinal)
  AND NEW.deleted_at IS NULL AND NEW.missing_since IS NULL
BEGIN
  ${rearmExistingUntrashedAssetStages('NEW.asset_id')}
  ${rearmExistingUntrashedAssetStages('OLD.asset_id')}
END;

CREATE TRIGGER locations_search_deleted AFTER DELETE ON asset_locations
WHEN OLD.deleted_at IS NULL AND OLD.missing_since IS NULL AND ${noLiveLowerOrdinal('OLD')}
BEGIN
  ${rearmExistingAssetStages('OLD.asset_id')}
END;
`;
