import type { SqlStatement } from '../db/sqlite/protocol.ts';

export function committedLifecycleStatements(
  assetId: string,
  libraryId: string,
  sourcePath: string,
  currentPath: string,
  state: 'active' | 'trash',
): SqlStatement[] {
  return [
    {
      sql: `UPDATE backup_lifecycle SET phase='applied' WHERE asset_id=? AND library_id=? AND source_path=? AND phase='prepared'`,
      params: [assetId, libraryId, sourcePath],
    },
    {
      sql: `UPDATE backup_entries SET source_path=?,state=?,sequence=sequence+1,snapshot_hash=NULL,retry_at=0
      WHERE asset_id=? AND source_path=? AND destination_id IN
      (SELECT id FROM backup_destinations WHERE library_id=?) AND state!='purged'`,
      params: [currentPath, state, assetId, sourcePath, libraryId],
    },
  ];
}
