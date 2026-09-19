/**
 * Migration-runner behaviour: what gets applied, what gets skipped, and what
 * happens when a migration throws halfway through.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  appliedMigrations,
  assertMigrationOrder,
  migrationApplied,
  pendingMigrations,
  runMigrations,
  SCHEMA_MIGRATIONS_TABLE,
  type Migration,
  type MigrationDb,
  type SqlValue,
} from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { createBlankTestDatabase, createTestDatabase } from './test-sqlite.test-helpers.ts';

function tableExists(
  db: { query: (sql: string) => { get: (...a: string[]) => unknown } },
  name: string,
): boolean {
  return db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) != null;
}

describe('runMigrations', () => {
  test('applies every pending migration and records it', async () => {
    using handle = createBlankTestDatabase();
    const migrationDb = handle.migrationDb;
    const result = await runMigrations(migrationDb, ALL_MIGRATIONS);

    expect(result.applied).toEqual(ALL_MIGRATIONS.map((m) => m.id));
    expect(result.skipped).toEqual([]);

    const recorded = await appliedMigrations(migrationDb);
    expect(recorded.map((r) => r.id)).toEqual(ALL_MIGRATIONS.map((m) => m.id));
    for (const row of recorded) {
      expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  test('is idempotent — a second run applies nothing', async () => {
    using handle = createBlankTestDatabase();
    const migrationDb = handle.migrationDb;
    await runMigrations(migrationDb, ALL_MIGRATIONS);

    const second = await runMigrations(migrationDb, ALL_MIGRATIONS);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(ALL_MIGRATIONS.map((m) => m.id));

    // And exactly one sentinel row per migration, not two.
    const rows = await appliedMigrations(migrationDb);
    expect(rows.length).toBe(ALL_MIGRATIONS.length);
  });

  test('a no-op second run takes no write lock at all', async () => {
    using handle = createBlankTestDatabase();
    const { migrationDb } = handle;
    await runMigrations(migrationDb, ALL_MIGRATIONS);

    // Every statement the second run issues, in order.
    const statements: string[] = [];
    const spy: MigrationDb = {
      exec: (sql) => {
        statements.push(sql.trim());
        return migrationDb.exec(sql);
      },
      run: (sql, params) => {
        statements.push(sql.trim());
        return migrationDb.run(sql, params);
      },
      all: <T>(sql: string, params?: readonly SqlValue[]) => {
        statements.push(sql.trim());
        return migrationDb.all<T>(sql, params);
      },
    };

    const second = await runMigrations(spy, ALL_MIGRATIONS);
    expect(second.applied).toEqual([]);

    // The point: the runner reads what has been applied and stops. Taking the
    // write lock per migration would cost one exclusive lock and one fsync per
    // migration per process role on every boot, for nothing.
    expect(statements.filter((sql) => sql.startsWith('BEGIN'))).toEqual([]);
    expect(statements.filter((sql) => sql.startsWith('COMMIT'))).toEqual([]);
  });

  test('creates the sentinel table on a database that has never been touched', async () => {
    using handle = createBlankTestDatabase();
    const { db, migrationDb } = handle;
    expect(tableExists(db, SCHEMA_MIGRATIONS_TABLE)).toBe(false);
    await runMigrations(migrationDb, []);
    expect(tableExists(db, SCHEMA_MIGRATIONS_TABLE)).toBe(true);
  });

  test('applies only the migrations that are missing', async () => {
    using handle = createBlankTestDatabase();
    const { db, migrationDb } = handle;
    const first: Migration = {
      id: '0001-a',
      up: (m) => {
        m.exec('CREATE TABLE a (x)');
      },
    };
    const second: Migration = {
      id: '0002-b',
      up: (m) => {
        m.exec('CREATE TABLE b (x)');
      },
    };

    await runMigrations(migrationDb, [first]);
    const result = await runMigrations(migrationDb, [first, second]);

    expect(result.applied).toEqual(['0002-b']);
    expect(result.skipped).toEqual(['0001-a']);
    expect(tableExists(db, 'b')).toBe(true);
  });

  test('rolls a failing migration back, leaving nothing behind', async () => {
    using handle = createBlankTestDatabase();
    const { db, migrationDb } = handle;
    const good: Migration = {
      id: '0001-good',
      up: (m) => {
        m.exec('CREATE TABLE good (x)');
      },
    };
    const bad: Migration = {
      id: '0002-bad',
      up: (m) => {
        m.exec('CREATE TABLE half_built (x)');
        throw new Error('handler exploded');
      },
    };
    const never: Migration = {
      id: '0003-never',
      up: (m) => {
        m.exec('CREATE TABLE never (x)');
      },
    };

    await expect(runMigrations(migrationDb, [good, bad, never])).rejects.toThrow(
      /0002-bad failed: handler exploded/,
    );

    // The migration before it committed; its own work did not; the one after
    // it never ran.
    expect(tableExists(db, 'good')).toBe(true);
    expect(tableExists(db, 'half_built')).toBe(false);
    expect(tableExists(db, 'never')).toBe(false);

    expect(await migrationApplied(migrationDb, '0001-good')).toBe(true);
    expect(await migrationApplied(migrationDb, '0002-bad')).toBe(false);
  });

  test('a failed migration is retried on the next run', async () => {
    using handle = createBlankTestDatabase();
    const { db, migrationDb } = handle;
    let attempts = 0;
    const flaky: Migration = {
      id: '0001-flaky',
      up: (m) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        m.exec('CREATE TABLE eventually (x)');
      },
    };

    await expect(runMigrations(migrationDb, [flaky])).rejects.toThrow(/transient/);
    const retry = await runMigrations(migrationDb, [flaky]);

    expect(retry.applied).toEqual(['0001-flaky']);
    expect(tableExists(db, 'eventually')).toBe(true);
  });

  test('carries the original error as the cause', async () => {
    using handle = createBlankTestDatabase();
    const migrationDb = handle.migrationDb;
    const original = new Error('root cause');
    const bad: Migration = {
      id: '0001-bad',
      up: () => {
        throw original;
      },
    };

    const caught = await runMigrations(migrationDb, [bad]).catch((err: unknown) => err);
    expect((caught as Error).cause).toBe(original);
  });
});

describe('pendingMigrations', () => {
  test('lists what has not been applied yet', async () => {
    using handle = createBlankTestDatabase();
    const migrationDb = handle.migrationDb;
    const first: Migration = { id: '0001-a', up: () => {} };
    const second: Migration = { id: '0002-b', up: () => {} };

    expect((await pendingMigrations(migrationDb, [first, second])).map((m) => m.id)).toEqual([
      '0001-a',
      '0002-b',
    ]);
    await runMigrations(migrationDb, [first]);
    expect((await pendingMigrations(migrationDb, [first, second])).map((m) => m.id)).toEqual([
      '0002-b',
    ]);
  });
});

describe('assertMigrationOrder', () => {
  test('accepts an ascending, unique list', () => {
    expect(() =>
      assertMigrationOrder([
        { id: '0001-a', up: () => {} },
        { id: '0002-b', up: () => {} },
        { id: '0010-c', up: () => {} },
      ]),
    ).not.toThrow();
  });

  test('rejects a duplicate id', () => {
    expect(() =>
      assertMigrationOrder([
        { id: '0001-a', up: () => {} },
        { id: '0001-a', up: () => {} },
      ]),
    ).toThrow(/duplicate migration id: 0001-a/);
  });

  test('rejects a migration inserted above one that already shipped', () => {
    expect(() =>
      assertMigrationOrder([
        { id: '0002-b', up: () => {} },
        { id: '0001-a', up: () => {} },
      ]),
    ).toThrow(/ascending order/);
  });

  test('rejects an empty id', () => {
    expect(() => assertMigrationOrder([{ id: '', up: () => {} }])).toThrow(/must not be empty/);
  });

  test('guards the shipped list', () => {
    expect(() => assertMigrationOrder(ALL_MIGRATIONS)).not.toThrow();
  });
});

describe('the migrated schema', () => {
  test('creates every table the API needs', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const names = (
      db
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    for (const expected of [
      'assets',
      'asset_locations',
      'asset_detail',
      'asset_phasset_links',
      'asset_search',
      'assets_fts',
      'stage_state',
      'enrichment_state',
      'faces',
      'people',
      'folders',
      'asset_changes',
      'users',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test('replaces the 24 per-stage indexes with a set that does not grow', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const stageIndexes = (
      db
        .query(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='stage_state' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    // Four, and none of them per-stage: the claim scan, the dead-letter list,
    // the claim scan for a stage narrowed to video or audio (#3795), and the
    // dependency probe the backlog counts lean on (#3804). Registering a stage
    // is still an insert rather than two more indexes, which is the property
    // the count is here to protect.
    expect(stageIndexes.sort()).toEqual([
      'stage_claim',
      'stage_claim_media',
      'stage_dead',
      'stage_dep',
    ]);
  });
});

/**
 * The upgrade path, which is the one a live library actually takes.
 *
 * Every other test here migrates an empty database, where a backfill has
 * nothing to do and cannot be wrong. `0002` shipped after the cutover, so the
 * only database that matters already had rows in it — and the rows it has to
 * find are the minority ones.
 */
