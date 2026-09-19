/**
 * One database worker, seen from the main thread: spawn it, complete the open
 * handshake, correlate replies, and count what is in flight.
 *
 * The message plumbing follows the clustering pool
 * (`repos/people.cluster-pool.ts`), with one deliberate difference. That pool
 * degrades to in-process execution when a
 * Worker cannot spawn, which is acceptable for an occasional clustering pass.
 * A database that every request depends on must fail CLOSED instead: there is
 * no in-process fallback anywhere in this file, because the fallback would be
 * "block the event loop on every query for the lifetime of the process", which
 * is worse than not starting. `start()` rejects and the pool refuses to open.
 *
 * In-flight accounting is here rather than in the pool because it is per
 * worker: a bulk import backing up the writer while the readers idle is the
 * shape an operator needs to see, and a single pool-wide number would hide it.
 * `postMessage` has no backpressure, so without this the queue is an invisible
 * unbounded backlog.
 */

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type SqlParams,
  type SqlRow,
  type SqlStatement,
  type SqlWriteResult,
  type SqliteWorkerRequest,
  type SqliteWorkerResponse,
  type SqliteWorkerRole,
} from './protocol.ts';

/** Observable queue depth for one worker. */
export interface SqliteWorkerStats {
  role: SqliteWorkerRole;
  /**
   * False once the thread has died or been terminated. An operator reading
   * `inFlight: 0` on a dead worker would otherwise see it as merely idle.
   */
  alive: boolean;
  /** Requests sent but not yet answered. */
  inFlight: number;
  /** Highest `inFlight` seen since the worker started. */
  peakInFlight: number;
  /** Requests that completed successfully. */
  completed: number;
  /** Requests that came back as an error, or were rejected by worker death. */
  failed: number;
}

interface PendingRequest {
  resolve: (response: SqliteWorkerResponse) => void;
  reject: (error: Error) => void;
  /** Lost-reply backstop, cleared the moment the request settles. */
  timer: ReturnType<typeof setTimeout>;
}

/** How a worker thread is created. Overridable only so the fail-closed path is
 *  testable — production always uses {@link spawnDatabaseWorker}. */
export type SpawnWorker = (role: SqliteWorkerRole) => Worker;

export function spawnDatabaseWorker(): Worker {
  return new Worker(new URL('./db.worker.ts', import.meta.url).href);
}

export class SqliteWorkerHandle {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private peak = 0;
  private completed = 0;
  private failed = 0;
  /** Set once the worker dies or is closed; every later call rejects. */
  private deadReason: string | null = null;

