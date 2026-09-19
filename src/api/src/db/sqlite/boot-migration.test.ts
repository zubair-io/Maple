/**
 * The cutover's boot behaviour, driven end to end against a real MongoDB
 * (#3752).
 *
 * Each of the issue's exit criteria gets a test: a first boot migrates, a
 * second boot skips, an interrupted boot resumes and converges, and a boot that
 * cannot reach the source refuses rather than serving an empty library. The
 * last one is the important one — an empty library is what the File Provider
 * clients would act on.
 *
 * Uses the throwaway mongod on :27077 the rest of the importer suite uses, and
 * skip-passes when it is not running. The one exception is the schema-migration
 * test, which needs no source at all — it is the boot every install that has
 * already cut over now takes, and #3785 deletes the source it must not need.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MongoClient } from 'mongodb';
import { BootMigrationError, migrateAtBoot, sqliteDatabasePath } from './boot-migration.ts';
import { SCHEMA_PRAGMAS } from './ddl/index.ts';
import { fromBunSqlite, runMigrations } from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { initialSchemaMigration } from './migrations/0001-initial-schema.ts';
import { closeImportSession, openImportSession, runImportOn } from './import/run.ts';
import { connectTestMongo, seedLibrary, TEST_MONGO_URI } from './import/seed.test-helpers.ts';

const DB_NAME = `maple_boot_migration_${process.pid}`;

let client: MongoClient | null = null;
let workDir = '';

const saved = {
  sqlitePath: process.env.MAPLE_SQLITE_PATH,
  mongoUri: process.env.MAPLE_MONGO_URI,
  mongoDb: process.env.MAPLE_MONGO_DB,
};

/** Points the boot at a fresh database file and the test's source. */
function bootAgainst(file: string, mongoUri: string = TEST_MONGO_URI): string {
  const path = join(workDir, file);
  process.env.MAPLE_SQLITE_PATH = path;
  process.env.MAPLE_MONGO_URI = mongoUri;
  process.env.MAPLE_MONGO_DB = DB_NAME;
  return path;
}

function rowCount(path: string, table: string): number {
  const db = new Database(path, { readonly: true });
  const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  db.close();
  return row.n;
}

/** The migration ids this database has recorded, in order. */
function appliedMigrations(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db.query(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: string }>
    ).map((row) => row.id);
  } finally {
    db.close();
  }
}

function cutoverMarker(path: string): string | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query(`SELECT value FROM server_state WHERE id = 'sqlite_cutover'`).get() as {
      value: string | null;
    } | null;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  client = await connectTestMongo();
  if (client === null) return;
  await client.db(DB_NAME).dropDatabase();
  await seedLibrary(client.db(DB_NAME));
  workDir = mkdtempSync(join(tmpdir(), 'maple-boot-migration-'));
}, 60_000);

