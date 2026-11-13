/**
 * What one Backup settings page load costs per destination — the measurement behind #5707.
 *
 *   bun scripts/sqlite-bench/backup-destination-status.ts           # 343,000 entries
 *   bun scripts/sqlite-bench/backup-destination-status.ts 50000     # one smaller size
 *   bun scripts/sqlite-bench/backup-destination-status.ts --keep    # leave the .db behind
 *
 * Seeds one library and one Google Drive destination on the schema before
 * 0040, times the five aggregates `GET /api/cloud-backup/destinations` used to
 * run, applies 0040 (timing the backfill), then times `destinationStatus` on
 * the counters and asserts both report the same status. It also times a
 * batch of entry writes on each side, since the counters move cost onto writes.
 */

import type { Database } from 'bun:sqlite';
import { fromBunSqlite, runMigrations } from '../../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../../src/db/sqlite/migrations/index.ts';
import type { SqlParams } from '../../src/db/sqlite/protocol.ts';
import { destinationStatus } from '../../src/cloud-backup/destination-status.ts';
import {
  LEGACY_STATUS_SQL,
  legacyParams,
  recountedStatus,
} from '../../src/cloud-backup/destination-status-legacy.test-helpers.ts';
import {
  benchDbPath,
  openBenchDatabase,
  queryPlanLines,
  removeDatabase,
  sizeArgument,
  timeAsync,
  timeStatement,
} from './bench-db.ts';

const RUNS = 5;
const WRITES = 5000;
const COUNTS_MIGRATION = '0040-backup-destination-counts';
const LIBRARY = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const DESTINATION = '00000000-0000-4000-8000-000000000001';
const ERRORS = ['Drive quota exceeded', 'Source file unreadable', 'Upload timed out'];

const hex = (i: number) => i.toString(16).padStart(24, '0');

function manifest(i: number): string {
  return JSON.stringify({
    version: 1,
    libraryId: LIBRARY,
    entryId: `e${i}`,
    assetId: hex(i),
    sequence: 1,
    state: 'active',
    originalPath: `2024/${i}.dng`,
    currentPath: `2024/${i}.dng`,
    deletedAt: null,
    hidden: false,
    files: [
      { path: `${i}.dng`, role: 'original', object: { locator: `o${i}`, size: 25_000_000 + i } },
      { path: `${i}.xmp`, role: 'sidecar', object: { locator: `s${i}`, size: 4_000 + (i % 97) } },
    ],
  });
}

function entryState(i: number): string {
  if (i % 200 === 11) return 'purged';
  return i % 100 === 13 ? 'trash' : 'active';
}

/** One entry's bindings: 4% pending, 1% Trash, 0.5% purged, 1% failing across three messages. */
function entryRow(i: number) {
  const error = i % 100 === 17 ? ERRORS[i % ERRORS.length]! : null;
  return [
    crypto.randomUUID(),
    DESTINATION,
    hex(i),
    `2024/${i}.dng`,
    entryState(i),
    i % 25 === 3 ? 2 : 1,
    1,
    manifest(i),
    error,
    error ? i : 0,
  ] as const;
}

function seed(db: Database, count: number): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO folders (id, path, slug, label, file_count, created_at) VALUES (?, '/library', 'lib', 'Library', 0, ?)`,
    [LIBRARY, now],
  );
  db.run(
    `INSERT INTO backup_destinations(id,library_id,kind,name,enabled,root_id,created_at)
     VALUES (?,?,'google-drive','Drive',1,'root',?)`,
    [DESTINATION, LIBRARY, now],
  );
  const asset = db.query(`INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, 1024, 0, ?)`);
  const location = db.query(
    `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename, missing_since)
     VALUES (?, 0, ?, '2024', ?, ?)`,
  );
  const entry = db.query(
    `INSERT INTO backup_entries(id,destination_id,asset_id,ordinal,source_path,state,sequence,
       verified_sequence,manifest,last_error,retry_at)
     VALUES (?,?,?,0,?,?,?,?,?,?,?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const id = hex(i);
      asset.run(id, now);
      location.run(id, LIBRARY, `${i}.dng`, i % 100 === 7 ? now : null);
      entry.run(...entryRow(i));
    }
  })();
  db.run(`UPDATE assets SET deleted_reason='reaped' WHERE rowid % 200 = 5`);
  db.run(
    `INSERT INTO backup_lifecycle(id,asset_id,library_id,kind,phase,created_at)
     VALUES ('l1',?,?,'trash','applied',?)`,
    [hex(1), LIBRARY, now],
  );
  db.run(
    `INSERT INTO backup_purges(destination_id,entry_id,record,completed)
     SELECT destination_id,id,'{}',rowid % 2 FROM backup_entries WHERE state='purged'`,
  );
}

