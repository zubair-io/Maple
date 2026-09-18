/**
 * The SQLite connection pool: one writer worker, a small set of reader
 * workers, one WAL-mode database file.
 *
 * Read this first if you are wondering why a database needs threads at all.
 * Every in-process SQLite API available to Bun blocks the event loop, the
 * promise-shaped ones included — `Bun.sql` against a `sqlite://` URL is a
 * promise wrapper over the same synchronous engine, and `@libsql/client` only
 * becomes genuinely async against a remote sqld, which reintroduces the server
 * this migration exists to remove. Measured on Bun 1.4.3 with a one-second
 * query, counting 10 ms event-loop ticks: 0 ticks in process, 101 of an
 * expected 114 inside a Worker. The API and the whole worker tier share one
 * process, so an in-process query stalls every concurrent request.
 *
 * Why one writer: SQLite serialises writers regardless, so a second writer
 * connection would buy nothing but SQLITE_BUSY handling. A single writer
 * thread makes the serialisation explicit and ordered — requests are executed
 * in the order they were sent, because the worker's message handler never
 * awaits.
 *
 * Why several readers: WAL lets readers run concurrently with each other and
 * with the writer. A facet count that takes a few hundred milliseconds then
 * cannot delay a grid page behind it.
 *
 * Why it fails closed: `open()` rejects if any worker cannot spawn or cannot
 * open the file, and the pool is unusable afterwards. There is no in-process
 * fallback, because for a database on the request path the fallback would mean
 * blocking the event loop on every query for the lifetime of the process.
 */

import {
  DEFAULT_READER_COUNT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type SqlParams,
  type SqlRow,
  type SqlStatement,
  type SqlWriteResult,
} from './protocol.ts';
import {
  SqliteWorkerHandle,
  spawnDatabaseWorker,
  type SpawnWorker,
  type SqliteWorkerStats,
} from './worker-handle.ts';

export interface SqlitePoolOptions {
  /** Path to the database file. Created by the writer if it does not exist. */
  path: string;
  /** Reader workers to spawn. Defaults to {@link DEFAULT_READER_COUNT}. */
  readers?: number;
  /**
   * How a worker thread is created. Production leaves this alone; it exists so
   * the fail-closed path can be exercised without an unspawnable environment.
   */
  spawnWorker?: SpawnWorker;
  /**
   * How long a single request may go unanswered before the caller is rejected.
   * Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. It is a backstop against a
   * reply that never arrives, not a query deadline — see the constant.
   */
  requestTimeoutMs?: number;
}

/** Queue depth across the pool — what an operator watches during a bulk import. */
export interface SqlitePoolStats {
  writer: SqliteWorkerStats;
  readers: SqliteWorkerStats[];
  /** Requests in flight across every worker. */
  inFlight: number;
}

export class SqlitePool {
  private readonly writer: SqliteWorkerHandle;
  private readonly readers: SqliteWorkerHandle[];
  /** Round-robin cursor, used only to break ties between equally idle readers. */
  private cursor = 0;
  private closed = false;

  private constructor(
    readonly path: string,
    writer: SqliteWorkerHandle,
    readers: SqliteWorkerHandle[],
  ) {
    this.writer = writer;
    this.readers = readers;
  }

  /**
   * Open the database and every worker, or throw. The writer starts first: it
   * creates the file and sets WAL, which the read-only readers then require in
   * order to attach at all. On any failure every worker already spawned is
   * terminated, so a failed startup leaves no orphan threads behind.
   */
  static async open(options: SqlitePoolOptions): Promise<SqlitePool> {
    const readerCount = options.readers ?? DEFAULT_READER_COUNT;
    if (!Number.isInteger(readerCount) || readerCount < 1) {
      throw new Error(`sqlite pool: readers must be a positive integer, got ${readerCount}`);
    }
    const spawn = options.spawnWorker ?? spawnDatabaseWorker;
    const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const writer = new SqliteWorkerHandle('writer', spawn, timeout);
    const readers = Array.from(
      { length: readerCount },
      () => new SqliteWorkerHandle('reader', spawn, timeout),
    );

    try {
      await writer.start(options.path);
      await Promise.all(readers.map((reader) => reader.start(options.path)));
    } catch (e) {
      writer.terminate();
      for (const reader of readers) reader.terminate();
      throw e instanceof Error ? e : new Error(String(e));
    }

    return new SqlitePool(options.path, writer, readers);
  }

