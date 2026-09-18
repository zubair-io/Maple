/**
 * Self-test for the SQLite test harness (#3745).
 *
 * A harness whose whole job is isolation is exactly the kind of thing that
 * silently stops doing it — a leak or a shared path only shows up later, as an
 * unrelated suite failing for reasons nobody can reproduce, which is how the
 * Mongo-era pollution (#2491, #2783) presented. So the properties the harness
 * claims are asserted here rather than assumed:
 *
 *  1. Concurrent tests get genuinely separate databases, proven by making them
 *     all insert the SAME primary key while all of them are in flight at once.
 *  2. Disposal happens even when the test body throws.
 *  3. A handle that is never disposed at all still leaves nothing behind once
 *     the process exits.
 *
 * No external service, no mocks: these run against real SQLite databases,
 * in-memory and on disk.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createBlankTestDatabase,
  createTestDatabase,
  insertAsset,
  insertFolder,
  run,
} from './test-sqlite.test-helpers.ts';

/**
 * Blocks until `size` callers have arrived, then releases all of them.
 *
 * This is what turns "these tests are declared concurrent" into evidence. If
 * bun ran them one after another, the first arrival would wait for peers that
 * never come and the barrier would time out with a message naming how many
 * actually made it — a serialised run fails loudly instead of passing while
 * proving nothing.
 */
function createBarrier(size: number, timeoutMs = 5000): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async function arrive(): Promise<void> {
    arrived += 1;
    if (arrived >= size) release();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`barrier timed out: ${arrived} of ${size} tests were in flight`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([gate, expiry]);
    } finally {
      clearTimeout(timer);
    }
  };
}

describe('parallel safety', () => {
  const CONCURRENCY = 8;

  /**
   * The same asset id in every concurrent test. Under one shared database this
   * is a duplicate primary key — the unique-index collision between fixtures
   * that #2491 documents — so a harness that handed two tests the same database
   * would fail here rather than somewhere else later.
   */
  const SHARED_ASSET_ID = '0123456789abcdef01234567';

  const arrive = createBarrier(CONCURRENCY);
  const paths = new Set<string>();

  for (let index = 0; index < CONCURRENCY; index += 1) {
    test.concurrent(`test ${index} sees only its own rows`, async () => {
      using handle = await createTestDatabase('file');
      const db = handle.db;

      expect(paths.has(handle.path)).toBe(false);
      paths.add(handle.path);

      insertAsset(db, { id: SHARED_ASSET_ID });
      insertFolder(db, { slug: `lib-${index}`, path: `/libraries/${index}` });

      // Past this line every one of the tests is inside its `using` block,
      // holding an open database with an identical asset id in it.
      await arrive();
      expect(paths.size).toBe(CONCURRENCY);

      const assets = db.query(`SELECT id FROM assets`).all() as Array<{ id: string }>;
      expect(assets).toEqual([{ id: SHARED_ASSET_ID }]);

      const slugs = (db.query(`SELECT slug FROM folders`).all() as Array<{ slug: string }>).map(
        (row) => row.slug,
      );
      expect(slugs).toEqual([`lib-${index}`]);
    });
  }
});

describe('disposal', () => {
  test('removes the database file when the test body throws', async () => {
    let path = '';
    try {
      using handle = await createTestDatabase('file');
      path = handle.path;
      expect(existsSync(path)).toBe(true);
      throw new Error('an assertion failed');
    } catch (err) {
      expect((err as Error).message).toBe('an assertion failed');
    }

    // The trailing `db.close()` this replaces would have been skipped here.
    expect(path).not.toBe('');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  test('closing twice is not an error', async () => {
    const handle = await createTestDatabase('file');
    handle.close();
    expect(() => handle.close()).not.toThrow();
    expect(existsSync(handle.path)).toBe(false);
  });

  test('a handle that is never disposed leaves nothing behind after the process exits', async () => {
    const helpers = join(import.meta.dir, 'test-sqlite.test-helpers.ts');
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        `const m = await import(${JSON.stringify(helpers)});
         const handle = await m.createTestDatabase('file');
         console.log(handle.path);`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = (await new Response(child.stdout).text()).trim();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('maple-api-testdb-');

    // The child never called close(); the exit sweep did.
    expect(existsSync(stdout)).toBe(false);
    expect(existsSync(dirname(stdout))).toBe(false);
  });
});

describe('storage', () => {
  test('defaults to in-memory', async () => {
    using handle = await createTestDatabase();
    expect(handle.path).toBe(':memory:');
  });

  test('a file-backed database is one a second connection can read', async () => {
    using handle = await createTestDatabase('file');
    const id = insertAsset(handle.db);

    const second = new Database(handle.path);
    try {
      const row = second.query(`SELECT id FROM assets`).get() as { id: string } | null;
      expect(row?.id).toBe(id);
    } finally {
      second.close();
    }
  });
});

describe('schema application', () => {
  test('createTestDatabase applies the full schema', async () => {
    using handle = await createTestDatabase();
    const names = (
      handle.db
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(names).toContain('assets');
    expect(names).toContain('schema_migrations');
  });

  test('createBlankTestDatabase applies the pragmas and nothing else', () => {
    using handle = createBlankTestDatabase();
    const names = (
      handle.db
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual([]);

    // `foreign_keys` is the pragma the schema's every ON DELETE CASCADE
    // depends on, and it is off by default, per connection.
    const foreignKeys = handle.db.query(`PRAGMA foreign_keys`).get() as { foreign_keys: number };
    expect(foreignKeys.foreign_keys).toBe(1);
  });

  test('the handle exposes the same connection the migration runner writes through', async () => {
    using handle = await createTestDatabase();
    await handle.migrationDb.run(`INSERT INTO folders (id, path, slug, label, created_at)
       VALUES ('0123456789abcdef01234567', '/x', 'x', 'X', '2026-01-01T00:00:00.000Z')`);
    run(handle.db, `UPDATE folders SET label = ? WHERE slug = 'x'`, 'Y');
    const row = handle.db.query(`SELECT label FROM folders WHERE slug = 'x'`).get() as {
      label: string;
    };
    expect(row.label).toBe('Y');
  });
});
