import { RAW_EXTENSIONS } from '../../../indexer/media-types.ts';
import { pairStackAssets, type StackFile } from '../../../library/raw-jpeg-stack.ts';
import type { Migration, MigrationDb } from '../migrate.ts';
import { LIVE_ASSET_PREDICATE } from '../ddl/assets.ts';

/** Clears every pairing `asset` takes part in, as primary or as companion. */
const unlink = (asset: string) => `
  UPDATE assets SET stack_primary_id = NULL WHERE stack_primary_id = ${asset};
  UPDATE assets SET stack_primary_id = NULL WHERE id = ${asset} AND stack_primary_id IS NOT NULL;`;

const SCHEMA = [
  `ALTER TABLE assets ADD COLUMN stack_primary_id TEXT`,
  `CREATE INDEX assets_stack_primary ON assets (stack_primary_id)
     WHERE stack_primary_id IS NOT NULL`,
  // The count and the timeline histogram answer from these two indexes alone;
  // a fold predicate on a column they lack would read every asset row.
  `DROP INDEX assets_live`,
  `CREATE INDEX assets_live ON assets (live_location_count, hidden, stack_primary_id)
     WHERE ${LIVE_ASSET_PREDICATE}`,
  `DROP INDEX assets_live_captured_ym`,
  `CREATE INDEX assets_live_captured_ym
     ON assets (captured_year DESC, captured_month DESC, hidden, stack_primary_id)
     WHERE ${LIVE_ASSET_PREDICATE}`,
];

const TRIGGERS = [
  `CREATE TRIGGER assets_stack_trashed AFTER UPDATE OF deleted_at ON assets
     WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
     BEGIN ${unlink('NEW.id')} END`,
  `CREATE TRIGGER assets_stack_deleted AFTER DELETE ON assets
     BEGIN UPDATE assets SET stack_primary_id = NULL WHERE stack_primary_id = OLD.id; END`,
  `CREATE TRIGGER asset_locations_stack_moved
     AFTER UPDATE OF asset_id, ordinal, library_id, path, filename, deleted_at, missing_since
     ON asset_locations
     WHEN (OLD.ordinal = 0 OR NEW.ordinal = 0) AND (
       OLD.asset_id IS NOT NEW.asset_id OR OLD.ordinal IS NOT NEW.ordinal
       OR OLD.library_id IS NOT NEW.library_id OR OLD.path IS NOT NEW.path
       OR OLD.filename IS NOT NEW.filename OR OLD.deleted_at IS NOT NEW.deleted_at
       OR OLD.missing_since IS NOT NEW.missing_since)
     BEGIN ${unlink('OLD.asset_id')} ${unlink('NEW.asset_id')} END`,
  `CREATE TRIGGER asset_locations_stack_removed AFTER DELETE ON asset_locations
     WHEN OLD.ordinal = 0
     BEGIN ${unlink('OLD.asset_id')} END`,
];

const CANDIDATE_EXTENSIONS = ['jpg', 'jpeg', ...RAW_EXTENSIONS];

/** One folder's candidate files per row, the folder's files as a JSON array. */
const FOLDERS_SQL = `
  SELECT json_group_array(json_object('asset_id', l.asset_id, 'filename', l.filename)) AS files
    FROM asset_locations l
    JOIN assets a ON a.id = l.asset_id
   WHERE l.ordinal = 0 AND l.deleted_at IS NULL AND l.missing_since IS NULL
     AND a.deleted_at IS NULL
     AND (${CANDIDATE_EXTENSIONS.map(() => 'l.filename LIKE ?').join(' OR ')})
   GROUP BY l.library_id, l.path
  HAVING COUNT(*) > 1`;

async function backfill(db: MigrationDb): Promise<void> {
  const folders = await db.all<{ files: string }>(
    FOLDERS_SQL,
    CANDIDATE_EXTENSIONS.map((ext) => `%.${ext}`),
  );
  for (const folder of folders) {
    const pairs = pairStackAssets(JSON.parse(folder.files) as StackFile[]);
    for (const [companion, primary] of pairs) {
      await db.run('UPDATE assets SET stack_primary_id = ? WHERE id = ?', [primary, companion]);
    }
  }
}

/**
 * 0044 — RAW+JPEG stacks in the timeline and search (#5849, part of #5050).
 *
 * `stack_primary_id` is set on a JPEG whose canonical location sits beside
 * exactly one same-stem RAW (`library/raw-jpeg-stack.ts`), and names that RAW.
 * The discover sweep keeps it (`reconcileRawJpegStacks`); the triggers only
 * ever unpair, so a trashed, moved, missing or deleted half cannot leave its
 * partner hidden until the sweep returns. Search folds a pair with the
 * residual `stack_primary_id IS NULL`, which the two rebuilt indexes answer
 * without reading a row.
 */
export const rawJpegStacksMigration: Migration = {
  id: '0044-raw-jpeg-stacks',
  async up(db: MigrationDb): Promise<void> {
    for (const statement of [...SCHEMA, ...TRIGGERS]) await db.exec(statement);
    await backfill(db);
  },
};
