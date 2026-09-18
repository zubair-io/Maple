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
 *  2. Disposal happens even when the test body throws, and even when the
 *     connection itself refuses to close.
 *  3. A handle that is never disposed at all still leaves nothing behind once
 *     the process is over — whether it exited or was killed by a signal.
 *
 * No external service, no mocks: these run against real SQLite databases,
 * in-memory and on disk. Every assertion here is one that has been made to
 * fail on purpose; an assertion about isolation that cannot fail is worse than
 * none, because it reports a confidence nothing earned.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createBlankTestDatabase,
  createTestDatabase,
  insertAsset,
  insertFolder,
  run,
} from './test-sqlite.test-helpers.ts';

interface Barrier {
  /** Blocks until every participant has arrived, or the barrier is abandoned. */
  arrive(): Promise<void>;
  /** Releases everyone still waiting with a failure that names `cause`. */
  abandon(cause: unknown): void;
}

/**
 * Under bun's default `--max-concurrency` of 20 the eight tests are all in
 * flight within milliseconds, so this only ever expires on a run that is not
 * concurrent. It is deliberately below bun's 5s default per-test timeout: at
 * or above it the runner kills the test first and the barrier's own diagnostic
 * is reported as a stray unhandled error instead of as the failure.
 */
const BARRIER_TIMEOUT_MS = 4000;

/**
 * Blocks until `size` callers have arrived, then releases all of them.
 *
 * This is what turns "these tests are declared concurrent" into evidence. If
 * bun ran them one after another, the first arrival would wait for peers that
 * never come and the barrier would time out with a message naming how many
 * actually made it — a serialised run fails loudly instead of passing while
 * proving nothing.
 *
 * {@link Barrier.abandon} is the other half of that: a peer that dies *before*
 * arriving is never coming either, and without a way to say so, one failure
 * becomes `size` failures — the real one plus a full timeout each for everyone
 * left waiting, all reporting the barrier rather than the cause.
 */
function createBarrier(size: number, timeoutMs = BARRIER_TIMEOUT_MS): Barrier {
  let arrived = 0;
  let release!: () => void;
  let abandon!: (reason: Error) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const abandoned = new Promise<never>((_, reject) => {
    abandon = reject;
  });
  // Every test may well pass, in which case nothing ever awaits this promise;
  // an unobserved rejection must not be reported as an unhandled error.
  abandoned.catch(() => {});

  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= size) release();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `barrier timed out: ${arrived} of ${size} tests were in flight. ` +
                  `These tests have to run concurrently to mean anything — a runner ` +
                  `limited below ${size} (bun test --max-concurrency) cannot pass them.`,
              ),
            ),
          timeoutMs,
        );
      });
      try {
        // `gate` first: once it has resolved, an abandonment that arrives
        // afterwards must not fail the tests it was never about.
        await Promise.race([gate, abandoned, expiry]);
      } finally {
        clearTimeout(timer);
      }
    },
    abandon(cause: unknown): void {
      const detail = cause instanceof Error ? cause.message : String(cause);
      abandon(new Error(`a peer test failed before reaching the barrier: ${detail}`, { cause }));
    },
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

  const barrier = createBarrier(CONCURRENCY);
  const paths = new Set<string>();

  for (let index = 0; index < CONCURRENCY; index += 1) {
    test.concurrent(`test ${index} sees only its own rows`, async () => {
      // A test that throws before it reaches the barrier would otherwise
      // strand its seven peers there, and the run would report eight failures
      // — seven of them timeouts naming the barrier — for one cause. Handing
      // the failure to the barrier keeps the peers' failures pointing at it.
      try {
        using handle = await createTestDatabase('file');
        const db = handle.db;

        expect(paths.has(handle.path)).toBe(false);
        paths.add(handle.path);

        insertAsset(db, { id: SHARED_ASSET_ID });
        insertFolder(db, { slug: `lib-${index}`, path: `/libraries/${index}` });

        // Past this line every one of the tests is inside its `using` block,
        // holding an open database with an identical asset id in it.
        await barrier.arrive();
        expect(paths.size).toBe(CONCURRENCY);

        const assets = db.query(`SELECT id FROM assets`).all() as Array<{ id: string }>;
        expect(assets).toEqual([{ id: SHARED_ASSET_ID }]);

        const slugs = (db.query(`SELECT slug FROM folders`).all() as Array<{ slug: string }>).map(
          (row) => row.slug,
        );
        expect(slugs).toEqual([`lib-${index}`]);
      } catch (err) {
        barrier.abandon(err);
        throw err;
      }
    });
  }
});