describe('0002 on a database that already carries 0001', () => {
  test('backfills the media kind onto the stage rows that were already there', async () => {
    using handle = createBlankTestDatabase();
    const { db, migrationDb } = handle;
    await runMigrations(migrationDb, [ALL_MIGRATIONS[0]!]);

    const asset = 'a'.repeat(24);
    db.run(
      `INSERT INTO assets (id, size, mtime, indexed_at, media_kind)
       VALUES (?, 1, 1, '2026-01-01T00:00:00Z', 'video')`,
      [asset],
    );
    db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, 'transcribe')`, [asset]);
    // No column to read yet — that is the state the migration starts from.
    expect(
      (
        db.query(`SELECT name FROM pragma_table_info('stage_state')`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    ).not.toContain('media_kind');

    await runMigrations(migrationDb, ALL_MIGRATIONS);

    const row = db.query(`SELECT media_kind FROM stage_state WHERE asset_id = ?`).get(asset) as {
      media_kind: string;
    };
    expect(row.media_kind).toBe('video');
  });

  test('leaves the triggers in charge afterwards', async () => {
    using handle = createBlankTestDatabase();
    const { db, migrationDb } = handle;
    await runMigrations(migrationDb, ALL_MIGRATIONS);

    const asset = 'b'.repeat(24);
    db.run(
      `INSERT INTO assets (id, size, mtime, indexed_at, media_kind)
       VALUES (?, 1, 1, '2026-01-01T00:00:00Z', 'image')`,
      [asset],
    );
    db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, 'transcribe')`, [asset]);
    db.run(`UPDATE assets SET media_kind = 'audio' WHERE id = ?`, [asset]);

    const row = db.query(`SELECT media_kind FROM stage_state WHERE asset_id = ?`).get(asset) as {
      media_kind: string;
    };
    expect(row.media_kind).toBe('audio');
  });
});

