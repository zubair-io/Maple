/**
 * Core behaviour of the pool: the three primitives, writer serialisation,
 * transaction atomicity, and the in-flight accounting an operator watches.
 *
 * Test shape note — every test does all of its worker round trips first and
 * asserts afterwards. Bun 1.4.3 can drop a worker message when an `expect()`
 * runs between two round trips, so interleaving assertions with awaits makes
 * these tests flaky for a reason that has nothing to do with the pool.
 */

import { afterAll, describe, expect, test } from 'bun:test';

import { cleanupTempDatabases, countingQuery, openTestPool } from './pool.test-helpers.ts';

afterAll(cleanupTempDatabases);

describe('SqlitePool primitives', () => {
  test('writes and reads round-trip, positionally and by name', async () => {
    const pool = await openTestPool();
    try {
      await pool.write('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      const positional = await pool.write('INSERT INTO t (name) VALUES (?)', ['alpha']);
      const named = await pool.write('INSERT INTO t (name) VALUES ($name)', { $name: 'beta' });
      const rows = await pool.read<{ id: number; name: string }>(
        'SELECT id, name FROM t ORDER BY id',
      );
      const filtered = await pool.read<{ name: string }>('SELECT name FROM t WHERE id = ?', [2]);

      expect(positional).toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(named).toEqual({ changes: 1, lastInsertRowid: 2 });
      expect(rows).toEqual([
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ]);
      expect(filtered).toEqual([{ name: 'beta' }]);
    } finally {
      pool.close();
    }
  });

  test('a failing statement rejects with SQLite’s own message', async () => {
    const pool = await openTestPool();
    try {
      const readError = await pool.read('SELECT * FROM missing_table').then(
        () => null,
        (e: Error) => e,
      );
      const writeError = await pool.write('INSERT INTO missing_table VALUES (1)').then(
        () => null,
        (e: Error) => e,
      );
      const stillAlive = await pool.read<{ x: number }>('SELECT 1 AS x');

      expect(readError?.message).toContain('no such table: missing_table');
      expect(writeError?.message).toContain('no such table: missing_table');
      expect(stillAlive).toEqual([{ x: 1 }]);
    } finally {
      pool.close();
    }
  });

  test('readers are read-only, so a stray write cannot reach them', async () => {
    const pool = await openTestPool();
    try {
      await pool.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      const error = await pool.read('INSERT INTO t (id) VALUES (1)').then(
        () => null,
        (e: Error) => e,
      );
      expect(error?.message).toContain('readonly');
    } finally {
      pool.close();
    }
  });

  test('a read on a closed pool throws instead of hanging', async () => {
    const pool = await openTestPool();
    await pool.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    pool.close();

    expect(() => pool.read('SELECT 1')).toThrow(/is closed/);
    expect(() => pool.write('SELECT 1')).toThrow(/is closed/);
    expect(() => pool.transaction([{ sql: 'SELECT 1' }])).toThrow(/is closed/);
  });
});

describe('SqlitePool writer serialisation', () => {
  test('concurrent writes apply in call order and none are lost', async () => {
    const pool = await openTestPool();
    try {
      await pool.write('CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
      await pool.write('INSERT INTO counter (id, n) VALUES (1, 0)');

      const completionOrder: number[] = [];
      await Promise.all(
        Array.from({ length: 50 }, (_unused, index) =>
          pool
            .write('UPDATE counter SET n = n + 1 WHERE id = 1')
            .then(() => completionOrder.push(index)),
        ),
      );
      const [row] = await pool.read<{ n: number }>('SELECT n FROM counter WHERE id = 1');

      // A read-modify-write raced against itself would lose increments; the
      // single writer thread means all 50 land.
      expect(row?.n).toBe(50);
      expect(completionOrder).toEqual(Array.from({ length: 50 }, (_unused, i) => i));
    } finally {
      pool.close();
    }
  });

  test('readers see a write as soon as it is acknowledged', async () => {
    const pool = await openTestPool();
    try {
      await pool.write('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      await pool.write('INSERT INTO t (id, name) VALUES (1, ?)', ['committed']);
      // Each read is routed to a different reader worker, so this also proves
      // every read-only connection sees the writer's WAL commits.
      const first = await pool.read<{ name: string }>('SELECT name FROM t');
      const second = await pool.read<{ name: string }>('SELECT name FROM t');

      expect(first).toEqual([{ name: 'committed' }]);
      expect(second).toEqual([{ name: 'committed' }]);
    } finally {
      pool.close();
    }
  });
});

describe('SqlitePool transactions', () => {
  test('a batch commits as one unit', async () => {
    const pool = await openTestPool();
    try {
      await pool.write('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      const results = await pool.transaction([
        { sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [1, 'one'] },
        { sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [2, 'two'] },
        { sql: 'UPDATE t SET name = ? WHERE id = ?', params: ['ONE', 1] },
      ]);
      const rows = await pool.read<{ id: number; name: string }>('SELECT * FROM t ORDER BY id');

      expect(results).toEqual([
        { changes: 1, lastInsertRowid: 1 },
        { changes: 1, lastInsertRowid: 2 },
        { changes: 1, lastInsertRowid: 2 },
      ]);
      expect(rows).toEqual([
        { id: 1, name: 'ONE' },
        { id: 2, name: 'two' },
      ]);
    } finally {
      pool.close();
    }
  });

  test('a mid-batch failure rolls the whole batch back', async () => {
    const pool = await openTestPool();
    try {
      await pool.write('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      await pool.write('INSERT INTO t (id, name) VALUES (1, ?)', ['before']);

      const error = await pool
        .transaction([
          { sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [2, 'inside'] },
          // Collides with the row inserted above — fails halfway through.
          { sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [1, 'duplicate'] },
          { sql: 'INSERT INTO t (id, name) VALUES (?, ?)', params: [3, 'unreachable'] },
        ])
        .then(
          () => null,
          (e: Error) => e,
        );
      const rows = await pool.read<{ id: number }>('SELECT id FROM t ORDER BY id');
      // The writer must still work: a rollback that left the connection inside
      // a transaction would wedge every later write.
      const after = await pool.write('INSERT INTO t (id, name) VALUES (?, ?)', [9, 'after']);
      const finalRows = await pool.read<{ id: number }>('SELECT id FROM t ORDER BY id');

      expect(error?.message).toContain('UNIQUE');
      expect(rows).toEqual([{ id: 1 }]);
      expect(after.changes).toBe(1);
      expect(finalRows).toEqual([{ id: 1 }, { id: 9 }]);
    } finally {
      pool.close();
    }
  });
});

describe('SqlitePool in-flight accounting', () => {
  test('a backed-up writer queue is visible in stats', async () => {
    const pool = await openTestPool();
    try {
      await pool.write('CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
      await pool.write('INSERT INTO counter (id, n) VALUES (1, 0)');

      const writes = Array.from({ length: 10 }, () =>
        pool.write('UPDATE counter SET n = n + 1 WHERE id = 1'),
      );
      const duringWrites = pool.stats();
      await Promise.all(writes);
      const afterWrites = pool.stats();

      const slowRead = pool.read(countingQuery(1_000_000));
      const duringRead = pool.stats();
      await slowRead;
      const afterRead = pool.stats();

      expect(duringWrites.writer.inFlight).toBe(10);
      expect(duringWrites.inFlight).toBe(10);
      expect(afterWrites.writer.inFlight).toBe(0);
      expect(afterWrites.writer.peakInFlight).toBeGreaterThanOrEqual(10);
      expect(afterWrites.writer.completed).toBeGreaterThanOrEqual(12);
      expect(afterWrites.writer.failed).toBe(0);

      expect(duringRead.readers.reduce((n, r) => n + r.inFlight, 0)).toBe(1);
      expect(afterRead.inFlight).toBe(0);
      expect(afterRead.readers.reduce((n, r) => n + r.completed, 0)).toBeGreaterThanOrEqual(1);
    } finally {
      pool.close();
    }
  });

  test('the pool reports one writer and the requested number of readers', async () => {
    const pool = await openTestPool({ readers: 3 });
    try {
      const stats = pool.stats();
      expect(stats.writer.role).toBe('writer');
      expect(stats.readers.map((r) => r.role)).toEqual(['reader', 'reader', 'reader']);
    } finally {
      pool.close();
    }
  });
});