afterAll(async () => {
  if (client !== null) {
    await client.db(DB_NAME).dropDatabase();
    await client.close();
  }
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const [key, value] of [
    ['MAPLE_SQLITE_PATH', saved.sqlitePath],
    ['MAPLE_MONGO_URI', saved.mongoUri],
    ['MAPLE_MONGO_DB', saved.mongoDb],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the database path', () => {
  it('comes from the environment, and has a default that needs no configuration', () => {
    delete process.env.MAPLE_SQLITE_PATH;
    expect(sqliteDatabasePath()).toBe('./data/maple.sqlite');
    process.env.MAPLE_SQLITE_PATH = '/srv/maple/library.sqlite';
    expect(sqliteDatabasePath()).toBe('/srv/maple/library.sqlite');
  });
});

describe('a boot onto a database that has already cut over', () => {
  it('applies the schema migrations that shipped since (#3768)', async () => {
    // No MongoDB needed, and deliberately so: this is the boot every existing
    // install now takes, and it must not depend on a source that #3785 deletes.
    //
    // The shape is the one production was in the day after the cutover — the
    // marker set, the data present, and a migration list that has grown since.
    // Before #3768 nothing ran the list on this branch, so the server would
    // open the pool and then fail on the first query naming a column
    // `0002-facet-state` was meant to add.
    const path = join(mkdtempSync(join(tmpdir(), 'maple-boot-schema-')), 'cutover.sqlite');
    process.env.MAPLE_SQLITE_PATH = path;
    const seed = new Database(path, { create: true });
    for (const pragma of SCHEMA_PRAGMAS) seed.exec(pragma);
    await runMigrations(fromBunSqlite(seed), [initialSchemaMigration]);
    seed.run(`INSERT INTO server_state (id, value) VALUES ('sqlite_cutover', ?)`, [
      '2026-09-19T00:00:00.000Z',
    ]);
    seed.close();

    expect(appliedMigrations(path)).toEqual(['0001-initial-schema']);
    expect(await migrateAtBoot()).toEqual({
      status: 'already-migrated',
      completedAt: '2026-09-19T00:00:00.000Z',
    });

    expect(appliedMigrations(path)).toEqual(ALL_MIGRATIONS.map((migration) => migration.id));
    // And the thing the migration is for is actually there.
    expect(rowCount(path, 'asset_subjects')).toBe(0);
    rmSync(path, { force: true });
  });
});

describe('the first boot', () => {
  it('migrates a populated source into an absent database, and records that it did', async () => {
    if (client === null) return;
    const path = bootAgainst('first.sqlite');
    expect(existsSync(path)).toBe(false);

    const outcome = await migrateAtBoot();

    expect(outcome.status).toBe('migrated');
    if (outcome.status !== 'migrated') return;
    expect(outcome.assets).toBeGreaterThan(0);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);

    // The library is there, and so is the marker the next boot reads.
    expect(rowCount(path, 'assets')).toBe(outcome.assets);
    expect(cutoverMarker(path)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 120_000);
});

describe('the second boot', () => {
  it('skips the migration and never touches the source', async () => {
    if (client === null) return;
    const path = bootAgainst('second.sqlite');
    const first = await migrateAtBoot();
    expect(first.status).toBe('migrated');
    const assets = rowCount(path, 'assets');

    // A source that cannot be reached at all. A boot that still needed to
    // migrate would fail on it; this one must not look.
    process.env.MAPLE_MONGO_URI = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=250';
    const second = await migrateAtBoot();

    expect(second.status).toBe('already-migrated');
    expect(rowCount(path, 'assets')).toBe(assets);
  }, 120_000);
});

describe('an interrupted boot', () => {
  it('resumes from where it stopped and converges on a complete library', async () => {
    if (client === null) return;
    const path = bootAgainst('interrupted.sqlite');

    // Kill a run part-way through the assets: some batches committed, the rest
    // never read. This is what a restart during the cutover leaves behind.
    const partial = {
      mongoUri: TEST_MONGO_URI,
      mongoDb: DB_NAME,
      sqlitePath: path,
      batchSize: 1,
      changesWindow: 'all' as const,
      verifySample: 25,
      restart: false,
    };
    const session = await openImportSession(partial);
    try {
      await runImportOn(session, {
        ...partial,
        onProgress(progress) {
          if (progress.source === 'assets' && progress.documentsDone >= 2) {
            throw new Error('simulated restart');
          }
        },
      });
      throw new Error('the interrupted run was expected to throw');
    } catch (err) {
      expect(String(err)).toContain('simulated restart');
    } finally {
      await closeImportSession(session);
    }

    // Half-built, and deliberately not marked — a boot must not serve it.
    expect(cutoverMarker(path)).toBeNull();
    const halfway = rowCount(path, 'assets');

    const outcome = await migrateAtBoot();

    expect(outcome.status).toBe('migrated');
    if (outcome.status !== 'migrated') return;
    expect(outcome.assets).toBeGreaterThan(halfway);
    expect(cutoverMarker(path)).not.toBeNull();

    // The same library a clean run produces, not merely a self-consistent one.
    const cleanPath = join(workDir, 'interrupted-control.sqlite');
    const control = await openImportSession({ ...partial, sqlitePath: cleanPath, restart: true });
    try {
      await runImportOn(control, { ...partial, sqlitePath: cleanPath, restart: true });
    } finally {
      await closeImportSession(control);
    }
    expect(rowCount(path, 'assets')).toBe(rowCount(cleanPath, 'assets'));
    expect(rowCount(path, 'asset_locations')).toBe(rowCount(cleanPath, 'asset_locations'));
    expect(rowCount(path, 'faces')).toBe(rowCount(cleanPath, 'faces'));
  }, 180_000);
});

describe('a boot that cannot migrate', () => {
  it('refuses with an actionable message rather than serving an empty library', async () => {
    const path = bootAgainst(
      'unreachable.sqlite',
      'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=250',
    );

    const failure = await migrateAtBoot().then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(BootMigrationError);
    expect(String(failure)).toContain('not reachable');
    // It names what to do, not just what broke.
    expect(String(failure)).toContain('restart the server');

    // And nothing was marked, so the next boot tries again rather than
    // deciding an empty database is the library.
    expect(cutoverMarker(path)).toBeNull();
  }, 60_000);
});