/**
 * `0003`'s upgrade path, which has one more way to be wrong than `0002`'s.
 *
 * The backfill has to find rows that already exist AND rebuild two indexes that
 * already exist, in an order where each step can still see what it needs: the
 * backfill's first statement reads `asset_claimable` through `stage_claim`, so
 * the index has to carry the column by then, and the triggers have to arrive
 * last or the backfill becomes a per-row write (#3804).
 */
describe('0003 on a database that already carries 0001 and 0002', () => {
  /** One live asset and one soft-deleted one, each with a stage row. */
  function seedTwoAssets(db: Database): { live: string; trashed: string } {
    const live = 'c'.repeat(24);
    const trashed = 'd'.repeat(24);
    for (const id of [live, trashed]) {
      db.run(
        `INSERT INTO assets (id, size, mtime, indexed_at, live_location_count)
         VALUES (?, 1, 1, '2026-01-01T00:00:00Z', 1)`,
        [id],
      );
      db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, 'exif')`, [id]);
    }
    db.run(`UPDATE assets SET deleted_at = '2026-02-01T00:00:00Z' WHERE id = ?`, [trashed]);
    return { live, trashed };
  }

  const claimableOf = (db: Database, id: string): number =>
    (
      db.query(`SELECT asset_claimable FROM stage_state WHERE asset_id = ?`).get(id) as {
        asset_claimable: number;
      }
    ).asset_claimable;

  test('backfills the mirror onto the stage rows that were already there', async () => {
    using handle = createBlankTestDatabase();
    const { db, migrationDb } = handle;
    await runMigrations(migrationDb, ALL_MIGRATIONS.slice(0, 2));
    const { live, trashed } = seedTwoAssets(db);

    // No column to read yet — that is the state the migration starts from.
    expect(
      (
        db.query(`SELECT name FROM pragma_table_info('stage_state')`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    ).not.toContain('asset_claimable');

    await runMigrations(migrationDb, ALL_MIGRATIONS);

    expect(claimableOf(db, live)).toBe(1);
    expect(claimableOf(db, trashed)).toBe(0);
  });

  test('leaves the triggers in charge afterwards', async () => {
    using handle = createBlankTestDatabase();
    const { db, migrationDb } = handle;
    await runMigrations(migrationDb, ALL_MIGRATIONS.slice(0, 2));
    const { live } = seedTwoAssets(db);
    await runMigrations(migrationDb, ALL_MIGRATIONS);

    db.run(`UPDATE assets SET damaged_since = '2026-03-01T00:00:00Z' WHERE id = ?`, [live]);
    expect(claimableOf(db, live)).toBe(0);
  });
});
