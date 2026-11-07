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

import { Database } from 'bun:sqlite';
import { SCHEMA_PRAGMAS } from '../../src/db/sqlite/ddl/index.ts';
import { fromBunSqlite, runMigrations } from '../../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../../src/db/sqlite/migrations/index.ts';
import type { SqlParams } from '../../src/db/sqlite/protocol.ts';
import { destinationStatus } from '../../src/cloud-backup/destination-status.ts';
import {
  benchDbPath,
  ensureBenchDir,
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
      const pending = i % 25 === 3;
      const state = i % 200 === 11 ? 'purged' : i % 100 === 13 ? 'trash' : 'active';
      const failed = i % 100 === 17;
      entry.run(
        crypto.randomUUID(),
        DESTINATION,
        id,
        `2024/${i}.dng`,
        state,
        pending ? 2 : 1,
        1,
        manifest(i),
        failed ? ERRORS[i % ERRORS.length]! : null,
        failed ? i : 0,
      );
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

/** The aggregates as `GET /api/cloud-backup/destinations` ran them before #5707. */
const BEFORE = {
  status: `SELECT COALESCE(SUM(CASE WHEN state!='purged' AND verified_sequence<sequence THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN state!='purged' AND verified_sequence=sequence THEN 1 ELSE 0 END),0) AS verified,
      COALESCE(SUM(CASE WHEN state='trash' THEN 1 ELSE 0 END),0) AS trash,
      COALESCE(SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END),0) AS blocked,
      COALESCE(SUM((SELECT SUM(json_extract(value,'$.object.size')) FROM json_each(manifest,'$.files'))),0) AS bytes
      FROM backup_entries WHERE destination_id=?1`,
  pending: `SELECT MAX(0,COALESCE((SELECT live_locations FROM backup_coverage_counts WHERE library_id=?2),0)
      - (SELECT COUNT(*) FROM backup_entries e
        JOIN asset_locations l ON l.asset_id=e.asset_id AND l.ordinal=e.ordinal
        JOIN assets a ON a.id=e.asset_id
        WHERE e.destination_id=?1 AND l.library_id=?2 AND l.deleted_at IS NULL
          AND l.missing_since IS NULL AND a.deleted_reason IS NULL
          AND (e.state='purged' OR e.verified_sequence>=e.sequence))) AS pending`,
  missing: `SELECT (SELECT COUNT(*) FROM asset_locations
      WHERE library_id=?2 AND missing_since IS NOT NULL)
      + (SELECT COUNT(*) FROM assets AS a INDEXED BY assets_reaped
        JOIN asset_locations l ON l.asset_id=a.id
        WHERE a.deleted_reason='reaped' AND l.library_id=?2 AND l.missing_since IS NULL) AS missing,
    (SELECT COUNT(*) FROM backup_lifecycle WHERE library_id=?2 AND phase='prepared') AS prepared`,
  error: `SELECT last_error AS message,COUNT(*) AS count FROM backup_entries
      WHERE destination_id=?1 AND last_error IS NOT NULL
      GROUP BY last_error ORDER BY count DESC,MAX(retry_at) DESC LIMIT 1`,
  purges: `SELECT * FROM backup_purges WHERE destination_id=?1`,
} as const;

const paramsFor = (sql: string) => (sql.includes('?2') ? [DESTINATION, LIBRARY] : [DESTINATION]);

function beforeStatus(db: Database) {
  const row = <T>(sql: string) => db.query(sql).get(...paramsFor(sql)) as T;
  const status = row<{ verified: number; trash: number; blocked: number; bytes: number }>(
    BEFORE.status,
  );
  const { pending } = row<{ pending: number }>(BEFORE.pending);
  const { missing, prepared } = row<{ missing: number; prepared: number }>(BEFORE.missing);
  const error = row<{ message: string; count: number } | null>(BEFORE.error);
  const purges = db.query(BEFORE.purges).all(DESTINATION) as Array<{ completed: number }>;
  return {
    pending,
    missing,
    prepared,
    verified: status.verified,
    trash: status.trash,
    blocked: status.blocked + prepared,
    bytes: status.bytes,
    lastError: error?.message ?? null,
    lastErrorCount: error?.count ?? 0,
    purgePending: purges.filter((p) => !p.completed).length,
  };
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
await ensureBenchDir();
await removeDatabase(path);
const db = new Database(path, { create: true });
for (const pragma of SCHEMA_PRAGMAS) db.exec(pragma);
await runMigrations(
  fromBunSqlite(db),
  ALL_MIGRATIONS.filter((migration) => migration.id < COUNTS_MIGRATION),
);
const seedStarted = performance.now();
seed(db, count);
db.exec('ANALYZE');
console.log(`seeded ${count} entries in ${Math.round(performance.now() - seedStarted)} ms`);

const beforeMs = Object.fromEntries(
  Object.entries(BEFORE).map(([name, sql]) => [
    name,
    timeStatement(db, sql, paramsFor(sql), RUNS).ms,
  ]),
);
const before = beforeStatus(db);
const beforeWriteUs = timeWrites(db) * 1000;

const migrated = await runMigrations(fromBunSqlite(db), ALL_MIGRATIONS);
const migrationMs = migrated.durations[COUNTS_MIGRATION];

const adapter = {
  read: async <T>(sql: string, params?: SqlParams) =>
    db.query(sql).all(...((params ?? []) as never[])) as T[],
};
const target = { id: DESTINATION, kind: 'google-drive' as const, libraryId: LIBRARY };
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