  /** Run one statement on a reader and return its rows. */
  read<T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> {
    const closed = this.rejectIfClosed();
    if (closed) return closed as Promise<T[]>;
    const reader = this.leastBusyReader();
    if (!reader) {
      return Promise.reject(
        new Error(
          `sqlite pool: every reader worker for ${this.path} has died — no reader to run on`,
        ),
      );
    }
    return reader.read(sql, params) as Promise<T[]>;
  }

  /** Run one statement on the writer. Writes are executed in call order. */
  write(sql: string, params?: SqlParams): Promise<SqlWriteResult> {
    return this.rejectIfClosed() ?? this.writer.write(sql, params);
  }

  /**
   * Run every statement inside one `BEGIN IMMEDIATE` / `COMMIT` on the writer.
   * A statement that throws rolls the whole batch back and rejects; nothing
   * from the batch is visible to readers afterwards.
   */
  transaction(statements: readonly SqlStatement[]): Promise<SqlWriteResult[]> {
    return this.rejectIfClosed() ?? this.writer.transaction(statements);
  }

  stats(): SqlitePoolStats {
    const writer = this.writer.stats();
    const readers = this.readers.map((reader) => reader.stats());
    return {
      writer,
      readers,
      inFlight: writer.inFlight + readers.reduce((total, r) => total + r.inFlight, 0),
    };
  }

  /** Terminate every worker. In-flight calls reject; later calls throw. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer.terminate();
    for (const reader of this.readers) reader.terminate();
  }

  /**
   * True once {@link close} has run. The process-wide handle in `index.ts`
   * reads this so that closing a pool through the object rather than through
   * `closeSqlitePool()` does not wedge the module: a closed pool holds no
   * threads and no file, so there is nothing left for a reopen to collide with.
   */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Pick the live reader with the shallowest queue, breaking ties by rotating,
   * or null when every reader has died. A plain round-robin would happily hand
   * a second slow facet query to the worker already running one while its
   * neighbour sits idle.
   *
   * Dead readers are skipped before the queue depths are compared, because a
   * dead handle reports zero in flight forever: on depth alone it looks like
   * the idlest worker in the pool, so one crashed thread would attract every
   * subsequent read and turn a 1-in-N failure into a total read outage.
   *
   * A dead reader is left in place rather than respawned. Respawning wants a
   * policy this slice has no caller for — how many attempts, how long to back
   * off, what to do when the environment genuinely cannot spawn a thread — and
   * the honest failure here is a read that rejects while `stats()` shows which
   * worker is gone, not a silent retry loop.
   */
  private leastBusyReader(): SqliteWorkerHandle | null {
    const start = this.cursor % this.readers.length;
    this.cursor = (start + 1) % this.readers.length;
    const rotated = [...this.readers.slice(start), ...this.readers.slice(0, start)];
    const live = rotated.filter((reader) => reader.alive);
    if (live.length === 0) return null;
    return live.reduce((best, reader) => (reader.inFlight < best.inFlight ? reader : best));
  }

  /**
   * A rejected promise when the pool is closed, otherwise null. Rejecting
   * rather than throwing synchronously keeps every failure in this module on
   * the promise channel, so a caller's `.catch()` sees a closed pool the same
   * way it sees a constraint violation.
   */
  private rejectIfClosed(): Promise<never> | null {
    if (!this.closed) return null;
    return Promise.reject(new Error(`sqlite pool: pool for ${this.path} is closed`));
  }
}