/**
 * How a child process tells this file which database it made.
 *
 * A prefix rather than "whatever the child printed": `existsSync` of a
 * two-line string is `false` no matter what the sweep did, so treating all of
 * stdout as a path made "the directory is gone" pass whenever anything else
 * reached stdout — including if the sweep had been deleted outright. bun
 * prints to a child's stdout of its own accord (a `bun -e` that installs a
 * package, for one), so that is not hypothetical.
 */
const DB_PATH_PREFIX = 'db-path:';

/** Runs `body` in a child process with the harness imported as `m`. */
function spawnHarnessChild(body: string) {
  const helpers = join(import.meta.dir, 'test-sqlite.test-helpers.ts');
  return Bun.spawn(
    [
      'bun',
      '-e',
      `const m = await import(${JSON.stringify(helpers)});
       const announce = (p) => console.log(${JSON.stringify(DB_PATH_PREFIX)} + ' ' + p);
       const handle = await m.createTestDatabase('file');
       ${body}`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}

/** The one announced path among `lines`, checked before it is used. */
function announcedDatabasePath(lines: string[]): string {
  const announced = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith(DB_PATH_PREFIX));
  expect(announced).toHaveLength(1);
  const path = (announced[0] ?? '').slice(DB_PATH_PREFIX.length).trim();
  expect(path).toStartWith(tmpdir());
  expect(path).toContain('maple-api-testdb-');
  return path;
}

/** Reads a child's stdout only as far as the announcement, for a child that never exits. */
async function readAnnouncedPath(child: ReturnType<typeof spawnHarnessChild>): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      // Only whole lines: a path cut in half by a chunk boundary would fail
      // the prefix check for the wrong reason.
      const complete = buffered.split('\n').slice(0, -1);
      if (complete.some((line) => line.trim().startsWith(DB_PATH_PREFIX))) {
        return announcedDatabasePath(complete);
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`child exited without announcing a path: ${buffered}`);
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

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

  test('a failing close still gives up the files, and can be retried', async () => {
    const handle = await createTestDatabase('file');
    const directory = dirname(handle.path);
    const realClose = handle.db.close.bind(handle.db);
    let refuseToClose = true;
    handle.db.close = (): void => {
      if (refuseToClose) throw new Error('connection refused to close');
      realClose();
    };

    // The cleanup has to survive the throw. It is also what `using` runs, so a
    // close that both throws and skips the cleanup would surface from a test
    // as a SuppressedError hiding that test's real assertion failure.
    expect(() => handle.close()).toThrow('connection refused to close');
    expect(existsSync(directory)).toBe(false);

    refuseToClose = false;
    expect(() => handle.close()).not.toThrow();
  });

  test('a handle that is never disposed leaves nothing behind after the process exits', async () => {
    const child = spawnHarnessChild(`announce(handle.path);`);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const exitCode = await child.exited;
    // Surface the child's own diagnostics rather than a bare exit code, and
    // don't assert stderr is empty — a bun warning there is not this test's
    // subject.
    if (exitCode !== 0) throw new Error(`child exited ${exitCode}: ${stderr}`);
    const path = announcedDatabasePath(stdout.split('\n'));

    // The child never called close(); the exit sweep did.
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  test('a run killed by a signal leaves nothing behind either', async () => {
    // Ctrl-C on a hung suite is how a real run skips `process.on('exit')`, and
    // it is also when a handle is most likely to still be open.
    const child = spawnHarnessChild(`announce(handle.path); await new Promise(() => {});`);
    const path = await readAnnouncedPath(child);
    expect(existsSync(path)).toBe(true);

    child.kill('SIGTERM');
    await child.exited;
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
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