function timeWrites(db: Database): number {
  const ids = (
    db
      .query(`SELECT id FROM backup_entries WHERE last_error IS NULL LIMIT ?`)
      .all(WRITES) as Array<{ id: string }>
  ).map((r) => r.id);
  const fail = db.query(`UPDATE backup_entries SET last_error='Transient',retry_at=1 WHERE id=?`);
  const clear = db.query(`UPDATE backup_entries SET last_error=NULL,retry_at=0 WHERE id=?`);
  const startedAt = performance.now();
  db.transaction(() => {
    for (const id of ids) fail.run(id);
    for (const id of ids) clear.run(id);
  })();
  return (performance.now() - startedAt) / (ids.length * 2);
}

const args = process.argv.slice(2);
const count = sizeArgument(args, 343_000);
const path = benchDbPath('backup-destination-status');
const db = await openBenchDatabase(
  path,
  ALL_MIGRATIONS.filter((migration) => migration.id < COUNTS_MIGRATION),
);
const seedStarted = performance.now();
seed(db, count);
db.exec('ANALYZE');
console.log(`seeded ${count} entries in ${Math.round(performance.now() - seedStarted)} ms`);

const target = { id: DESTINATION, kind: 'google-drive' as const, libraryId: LIBRARY };
const beforeMs = Object.fromEntries(
  Object.entries(LEGACY_STATUS_SQL).map(([name, sql]) => [
    name,
    timeStatement(db, sql, legacyParams(sql, target), RUNS).ms,
  ]),
);
const before = recountedStatus(db, target);
const beforeWriteUs = timeWrites(db) * 1000;

const migrated = await runMigrations(fromBunSqlite(db), ALL_MIGRATIONS);
const migrationMs = migrated.durations[COUNTS_MIGRATION];

const adapter = {
  read: async <T>(sql: string, params?: SqlParams) =>
    db.query(sql).all(...((params ?? []) as never[])) as T[],
};
const after = await destinationStatus(adapter, target);
const { ms: afterMs } = await timeAsync(() => destinationStatus(adapter, target), RUNS);
const afterWriteUs = timeWrites(db) * 1000;

console.table(Object.entries(beforeMs).map(([query, ms]) => ({ query, beforeMs: ms.toFixed(1) })));
console.log(
  `before: ${Object.values(beforeMs)
    .reduce((a, b) => a + b, 0)
    .toFixed(1)} ms per destination`,
);
console.log(`after:  ${afterMs.toFixed(2)} ms per destination (destinationStatus)`);
console.log(`0040 migration: ${migrationMs} ms`);
console.log(
  `entry write: ${beforeWriteUs.toFixed(1)} µs before, ${afterWriteUs.toFixed(1)} µs after`,
);
console.log(
  'dominant error plan:',
  queryPlanLines(
    db,
    `SELECT c.message FROM backup_entry_errors c
  WHERE c.destination_id=?1 ORDER BY (SELECT MAX(retry_at) FROM backup_entries e
  WHERE e.destination_id=?1 AND e.last_error=c.message) DESC`,
    [DESTINATION],
  ),
);
console.log({ before, after });
db.close();
if (!args.includes('--keep')) await removeDatabase(path);
if (JSON.stringify(before) !== JSON.stringify(after)) {
  console.error('MISMATCH: counters disagree with the aggregates they replace');
  process.exit(1);
}