  constructor(
    readonly role: SqliteWorkerRole,
    private readonly spawn: SpawnWorker = spawnDatabaseWorker,
    private readonly requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  /**
   * Spawn the worker and wait for its connection to be open. Rejects — never
   * degrades — when the thread cannot be created, dies during startup, or
   * cannot open the database file. The returned error always names the role
   * and the path, because "the API will not start" needs to say why.
   */
  async start(path: string): Promise<void> {
    const worker = this.spawnOrThrow();
    worker.addEventListener('message', (event: MessageEvent) => this.onMessage(event));
    worker.addEventListener('error', (event: ErrorEvent) =>
      this.onDeath(`worker errored — ${event.message || 'unknown error'}`),
    );
    worker.addEventListener('close', () => this.onDeath('worker exited'));
    this.worker = worker;

    try {
      await this.send({ kind: 'open', id: 0, path, role: this.role });
    } catch (e) {
      this.terminate();
      throw new Error(`sqlite pool: ${this.role} worker could not open ${path} — ${message(e)}`, {
        cause: e,
      });
    }
  }

  private spawnOrThrow(): Worker {
    try {
      return this.spawn(this.role);
    } catch (e) {
      throw new Error(`sqlite pool: failed to spawn ${this.role} worker — ${message(e)}`, {
        cause: e,
      });
    }
  }

  read(sql: string, params?: SqlParams): Promise<SqlRow[]> {
    return this.send({ kind: 'read', id: 0, sql, params }).then((response) => {
      if (response.kind !== 'read' || !response.ok) throw mismatched('read', response);
      return response.rows;
    });
  }

  write(sql: string, params?: SqlParams): Promise<SqlWriteResult> {
    return this.send({ kind: 'write', id: 0, sql, params }).then((response) => {
      if (response.kind !== 'write' || !response.ok) throw mismatched('write', response);
      return response.result;
    });
  }

  transaction(statements: readonly SqlStatement[]): Promise<SqlWriteResult[]> {
    return this.send({ kind: 'transaction', id: 0, statements }).then((response) => {
      if (response.kind !== 'transaction' || !response.ok)
        throw mismatched('transaction', response);
      return response.results;
    });
  }

  get inFlight(): number {
    return this.pending.size;
  }

  /**
   * False once the thread has died or been terminated. Routing must consult
   * this rather than {@link inFlight} alone: a dead handle reports zero in
   * flight forever, which reads as the idlest worker in the pool.
   */
  get alive(): boolean {
    return this.deadReason === null;
  }

  stats(): SqliteWorkerStats {
    return {
      role: this.role,
      alive: this.alive,
      inFlight: this.pending.size,
      peakInFlight: this.peak,
      completed: this.completed,
      failed: this.failed,
    };
  }

  /**
   * Stop the thread and reject anything still outstanding. Idempotent.
   *
   * The worker reference deliberately outlives {@link onDeath}: an `error`
   * event from an uncaught throw inside the worker's message handler does not
   * necessarily exit the thread, so a handle that has been marked dead may
   * still own a running thread holding the database file open. Dropping the
   * reference there would leave `close()` with nothing to terminate, and the
   * next `openSqlitePool` on the same path would have a second writer
   * connection it does not know about.
   */
  terminate(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.onDeath('worker was terminated');
  }

  /** Assign an id, post, and resolve when the matching reply arrives. */
  private send(request: SqliteWorkerRequest): Promise<SqliteWorkerResponse> {
    if (this.deadReason) {
      return Promise.reject(new Error(`sqlite pool: ${this.role} ${this.deadReason}`));
    }
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new Error(`sqlite pool: ${this.role} worker is not running`));
    }
    const id = this.nextId++;
    return new Promise<SqliteWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(id), this.requestTimeoutMs);
      // A backstop must not be the reason a process stays alive: the worker
      // thread itself already holds the loop open while a request is real.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.peak = Math.max(this.peak, this.pending.size);
      try {
        worker.postMessage({ ...request, id });
      } catch (e) {
        this.settle(id);
        this.failed += 1;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onMessage(event: MessageEvent): void {
    const response = event.data as SqliteWorkerResponse | undefined;
    if (!response || typeof response.id !== 'number') return;
    // An unknown id is a reply to a request that already timed out. It is not
    // an error — the caller has been told; there is simply nobody to resolve.
    const pending = this.settle(response.id);
    if (!pending) return;
    if (response.ok) {
      this.completed += 1;
      pending.resolve(response);
      return;
    }
    this.failed += 1;
    pending.reject(sqlError(response.error, response.code));
  }

  /**
   * Give up on a request whose reply never arrived.
   *
   * Nothing else would ever settle it: the only other paths are a matching
   * reply and worker death. A dropped `postMessage` reply — which Bun 1.4.3
   * does under some interleavings — would otherwise hang the HTTP request that
   * asked for it forever AND leave an orphan entry inflating this worker's
   * in-flight count for the life of the process, biasing the pool's routing
   * away from a perfectly healthy worker.
   *
   * The clock starts when the request is posted, so it covers queue time as
   * well as execution. That is why the default is far longer than any query
   * this pool expects to run — it is a liveness backstop, not a query deadline.
   */
  private expire(id: number): void {
    const pending = this.settle(id);
    if (!pending) return;
    this.failed += 1;
    pending.reject(
      new Error(
        `sqlite pool: ${this.role} worker did not answer request ${id} within ${this.requestTimeoutMs}ms`,
      ),
    );
  }

  /** Remove a pending request and cancel its backstop, exactly once. */
  private settle(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  /** Fail every outstanding call and refuse later ones. */
  private onDeath(reason: string): void {
    if (this.deadReason) return;
    this.deadReason = reason;
    const error = new Error(`sqlite pool: ${this.role} ${reason}`);
    for (const id of [...this.pending.keys()]) {
      const pending = this.settle(id);
      this.failed += 1;
      pending?.reject(error);
    }
  }
}

function sqlError(text: string, code: string | undefined): Error {
  return new Error(code ? `${text} (${code})` : text);
}

/** A reply that does not match its request means the protocol was violated —
 *  never something to paper over with an empty result. */
function mismatched(expected: string, response: SqliteWorkerResponse): Error {
  return new Error(
    `sqlite pool: expected a ${expected} reply for request ${response.id}, got ${response.kind}`,
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
