import type { Migration, MigrationDb } from '../migrate.ts';

/** Whether an entry's location is live in its destination's library and its asset is not reaped. */
const locationLive = (entry: string) => `EXISTS (SELECT 1 FROM asset_locations l
  JOIN assets a ON a.id=l.asset_id
  JOIN backup_destinations d ON d.id=${entry}.destination_id AND d.library_id=l.library_id
  WHERE l.asset_id=${entry}.asset_id AND l.ordinal=${entry}.ordinal
    AND l.deleted_at IS NULL AND l.missing_since IS NULL AND a.deleted_reason IS NULL)`;

// Only rows whose mirror is stale are written, and the column is 0 or 1, so
// flipping it is the recomputed value without evaluating the probe twice.
const refreshLocationLive = (where: string) => `UPDATE backup_entries
  SET location_live=1-location_live
  WHERE ${where} AND location_live IS NOT ${locationLive('backup_entries')};`;

const bytes = (row: string) => `COALESCE(CASE WHEN json_valid(${row}.manifest) THEN
  (SELECT SUM(json_extract(value,'$.object.size')) FROM json_each(${row}.manifest,'$.files')) END,0)`;

const flags = (row: string) => [
  `${row}.state!='purged' AND ${row}.verified_sequence<${row}.sequence`,
  `${row}.state!='purged' AND ${row}.verified_sequence=${row}.sequence`,
  `${row}.state='trash'`,
  `${row}.last_error IS NOT NULL`,
  `${row}.location_live AND (${row}.state='purged' OR ${row}.verified_sequence>=${row}.sequence)`,
];

const COUNTERS = ['pending', 'verified', 'trash', 'blocked', 'covered'] as const;

const addCounts = (row: string, values: readonly string[], columns: readonly string[]) => `
  INSERT INTO backup_entry_counts(destination_id,${columns.join(',')})
  VALUES(${row}.destination_id,${values.join(',')})
  ON CONFLICT(destination_id) DO UPDATE SET
  ${columns.map((column) => `${column}=${column}+excluded.${column}`).join(',')};`;

// A plain UPDATE, never an upsert: when a destination is removed its counter row
// goes first, and the entry deletes that follow must not resurrect it.
const subtractCounts = (row: string, values: readonly string[], columns: readonly string[]) => `
  UPDATE backup_entry_counts SET
  ${columns.map((column, i) => `${column}=${column}-(${values[i]})`).join(',')}
  WHERE destination_id=${row}.destination_id;`;

const addError = (row: string) => `
  INSERT INTO backup_entry_errors(destination_id,message,entries)
  SELECT ${row}.destination_id,${row}.last_error,1 WHERE ${row}.last_error IS NOT NULL
  ON CONFLICT(destination_id,message) DO UPDATE SET entries=entries+1;`;

const removeError = (row: string) => `
  UPDATE backup_entry_errors SET entries=entries-1
  WHERE destination_id=${row}.destination_id AND message=${row}.last_error;
  DELETE FROM backup_entry_errors
  WHERE destination_id=${row}.destination_id AND message=${row}.last_error AND entries<=0;`;

const ALL_COLUMNS = [...COUNTERS, 'bytes'];

const SCHEMA = [
  // DEFAULT 1 leaves the common live row untouched, so the backfill below
  // rewrites only the few non-live entries instead of every row on disk.
  `ALTER TABLE backup_entries ADD COLUMN location_live INTEGER NOT NULL DEFAULT 1`,
  `UPDATE backup_entries SET location_live=0
      WHERE NOT ${locationLive('backup_entries')}`,
  `CREATE TABLE backup_entry_counts (
      destination_id TEXT PRIMARY KEY,
      pending INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0,
      trash INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
      covered INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0
    )`,
  `INSERT INTO backup_entry_counts(destination_id,${ALL_COLUMNS.join(',')})
      SELECT destination_id,${[...flags('e'), bytes('e')].map((value) => `COALESCE(SUM(${value}),0)`).join(',')}
      FROM backup_entries e WHERE destination_id IN (SELECT id FROM backup_destinations)
      GROUP BY destination_id`,
  `CREATE TABLE backup_entry_errors (
      destination_id TEXT NOT NULL, message TEXT NOT NULL, entries INTEGER NOT NULL,
      PRIMARY KEY(destination_id,message)
    ) WITHOUT ROWID`,
  `CREATE INDEX backup_entry_errors_count ON backup_entry_errors(destination_id,entries)`,
  `INSERT INTO backup_entry_errors(destination_id,message,entries)
      SELECT destination_id,last_error,COUNT(*) FROM backup_entries
      WHERE last_error IS NOT NULL AND destination_id IN (SELECT id FROM backup_destinations)
      GROUP BY destination_id,last_error`,
  `CREATE INDEX backup_entries_error_retry
      ON backup_entries(destination_id,last_error,retry_at) WHERE last_error IS NOT NULL`,
  `CREATE INDEX backup_purges_pending ON backup_purges(destination_id) WHERE completed=0`,
];

