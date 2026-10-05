import type { SqlStatement } from '../db/sqlite/protocol.ts';

export interface LifecycleCommit {
  id: string;
  owner: string;
}

/** Fail closed, including missing journals, before any asset/location writes commit. */
export function lifecycleCommitGuard(lifecycle?: LifecycleCommit): SqlStatement[] {
  return lifecycle
    ? [
        {
          sql: `CREATE TEMP TABLE backup_lifecycle_commit_assert(valid INTEGER NOT NULL CHECK(valid=1))`,
        },
        {
          sql: `INSERT INTO backup_lifecycle_commit_assert(valid) SELECT EXISTS
          (SELECT 1 FROM backup_lifecycle WHERE id=? AND phase='prepared' AND lease_owner=?
            AND lease_until>unixepoch('subsec')*1000)`,
          params: [lifecycle.id, lifecycle.owner],
        },
        { sql: `DROP TABLE backup_lifecycle_commit_assert` },
        {
          sql: `UPDATE backup_lifecycle SET phase='applied',lease_owner=? WHERE id=?`,
          params: [lifecycle.owner, lifecycle.id],
        },
      ]
    : [];
}

export function committedLifecycleStatements(
  assetId: string,
  libraryId: string,
  sourcePath: string,
  currentPath: string,
  state: 'active' | 'trash',
  lifecycle?: LifecycleCommit,
): SqlStatement[] {
  return [
    ...(!lifecycle
      ? [
          {
            sql: `UPDATE backup_lifecycle SET phase='applied',lease_owner=NULL,lease_until=0
        WHERE asset_id=? AND library_id=? AND source_path=? AND phase='prepared'`,
            params: [assetId, libraryId, sourcePath],
          },
        ]
      : []),
    {
      sql: `UPDATE backup_entries SET source_path=?,state=?,sequence=sequence+1,snapshot_hash=NULL,retry_at=0
      WHERE asset_id=? AND source_path=? AND destination_id IN
      (SELECT id FROM backup_destinations WHERE library_id=?) AND state!='purged'`,
      params: [currentPath, state, assetId, sourcePath, libraryId],
    },
  ];
}
