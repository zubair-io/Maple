/**
 * One database worker, seen from the main thread: spawn it, complete the open
 * handshake, correlate replies, and count what is in flight.
 *
 * The message plumbing follows `src/api/src/people/cluster-pool.ts`, with one
 * deliberate difference. That pool degrades to in-process execution when a
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

import type {
  SqlParams,
  SqlRow,
  SqlStatement,
  SqlWriteResult,
  SqliteWorkerRequest,
  SqliteWorkerResponse,
  SqliteWorkerRole,
} from './protocol.ts';

/** Observable queue depth for one worker. */
export interface SqliteWorkerStats {
  role: SqliteWorkerRole;
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

  stats(): SqliteWorkerStats {
    return {
      role: this.role,
      inFlight: this.pending.size,
      peakInFlight: this.peak,
      completed: this.completed,
      failed: this.failed,
    };
  }

  /** Stop the thread and reject anything still outstanding. Idempotent. */
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
      this.pending.set(id, { resolve, reject });
      this.peak = Math.max(this.peak, this.pending.size);
      try {
        worker.postMessage({ ...request, id });
      } catch (e) {
        this.pending.delete(id);
        this.failed += 1;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onMessage(event: MessageEvent): void {
    const response = event.data as SqliteWorkerResponse | undefined;
    if (!response || typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) {
      this.completed += 1;
      pending.resolve(response);
      return;
    }
    this.failed += 1;
    pending.reject(sqlError(response.error, response.code));
  }

  /** Fail every outstanding call and refuse later ones. */
  private onDeath(reason: string): void {
    if (this.deadReason) return;
    this.deadReason = reason;
    const error = new Error(`sqlite pool: ${this.role} ${reason}`);
    for (const pending of this.pending.values()) {
      this.failed += 1;
      pending.reject(error);
    }
    this.pending.clear();
    this.worker = null;
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
