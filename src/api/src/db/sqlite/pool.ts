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
 * How many readers, and why it is not a constant: a pool of N tolerates N−1
 * sustained long reads and collapses at N. That is a cliff rather than a slope,
 * and the hardcoded 2 sat one step from it — which is how a single CPU-hungry
 * stage claim (#3795) became a total read outage rather than a slowdown. The
 * default now scales with the box and an operator can widen it without a
 * deploy; `protocol.ts` has the numbers and `scripts/sqlite-bench/reader-pool.ts`
 * reproduces them.
 *
 * Why a dead reader comes back: the same cliff. Losing one reader does not cost
 * 1/N of the read capacity, it moves the pool one step closer to the edge, and
 * on the pool of two that shipped it went straight over — measured at 203,541
 * request-path reads in four seconds before, 32 after. So a dead reader is
 * respawned on a bounded ladder rather than left as a permanent loss that only
 * a process restart repairs (#3782).
 *
 * Why the writer does not: it is single by design, and resurrecting it is not
 * the same question. Every write outstanding when it died was rejected, and
 * their callers have had a failure they may or may not have acted on; a new
 * writer would start accepting work as though the ordering those callers were
 * promised still held. Readers have no such problem — a read that failed is
 * just a read that failed. #3782 is about readers, and so is this.
 *
 * Why it fails closed: `open()` rejects if any worker cannot spawn or cannot
 * open the file, and the pool is unusable afterwards. There is no in-process
 * fallback, because for a database on the request path the fallback would mean
 * blocking the event loop on every query for the lifetime of the process. That
 * is startup only. A pool that is already serving degrades instead — see
 * `respawnReader`.
 */

import {
  defaultReaderCount,
  DEFAULT_REQUEST_TIMEOUT_MS,
  readerCountFromEnvironment,
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
import { retryOnBusy } from './busy-retry.ts';

/**
 * Backoff sleep. Unref'd for the same reason the request timer is: a pool
 * waiting to respawn a reader must not be the thing keeping a process alive
 * that is otherwise finished.
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/**
 * How wide this pool will be: what the caller asked for, else the operator's
 * `MAPLE_SQLITE_READERS`, else a count scaled from the box.
 *
 * Throws on anything it cannot honour, including an unparseable override, so a
 * mis-sized pool never starts quietly at some other width — the sizing is the
 * difference between a slow query and a read outage, and an operator who
 * widened the pool during an incident has to be able to trust that it took.
 */
function resolveReaderCount(requested: number | undefined): number {
  const readers = requested ?? readerCountFromEnvironment() ?? defaultReaderCount();
  if (!Number.isInteger(readers) || readers < 1) {
    throw new Error(`sqlite pool: readers must be a positive integer, got ${readers}`);
  }
  return readers;
}

export interface SqlitePoolOptions {
  /** Path to the database file. Created by the writer if it does not exist. */
  path: string;
  /**
   * Reader workers to spawn. Defaults to the operator's `MAPLE_SQLITE_READERS`
   * override, then to {@link defaultReaderCount}, which scales with the box.
   *
   * A caller that passes this is saying it knows better than both — which one
   * does: the lens-profile cache opens a pool of its own for a single lookup
   * and asks for one reader.
   */
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
  /**
   * Told whenever a reader dies and the pool acts on it.
   *
   * The pool cannot log this itself. Anything `pool.ts` imports is loaded
   * inside a `Worker` thread — the clustering worker reaches it through
   * `worker-db.ts` — and importing pino there wedges the thread: it never
   * answers its first message. `busy-retry.ts` has the measurement. So the log
   * line lives with whoever opened the pool, which in production is the process
   * boot (`pool-logging.ts` supplies the callback).
   */
  onReaderRespawn?: (event: ReaderRespawnEvent) => void;
  /**
   * The respawn backoff ladder. Production leaves this alone; it exists so the
   * end of the ladder can be exercised without a twelve-second test, the same
   * reason {@link spawnWorker} exists.
   */
  respawnDelaysMs?: readonly number[];
}

/** What the pool did about a dead reader, for whoever is holding the logger. */
export interface ReaderRespawnEvent {
  /** Which reader slot, 0-based — the index into {@link SqlitePoolStats.readers}. */
  reader: number;
  /** Which attempt on the current ladder this was, 1-based. */
  attempt: number;
  outcome:
    | /** The reader is back and taking reads again. */ 'respawned'
    | /** This attempt failed; another is scheduled. */ 'failed'
    | /** The ladder is spent. The slot stays dead for the life of the process. */ 'retired';
  /** Why the reader died, or why this respawn attempt failed. */
  reason: string;
}

/**
 * Backoff before each respawn attempt. Four attempts spanning ~12.6 seconds.
 *
 * The first is short because the likeliest death is a one-off — an uncaught
 * throw, a query that ran the thread out of memory — and a reader that is back
 * inside 100 ms costs the request path nothing. The ladder then escalates so
 * that a reader which cannot come back is not respawned in a tight loop for
 * months.
 *
 * Spending the whole ladder is what distinguishes the two failures the issue
 * asks to be told apart, and it needs no second policy to do it: a worker that
 * cannot open the database never completes a request, so it never earns the
 * reset below and burns all four attempts in about twelve seconds. A reader
 * that dies transiently comes back, serves, and starts each later death with a
 * fresh ladder.
 */
const RESPAWN_DELAYS_MS = [100, 500, 2_000, 10_000] as const;

/** Per-slot respawn bookkeeping. One of these per reader, for the pool's life. */
interface ReaderRespawnState {
  /** A ladder is running; a second death must not start a second one. */
  inFlight: boolean;
  /** How far up {@link RESPAWN_DELAYS_MS} this slot has climbed. */
  attempt: number;
  /** The slot's `completed` count when it last came back — the reset trigger. */
  completedAtRestart: number;
  /** The ladder was spent. This slot is never retried again. */
  retired: boolean;
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
  private readonly respawns: ReaderRespawnState[];
  private readonly onReaderRespawn: (event: ReaderRespawnEvent) => void;
  private readonly respawnDelaysMs: readonly number[];
  /** Round-robin cursor, used only to break ties between equally idle readers. */
  private cursor = 0;
  private closed = false;

  private constructor(
    readonly path: string,
    writer: SqliteWorkerHandle,
    readers: SqliteWorkerHandle[],
    onReaderRespawn: (event: ReaderRespawnEvent) => void,
    respawnDelaysMs: readonly number[],
  ) {
    this.writer = writer;
    this.readers = readers;
    this.onReaderRespawn = onReaderRespawn;
    this.respawnDelaysMs = respawnDelaysMs;
    this.respawns = readers.map(() => ({
      inFlight: false,
      attempt: 0,
      completedAtRestart: 0,
      retired: false,
    }));
  }

  /**
   * Open the database and every worker, or throw. The writer starts first: it
   * creates the file and sets WAL, which the read-only readers then require in
   * order to attach at all. On any failure every worker already spawned is
   * terminated, so a failed startup leaves no orphan threads behind.
   */
  static async open(options: SqlitePoolOptions): Promise<SqlitePool> {
    const readerCount = resolveReaderCount(options.readers);
    const spawn = options.spawnWorker ?? spawnDatabaseWorker;
    const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const writer = new SqliteWorkerHandle('writer', spawn, timeout);
    // The readers' death hook needs the pool, which needs the readers. Until
    // the pool exists this resolves to null, and that is the correct answer: a
    // death before `open` returns is a failed startup, which fails closed
    // rather than respawning its way to a pool nobody asked for.
    let pool: SqlitePool | null = null;
    const readers = Array.from(
      { length: readerCount },
      (_unused, index) =>
        new SqliteWorkerHandle('reader', spawn, timeout, (reason) =>
          pool?.onReaderDied(index, reason),
        ),
    );

    try {
      await writer.start(options.path);
      await Promise.all(readers.map((reader) => reader.start(options.path)));
    } catch (e) {
      writer.terminate();
      for (const reader of readers) reader.terminate();
      throw e instanceof Error ? e : new Error(String(e));
    }

    pool = new SqlitePool(
      options.path,
      writer,
      readers,
      options.onReaderRespawn ?? (() => {}),
      options.respawnDelaysMs ?? RESPAWN_DELAYS_MS,
    );
    return pool;
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

  /**
   * Run one statement on the writer. Writes are executed in call order.
   *
   * Call order is a guarantee about *this* process. Since the cutover (#3752)
   * there is a second one — the worker child — holding its own writer on the
   * same file, and between processes it is SQLite's file lock that arbitrates.
   * A write that loses that race is retried rather than surfaced; see
   * `busy-retry.ts` for why that is safe and what the ladder is sized against.
   */
  write(sql: string, params?: SqlParams): Promise<SqlWriteResult> {
    return this.rejectIfClosed() ?? retryOnBusy(() => this.writer.write(sql, params));
  }

  /**
   * Run every statement inside one `BEGIN IMMEDIATE` / `COMMIT` on the writer.
   * A statement that throws rolls the whole batch back and rejects; nothing
   * from the batch is visible to readers afterwards.
   *
   * That roll-back is what makes the cross-process retry safe: a batch that
   * lost the file lock left nothing behind, so re-running it starts from the
   * state the first attempt started from.
   */
  transaction(statements: readonly SqlStatement[]): Promise<SqlWriteResult[]> {
    return this.rejectIfClosed() ?? retryOnBusy(() => this.writer.transaction(statements));
  }

  /** Per-worker depth and liveness, for the tests and for an operator. */
  // fallow-ignore-next-line unused-class-member -- called by pool.test.ts, pool.resilience.test.ts and pool.concurrency.test.ts, always on a pool that arrived through `await`, which the analysis does not unwrap back to this class
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
   * A reader that is mid-respawn is skipped by the same test: its connection is
   * not open yet, so `alive` stays false until the handshake completes.
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
   * A reader died. Decide whether to bring it back, and start the ladder.
   *
   * Called by the handle itself, once per death. Three reasons to do nothing:
   * the pool is closing (its own `terminate` calls are what killed the reader),
   * a ladder is already running for this slot, or the slot has been retired.
   */
  private onReaderDied(index: number, reason: string): void {
    const state = this.respawns[index];
    const reader = this.readers[index];
    if (!state || !reader || this.closed || state.inFlight || state.retired) return;
    // A reader that has answered a request since it last came back has proved
    // the database is openable and the thread can work, so this death is a
    // fresh one rather than the continuation of a failing ladder.
    if (reader.stats().completed > state.completedAtRestart) state.attempt = 0;
    state.inFlight = true;
    void this.respawnReader(index, reason);
  }

  /**
   * Work up {@link RESPAWN_DELAYS_MS} until the reader is back or the ladder is
   * spent, then leave the slot alone.
   *
   * The pool degrades rather than failing closed here, which is the opposite of
   * what startup does and deliberately so. Startup refuses because a pool that
   * cannot open would serve every query on the event loop. A pool that is
   * already serving and loses one of N readers still answers every read
   * correctly on the survivors; killing the process over it would turn the
   * partial failure into the total one this whole area exists to prevent. The
   * floor underneath is unchanged — a pool that has lost every reader still
   * rejects reads by name.
   */
  private async respawnReader(index: number, death: string): Promise<void> {
    const state = this.respawns[index]!;
    const reader = this.readers[index]!;
    let reason = death;

    while (!this.closed) {
      const delay = this.respawnDelaysMs[state.attempt];
      if (delay === undefined) {
        state.retired = true;
        this.report({ reader: index, attempt: state.attempt, outcome: 'retired', reason });
        break;
      }
      const attempt = (state.attempt += 1);
      await sleep(delay);
      if (this.closed) break;
      try {
        await reader.restart(this.path);
        // close() can land during the handshake, and it terminated a handle
        // that was not yet holding this thread. Honour it rather than leaving
        // an orphan with the database open.
        if (this.closed) {
          reader.terminate();
          break;
        }
        state.completedAtRestart = reader.stats().completed;
        this.report({ reader: index, attempt, outcome: 'respawned', reason });
        break;
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
        this.report({ reader: index, attempt, outcome: 'failed', reason });
      }
    }

    state.inFlight = false;
  }

  /**
   * Hand one event to whoever supplied the callback, and survive a bad one.
   *
   * A throwing callback would otherwise escape mid-ladder and leave `inFlight`
   * set forever, which would disable respawn for that slot permanently — a
   * logging mistake turning into a capacity one.
   */
  private report(event: ReaderRespawnEvent): void {
    try {
      this.onReaderRespawn(event);
    } catch {
      // Nothing to do with it here: this module has no logger by design.
    }
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
