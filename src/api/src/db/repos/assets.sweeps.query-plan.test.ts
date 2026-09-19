/**
 * The sweepers' candidate queries, checked against the index each one claims.
 *
 * Every worker in this group runs on a timer over the whole library, so the
 * difference between a seek and a scan is the difference between a tick that
 * costs nothing and one that reads the `assets` table every minute. A timing
 * assertion cannot catch that — a scan of twenty rows is fast — so the plan is
 * asserted instead, and it fails the moment a predicate is paraphrased into a
 * form that loses a partial index.
 *
 * Two of these replace a MongoDB partial index that the query had to be spelled
 * a particular way to reach: `deleted_at_1` was filtered to `$type: "string"`
 * and `fileinfo_missing_since_1` likewise, and forgetting the clause cost a
 * collection scan over 430,000 documents. SQLite's implication test is textual
 * rather than value-based, so the same discipline applies with different words —
 * which is exactly what makes it worth pinning here rather than trusting a
 * comment.
 *
 * The statements are captured from the repository functions rather than copied
 * into this file. Copying them would let the repo drift into a scan while this
 * suite went on proving something about a string nobody runs.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import type { SqlParams, SqlRow, SqlStatement, SqlWriteResult } from '../sqlite/protocol.ts';
import type { SqliteDb } from './db-handle.ts';
import {
  listAuditCandidatesAfter,
  listDuplicateCandidates,
  listLiveLocationsAfter,
  listMissingTagged,
  listTrashedBefore,
  liveLocationsByDirectory,
} from './assets.sweeps.ts';
import { findRetentionCutoffCursor } from './changes.retention.ts';

/** Every read a repository function issued, in order. */
interface Captured {
  db: SqliteDb;
  reads: SqlStatement[];
}

/**
 * A handle that records what it is asked to read and then answers honestly.
 *
 * Answering for real matters: several of these functions issue a second
 * statement only when the first returned rows, and a stub that always answered
 * `[]` would quietly stop covering them.
 */
function capturing(database: Database): Captured {
  const inner = testSqliteDb(database);
  const reads: SqlStatement[] = [];
  const db: SqliteDb = {
    read: async <T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> => {
      reads.push({ sql, params });
      return inner.read<T>(sql, params);
    },
    write: (sql: string, params?: SqlParams): Promise<SqlWriteResult> => inner.write(sql, params),
    transaction: (statements: readonly SqlStatement[]): Promise<SqlWriteResult[]> =>
      inner.transaction(statements),
  };
  return { db, reads };
}

/** The planner's own description of how it will run a captured statement. */
function planOf(database: Database, statement: SqlStatement): string {
  const params = statement.params === undefined ? [] : [...(statement.params as unknown[])];
  const rows = database
    .query(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...(params as never[])) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join('\n');
}

/** The plan for the first statement a repository function issued. */
async function planFor(
  database: Database,
  run: (db: SqliteDb) => Promise<unknown>,
): Promise<string> {
  const captured = capturing(database);
  await run(captured.db);
  const first = captured.reads[0];
  if (first === undefined) throw new Error('the function issued no read');
  return planOf(database, first);
}

describe('trash-gc — the retention sweep seeks the trashed partial index', () => {
  test('names deleted_at IS NOT NULL, which is what makes assets_trashed usable', async () => {
    using handle = await createTestDatabase();
    const detail = await planFor(handle.db, (db) =>
      listTrashedBefore('2026-01-01T00:00:00.000Z', db),
    );

    // The Mongo query needed `$type: "string"` for the same reason: without a
    // clause the planner can match against the index's own predicate, a daily
    // timer becomes a full table read.
    expect(detail).toContain('assets_trashed');
    expect(detail).not.toContain('SCAN assets');
  });
});

describe('missing-reaper — the tagged-location sweep leads with the partial index', () => {
  test('scans only tagged entries and probes assets per candidate', async () => {
    using handle = await createTestDatabase();
    const detail = await planFor(handle.db, (db) => listMissingTagged({ limit: 10 }, db));

    // `asset_locations_missing` holds only the handful of tagged entries, so
    // leading with it bounds the sweep by the backlog rather than the library.
    expect(detail).toContain('asset_locations_missing');
    expect(detail).not.toContain('SCAN asset_locations');
    // `assets` is reached by primary key, one probe per tagged entry.
    expect(detail).not.toContain('SCAN a');
  });
});

