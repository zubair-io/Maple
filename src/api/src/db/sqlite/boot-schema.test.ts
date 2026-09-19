/**
 * What a boot does to the database file before the server serves from it.
 *
 * These are the cases the MongoDB removal (#3785) had to add rather than
 * inherit. Until then the migration list was only ever executed by the
 * importer, so deleting the importer without putting the runner somewhere would
 * have meant the next schema change silently never applied to any live library
 * — the failure would have surfaced much later, as a query against a column
 * nothing had added. The second case here is the one that proves it does not.
 *
 * Real files under `os.tmpdir()`, not an in-memory database: half of what is
 * being tested is file creation, and the migration runner's `BEGIN IMMEDIATE`
 * only means anything against a file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchemaAtBoot, SchemaBootError } from './boot-schema.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { fromBunSqlite, runMigrations } from './migrate.ts';

let root = '';
const previousPath = process.env.MAPLE_SQLITE_PATH;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'maple-boot-schema-'));
});

afterEach(async () => {
  if (previousPath === undefined) delete process.env.MAPLE_SQLITE_PATH;
  else process.env.MAPLE_SQLITE_PATH = previousPath;
  await rm(root, { recursive: true, force: true });
});

/** Points the boot at a path under this test's temp directory. */
function pointAt(...segments: string[]): string {
  const path = join(root, ...segments);
  process.env.MAPLE_SQLITE_PATH = path;
  return path;
}

/** The migration ids the file has recorded, oldest first. */
function recorded(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[]).map(
      (row) => row.id,
    );
  } finally {
    db.close();
  }
}

describe('a first boot', () => {
  test('creates the file, its directory, and the whole schema', async () => {
    // The default path is `./data/maple.sqlite`, so on a brand-new install the
    // directory does not exist either. A boot that only created the file would
    // fail on the deployment it matters for.
    const path = pointAt('data', 'maple.sqlite');
    expect(existsSync(path)).toBe(false);

    const outcome = await ensureSchemaAtBoot();

    expect(outcome.created).toBe(true);
    expect(outcome.path).toBe(path);
    expect(outcome.applied).toEqual(ALL_MIGRATIONS.map((m) => m.id));
    expect(existsSync(path)).toBe(true);
  });

  test('leaves an empty library, not a broken one', async () => {
    // The whole reason a first boot is now allowed to serve: an install with no
    // photos yet is an ordinary state, and the tables have to be queryable.
    const path = pointAt('data', 'maple.sqlite');
    await ensureSchemaAtBoot();

    const db = new Database(path, { readonly: true });
    try {
      expect((db.query('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n).toBe(0);
      expect((db.query('SELECT COUNT(*) AS n FROM folders').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  test('puts the file in WAL mode from its first write', async () => {
    // WAL is a persistent property of the file. Setting it on the connection
    // that creates the database means the pool's writer inherits it rather than
    // converting a file that has already been written to.
    const path = pointAt('data', 'maple.sqlite');
    await ensureSchemaAtBoot();

    const db = new Database(path, { readonly: true });
    try {
      const mode = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(mode.journal_mode.toLowerCase()).toBe('wal');
    } finally {
      db.close();
    }
  });
});

describe('a later boot', () => {
  test('does nothing when the schema is current', async () => {
    const path = pointAt('maple.sqlite');
    await ensureSchemaAtBoot();

    const second = await ensureSchemaAtBoot();

    expect(second.created).toBe(false);
    expect(second.applied).toEqual([]);
    expect(recorded(path)).toEqual(ALL_MIGRATIONS.map((m) => m.id));
  });

  test('applies a migration the file has not recorded yet', async () => {
    // The gap this module exists to close. A database carrying only the initial
    // schema — which is every library that came through the cutover — has to
    // pick up everything added since, on the boot after the release that added
    // it, with no operator step.
    const path = pointAt('maple.sqlite');
    const first = ALL_MIGRATIONS[0]!;
    const rest = ALL_MIGRATIONS.slice(1);
    expect(rest.length).toBeGreaterThan(0);

    const seed = new Database(path, { create: true });
    seed.exec('PRAGMA journal_mode = WAL');
    await runMigrations(fromBunSqlite(seed), [first]);
    seed.close();
    expect(recorded(path)).toEqual([first.id]);

    const outcome = await ensureSchemaAtBoot();

    expect(outcome.created).toBe(false);
    expect(outcome.applied).toEqual(rest.map((m) => m.id));
    expect(recorded(path)).toEqual(ALL_MIGRATIONS.map((m) => m.id));
  });
});

describe('a boot that cannot prepare the schema', () => {
  test('refuses, and names the migration that failed', async () => {
    // A half-applied schema is the one case where continuing is worse than
    // stopping: the code above it would write into a shape it does not have.
    // The database here has the initial schema and a `stage_state.media_kind`
    // column, but no record of the migration that adds it — the shape a botched
    // manual repair leaves behind — so the next migration collides.
    const path = pointAt('maple.sqlite');
    await ensureSchemaAtBoot();

    const tampered = new Database(path);
    tampered.run('DELETE FROM schema_migrations WHERE id <> ?', [ALL_MIGRATIONS[0]!.id]);
    tampered.close();

    const failure = await ensureSchemaAtBoot().then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(SchemaBootError);
    expect((failure as Error).message).toContain(path);
    // The runner attaches the offending id to its own error, and the boot keeps
    // it as the cause rather than flattening it away.
    expect(String((failure as Error).cause)).toContain(ALL_MIGRATIONS[1]!.id);
  });

  test('refuses when the path cannot be opened at all', async () => {
    // An existing directory where the file should be: the closest thing to
    // "the operator pointed MAPLE_SQLITE_PATH at the wrong thing" that is
    // reproducible everywhere. The message has to name the variable, because
    // that is the only thing the operator can act on.
    const path = pointAt();
    const failure = await ensureSchemaAtBoot().then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(SchemaBootError);
    expect((failure as Error).message).toContain('MAPLE_SQLITE_PATH');
    expect((failure as Error).message).toContain(path);
  });
});
