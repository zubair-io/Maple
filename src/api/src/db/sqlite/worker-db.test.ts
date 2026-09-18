/**
 * The clustering worker's database handle (#3749).
 *
 * The property under test is the one the ticket calls out: a second thread that
 * needs both embeddings and writes must not become a second SQLite writer.
 * These tests drive both halves of the boundary through a plain object rather
 * than a real thread, so what is being checked is the arrangement itself —
 * which connection is opened in what mode, and where each statement ends up —
 * rather than whether Bun can spawn a Worker. The real worker is exercised in
 * `repos/people.cluster-pool.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestDatabase } from './test-sqlite.test-helpers.ts';
import { testDb } from './repos/people.test-helpers.ts';
import { createWorkerDb, serveWorkerDbRequests, type MessageChannelLike } from './worker-db.ts';
import type { SqlStatement, SqlWriteResult } from './protocol.ts';
import type { SqliteDb } from './repos/db-handle.ts';

/** One end of a two-way channel: what it sends goes to the other end's listeners. */
class FakeEnd implements MessageChannelLike {
  private listeners: Array<(event: MessageEvent) => void> = [];
  peer: FakeEnd | null = null;
  /** Every message this end has sent, for asserting on what crossed. */
  readonly sent: unknown[] = [];

  postMessage(message: unknown): void {
    this.sent.push(message);
    const peer = this.peer;
    // Delivered on a later macrotask, the way a real `postMessage` is — a
    // synchronous hand-off would let these tests pass on an implementation that
    // deadlocks against a real Worker.
    setImmediate(() => {
      for (const listener of [...peer!.listeners]) {
        listener({ data: message } as MessageEvent);
      }
    });
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((entry) => entry !== listener);
  }
}

function channelPair(): { host: FakeEnd; worker: FakeEnd } {
  const host = new FakeEnd();
  const worker = new FakeEnd();
  host.peer = worker;
  worker.peer = host;
  return { host, worker };
}