const TRIGGERS = [
  `CREATE TRIGGER backup_entry_counts_insert AFTER INSERT ON backup_entries
      BEGIN
        ${addCounts('NEW', [...flags('NEW'), bytes('NEW')], ALL_COLUMNS)}
        ${addError('NEW')}
        ${refreshLocationLive('id=NEW.id')}
      END`,
  `CREATE TRIGGER backup_entry_counts_delete AFTER DELETE ON backup_entries
      BEGIN
        ${subtractCounts('OLD', [...flags('OLD'), bytes('OLD')], ALL_COLUMNS)}
        ${removeError('OLD')}
      END`,
  `CREATE TRIGGER backup_entry_counts_update
      AFTER UPDATE OF destination_id,state,sequence,verified_sequence,last_error,location_live
      ON backup_entries
      WHEN OLD.destination_id IS NOT NEW.destination_id OR OLD.state IS NOT NEW.state
        OR OLD.sequence IS NOT NEW.sequence OR OLD.verified_sequence IS NOT NEW.verified_sequence
        OR (OLD.last_error IS NULL) IS NOT (NEW.last_error IS NULL)
        OR OLD.location_live IS NOT NEW.location_live
      BEGIN
        ${subtractCounts('OLD', flags('OLD'), COUNTERS)}
        ${addCounts('NEW', flags('NEW'), COUNTERS)}
      END`,
  `CREATE TRIGGER backup_entry_bytes_update
      AFTER UPDATE OF destination_id,manifest ON backup_entries
      WHEN OLD.destination_id IS NOT NEW.destination_id OR OLD.manifest IS NOT NEW.manifest
      BEGIN
        ${subtractCounts('OLD', [bytes('OLD')], ['bytes'])}
        ${addCounts('NEW', [bytes('NEW')], ['bytes'])}
      END`,
  `CREATE TRIGGER backup_entry_errors_update
      AFTER UPDATE OF destination_id,last_error ON backup_entries
      WHEN OLD.destination_id IS NOT NEW.destination_id OR OLD.last_error IS NOT NEW.last_error
      BEGIN
        ${removeError('OLD')}
        ${addError('NEW')}
      END`,
  `CREATE TRIGGER backup_entry_location_live_rekey
      AFTER UPDATE OF destination_id,asset_id,ordinal ON backup_entries
      WHEN OLD.destination_id IS NOT NEW.destination_id OR OLD.asset_id IS NOT NEW.asset_id
        OR OLD.ordinal IS NOT NEW.ordinal
      BEGIN
        ${refreshLocationLive('id=NEW.id')}
      END`,
  `CREATE TRIGGER backup_entry_location_live_location_insert
      AFTER INSERT ON asset_locations
      BEGIN
        ${refreshLocationLive('asset_id=NEW.asset_id AND ordinal=NEW.ordinal')}
      END`,
  `CREATE TRIGGER backup_entry_location_live_location_delete
      AFTER DELETE ON asset_locations
      BEGIN
        ${refreshLocationLive('asset_id=OLD.asset_id AND ordinal=OLD.ordinal')}
      END`,
  `CREATE TRIGGER backup_entry_location_live_location_update
      AFTER UPDATE OF asset_id,ordinal,library_id,deleted_at,missing_since ON asset_locations
      WHEN OLD.asset_id IS NOT NEW.asset_id OR OLD.ordinal IS NOT NEW.ordinal
        OR OLD.library_id IS NOT NEW.library_id OR OLD.deleted_at IS NOT NEW.deleted_at
        OR OLD.missing_since IS NOT NEW.missing_since
      BEGIN
        ${refreshLocationLive('asset_id=OLD.asset_id AND ordinal=OLD.ordinal')}
        ${refreshLocationLive(
          `(OLD.asset_id IS NOT NEW.asset_id OR OLD.ordinal IS NOT NEW.ordinal)
          AND asset_id=NEW.asset_id AND ordinal=NEW.ordinal`,
        )}
      END`,
  `CREATE TRIGGER backup_entry_location_live_asset_update
      AFTER UPDATE OF deleted_reason ON assets
      WHEN OLD.deleted_reason IS NOT NEW.deleted_reason
      BEGIN
        ${refreshLocationLive('asset_id=NEW.id')}
      END`,
  `CREATE TRIGGER backup_entry_location_live_asset_delete
      AFTER DELETE ON assets
      BEGIN
        ${refreshLocationLive('asset_id=OLD.id')}
      END`,
  `CREATE TRIGGER backup_entry_counts_destination_delete
      AFTER DELETE ON backup_destinations
      BEGIN
        DELETE FROM backup_entry_counts WHERE destination_id=OLD.id;
        DELETE FROM backup_entry_errors WHERE destination_id=OLD.id;
      END`,
];

/**
 * 0040 — per-destination backup status counters (#5707).
 *
 * The Backup settings page recounted every entry of every destination on each
 * load: five aggregates, about a second each at 343k entries. The counts now
 * live in `backup_entry_counts` and `backup_entry_errors`, kept by triggers on
 * `backup_entries` that read only the changed row's OLD and NEW values, so no
 * writer can forget them.
 *
 * Coverage also depends on the entry's location and asset, which change in
 * other tables. `backup_entries.location_live` mirrors that state per entry,
 * recomputed from scratch by triggers on `asset_locations` and `assets`; the
 * counter triggers then see it as one more column of the row.
 *
 * Never write `backup_entries` with REPLACE (INSERT OR REPLACE, REPLACE INTO,
 * ON CONFLICT REPLACE): with `recursive_triggers` off SQLite deletes the
 * displaced row without firing its delete trigger, and its counts would never
 * be subtracted.
 */
export const backupDestinationCountsMigration: Migration = {
  id: '0040-backup-destination-counts',
  async up(db: MigrationDb): Promise<void> {
    for (const statement of [...SCHEMA, ...TRIGGERS]) await db.exec(statement);
  },
};