describe('deduplicate — the multi-location backlog is a column test', () => {
  test('reads live_location_count without visiting asset_locations', async () => {
    using handle = await createTestDatabase();
    const detail = await planFor(handle.db, (db) => listDuplicateCandidates(10, db));

    // The Mongo version narrowed on a partial index over `fileinfo.1` and then
    // ran an `$expr`/`$filter` pass over every candidate's array in memory to
    // count the non-tombstoned entries. The trigger-maintained roll-up answers
    // it directly, so the location table is not read at all.
    expect(detail).not.toContain('asset_locations');
  });
});

describe('cache-gc — one library’s live entries seek the scoped partial index', () => {
  test('uses asset_locations_library_live rather than scanning the table', async () => {
    using handle = await createTestDatabase();
    const detail = await planFor(handle.db, (db) => liveLocationsByDirectory('lib-hex', db));

    expect(detail).toContain('asset_locations_library_live');
    expect(detail).not.toContain('SCAN asset_locations');
  });
});

describe('mirror-scan — the keyset walk resumes by primary key', () => {
  test('seeks asset_locations on id rather than counting past an offset', async () => {
    using handle = await createTestDatabase();
    const detail = await planFor(handle.db, (db) => listLiveLocationsAfter(0, 500, db));

    // `id > ?` on an INTEGER PRIMARY KEY is a seek to the resume point, so the
    // last page of a full walk costs the same as the first. An OFFSET page
    // would re-read every row before it.
    expect(detail).toContain('asset_locations USING INTEGER PRIMARY KEY (rowid>?)');
    // No sort: the primary key already delivers the order the walk asked for.
    expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });
});

describe('derivative-audit — the live keyset walk is index-only', () => {
  test('walks assets_live_id, the partial index keyed on id', async () => {
    using handle = await createTestDatabase();
    const detail = await planFor(handle.db, (db) => listAuditCandidatesAfter('', 500, db));

    // A partial index over the live predicate, keyed on `id`: the page is a
    // range scan that never reads a row to test liveness, and the order it
    // yields is the order the keyset resumes on.
    expect(detail).toContain('assets_live_id');
    expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });
});

describe('change-log-gc — the retention bisection probes the primary key', () => {
  test('each probe is a seek, so the search costs its depth and not the journal', async () => {
    using handle = await createTestDatabase();
    handle.db.run(
      `INSERT INTO asset_changes (cursor, kind, at) VALUES (1, 'create', ?), (2, 'create', ?)`,
      ['2020-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'],
    );
    const captured = capturing(handle.db);
    await findRetentionCutoffCursor(new Date('2025-01-01T00:00:00.000Z'), captured.db);
    const plans = captured.reads.map((statement) => planOf(handle.db, statement));
    expect(plans.length).toBeGreaterThan(0);

    // No statement may sort. `cursor` is an INTEGER PRIMARY KEY, so ordering by
    // it is a walk of the b-tree the rows already live in — the two endpoint
    // reads stop at their first row and cost one page each, which is why
    // EXPLAIN calls them a scan and they still are not one. A temp b-tree here
    // would mean the endpoint read materialised and sorted the whole journal,
    // which on 176 million rows is the failure this search exists to avoid.
    for (const detail of plans) expect(detail).not.toContain('TEMP B-TREE');

    // Each bisection probe is a genuine seek to the resume point, so the search
    // costs its depth rather than the journal. After a previous sweep the gaps
    // above a probe are enormous, and this is what keeps stepping over them free.
    const probes = plans.filter((detail) => detail.includes('rowid>'));
    expect(probes.length).toBeGreaterThan(0);
    for (const detail of probes) {
      expect(detail).toContain('SEARCH asset_changes USING INTEGER PRIMARY KEY (rowid>?)');
    }
  });
});