describe('createWorkerDb', () => {
  test('opens its own connection read-only, so a write on it cannot succeed', async () => {
    using handle = await createTestDatabase('file');
    const { host, worker } = channelPair();
    serveWorkerDbRequests(host, testDb(handle.db));
    const db = createWorkerDb(handle.path, worker);

    // `read` is the only path that touches the worker's own connection. Sending
    // a write down it is how a future change would accidentally reintroduce a
    // second writer, and SQLite is what refuses — not a check in our code.
    const attempt = db.read(`INSERT INTO people (id, name, created_at, updated_at)
                             VALUES ('aaaaaaaaaaaaaaaaaaaaaaaa', 'Nope', '', '')`);
    await expect(attempt).rejects.toThrow(/readonly|read-only/i);

    const rows = handle.db.query('SELECT COUNT(*) AS n FROM people').get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  test('sends writes to the host, which runs them on the pool handle', async () => {
    using handle = await createTestDatabase('file');
    const { host, worker } = channelPair();

    // Count what the host actually executes, so "the write went to the pool" is
    // observed rather than inferred from the row appearing.
    const executed: string[] = [];
    const counting: SqliteDb = {
      read: (sql, params) => testDb(handle.db).read(sql, params),
      write: (sql, params) => {
        executed.push(sql);
        return testDb(handle.db).write(sql, params);
      },
      transaction: (statements) => {
        executed.push(...statements.map((statement) => statement.sql));
        return testDb(handle.db).transaction(statements);
      },
    };
    serveWorkerDbRequests(host, counting);
    const db = createWorkerDb(handle.path, worker);

    const result = await db.write(
      `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      ['bbbbbbbbbbbbbbbbbbbbbbbb', 'Ada', 'now', 'now'],
    );

    expect(result.changes).toBe(1);
    expect(executed).toHaveLength(1);
    const row = handle.db
      .query('SELECT name FROM people WHERE id = ?')
      .get('bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(row).toEqual({ name: 'Ada' });
    db.close();
  });

  test('a read after an awaited write observes it — the recompute then reload path', async () => {
    using handle = await createTestDatabase('file');
    const { host, worker } = channelPair();
    serveWorkerDbRequests(host, testDb(handle.db));
    const db = createWorkerDb(handle.path, worker);

    // This is exactly what `recomputeCentroids` → `loadCentroids` depends on:
    // the write lands through the host, and the very next query on the worker's
    // own read-only connection has to see it. If it did not, the clustering
    // pass would seed from stale centroids and produce different assignments.
    await db.write(`INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, [
      'cccccccccccccccccccccccc',
      'Grace',
      'now',
      'now',
    ]);
    const seen = await db.read<{ name: string }>('SELECT name FROM people WHERE id = ?', [
      'cccccccccccccccccccccccc',
    ]);

    expect(seen).toEqual([{ name: 'Grace' }]);
    db.close();
  });

  test('a transaction crosses as one batch and is applied atomically', async () => {
    using handle = await createTestDatabase('file');
    const { host, worker } = channelPair();
    const batches: number[] = [];
    const recording: SqliteDb = {
      read: (sql, params) => testDb(handle.db).read(sql, params),
      write: (sql, params) => testDb(handle.db).write(sql, params),
      transaction: (statements: readonly SqlStatement[]): Promise<SqlWriteResult[]> => {
        batches.push(statements.length);
        return testDb(handle.db).transaction(statements);
      },
    };
    serveWorkerDbRequests(host, recording);
    const db = createWorkerDb(handle.path, worker);

    const insert = `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, 'n', 'n')`;
    // The second statement violates the case-insensitive unique name index, so
    // the batch must roll back whole rather than leave the first row behind.
    const rejected = db.transaction([
      { sql: insert, params: ['dddddddddddddddddddddddd', 'Alan'] },
      { sql: insert, params: ['eeeeeeeeeeeeeeeeeeeeeeee', 'ALAN'] },
    ]);
    await expect(rejected).rejects.toThrow();

    expect(batches).toEqual([2]);
    const count = handle.db.query('SELECT COUNT(*) AS n FROM people').get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });

  test('a failure on the host comes back as a rejection, not a hang', async () => {
    using handle = await createTestDatabase('file');
    const { host, worker } = channelPair();
    serveWorkerDbRequests(host, testDb(handle.db));
    const db = createWorkerDb(handle.path, worker);

    await expect(db.write('UPDATE nonexistent_table SET x = 1')).rejects.toThrow(
      /nonexistent_table/,
    );
    db.close();
  });

  test('several round trips in a row all settle', async () => {
    using handle = await createTestDatabase('file');
    const { host, worker } = channelPair();
    serveWorkerDbRequests(host, testDb(handle.db));
    const db = createWorkerDb(handle.path, worker);

    // A clustering pass makes one write round trip per chunk and then reads, so
    // "the second round trip also completes" is the property. Bun 1.4.3 drops a
    // Worker message when a previous round trip settled synchronously inside
    // the listener, which is why both sides defer by a macrotask; the
    // assertions are collected and checked at the end rather than interleaved,
    // because an `expect` between round trips is the documented trigger.
    const names = ['one', 'two', 'three', 'four'];
    const changes: number[] = [];
    for (const [index, name] of names.entries()) {
      const result = await db.write(
        `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, 'n', 'n')`,
        [`${index}`.repeat(24), name],
      );
      changes.push(result.changes);
    }
    const stored = await db.read<{ n: number }>('SELECT COUNT(*) AS n FROM people');

    expect(changes).toEqual([1, 1, 1, 1]);
    expect(stored[0]?.n).toBe(4);
    db.close();
  });
});

describe('the worker connection is a reader, not a writer', () => {
  test('a second read-write connection would be a second writer — this one is not', async () => {
    using handle = await createTestDatabase('file');

    // What the Mongo worker's pattern translates to, spelled out: a read-write
    // connection of its own. It works, which is exactly the problem — nothing
    // stops it, so the guarantee has to come from opening read-only instead.
    const rogue = new Database(handle.path);
    rogue.run(
      `INSERT INTO people (id, name, created_at, updated_at) VALUES ('ffffffffffffffffffffffff', 'Rogue', 'n', 'n')`,
    );
    rogue.close();
    const afterRogue = handle.db.query('SELECT COUNT(*) AS n FROM people').get() as { n: number };
    expect(afterRogue.n).toBe(1);

    // The handle this slice actually uses cannot do that.
    const { host, worker } = channelPair();
    serveWorkerDbRequests(host, testDb(handle.db));
    const db = createWorkerDb(handle.path, worker);
    await expect(
      db.read(
        `INSERT INTO people (id, name, created_at, updated_at) VALUES ('111111111111111111111111', 'Nope', 'n', 'n')`,
      ),
    ).rejects.toThrow(/readonly|read-only/i);
    db.close();
  });
});
