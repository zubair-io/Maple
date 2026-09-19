/**
 * Wire protocol between the SQLite pool (main thread) and its database
 * workers. Both sides import these types; nothing else should need them.
 *
 * The protocol is deliberately tiny — three primitives, not one message per
 * repository function:
 *
 *   read         — run one statement, return the rows.
 *   write        — run one statement, return `changes` + `lastInsertRowid`.
 *   transaction  — run a list of statements inside one BEGIN/COMMIT.
 *
 * Query text and bound parameters are built by the caller and passed straight
 * through. The worker never learns what an asset, a change row or a stage
 * claim is, which is what keeps this module from growing a case per caller as
 * the migration proceeds.
 *
 * Every request carries a caller-assigned `id`; the response echoes it so the
 * pool can correlate replies on a shared `postMessage` channel. Responses are
 * discriminated on `ok` rather than on `kind`, so error handling is one branch.
 */

/**
 * A value SQLite can bind. Booleans are accepted and stored as 0/1 — SQLite
 * has no boolean type, so they come back as numbers.
 */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/**
 * Bound parameters: an array for positional `?` placeholders, or an object for
 * named `$name` / `:name` placeholders. `bun:sqlite` runs in its default
 * (non-strict) mode, so object keys must include the sigil.
 */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

/** One statement plus its parameters — the unit a transaction is built from. */
export interface SqlStatement {
  sql: string;
  params?: SqlParams;
}

/** A returned row. Callers cast to their own shape; the pool does not validate. */
export type SqlRow = Record<string, unknown>;

/** What a write reports back. `lastInsertRowid` is 0 for non-insert writes. */
export interface SqlWriteResult {
  changes: number;
  lastInsertRowid: number;
}

/**
 * Which connection a worker owns. The writer opens read-write and owns the
 * WAL pragmas; readers open read-only, so the "one writer" invariant is
 * enforced by SQLite itself rather than by convention.
 */
export type SqliteWorkerRole = 'writer' | 'reader';

export interface OpenRequest {
  kind: 'open';
  id: number;
  /** Absolute path to the database file. */
  path: string;
  role: SqliteWorkerRole;
}

export interface ReadRequest {
  kind: 'read';
  id: number;
  sql: string;
  params?: SqlParams;
}

export interface WriteRequest {
  kind: 'write';
  id: number;
  sql: string;
  params?: SqlParams;
}

export interface TransactionRequest {
  kind: 'transaction';
  id: number;
  statements: readonly SqlStatement[];
}

export type SqliteWorkerRequest = OpenRequest | ReadRequest | WriteRequest | TransactionRequest;

export interface OpenSuccess {
  kind: 'open';
  id: number;
  ok: true;
}

export interface ReadSuccess {
  kind: 'read';
  id: number;
  ok: true;
  rows: SqlRow[];
}

export interface WriteSuccess {
  kind: 'write';
  id: number;
  ok: true;
  result: SqlWriteResult;
}

export interface TransactionSuccess {
  kind: 'transaction';
  id: number;
  ok: true;
  results: SqlWriteResult[];
}

export interface WorkerFailure {
  kind: SqliteWorkerRequest['kind'];
  id: number;
  ok: false;
  /** Human-readable message, already flattened — Errors do not clone cleanly. */
  error: string;
  /** SQLite's own error code (e.g. `SQLITE_CONSTRAINT`) when the driver set one. */
  code?: string;
}

export type SqliteWorkerResponse =
  | OpenSuccess
  | ReadSuccess
  | WriteSuccess
  | TransactionSuccess
  | WorkerFailure;

/**
 * How many distinct SQL texts a worker keeps prepared. Callers build query
 * text from a fixed set of templates, so the live set is small; the cap exists
 * so a caller that interpolates a value into the SQL text cannot turn the
 * cache into an unbounded leak in a process that runs for months.
 */
export const STATEMENT_CACHE_LIMIT = 256;

/** Reader workers spawned when the caller does not say otherwise. */
export const DEFAULT_READER_COUNT = 2;

/** Milliseconds a connection waits on a held lock before reporting SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * Milliseconds the pool waits for a worker's reply before rejecting the
 * caller. This is a liveness backstop for a reply that never arrives — a
 * dropped `postMessage`, a wedged thread — not a query deadline: the clock
 * includes time the request spends queued behind earlier ones on the same
 * worker, so it is set far above anything a request-path query should run for.
 * Without it a lost reply hangs its caller for the life of the process.
 *
 * A caller that deliberately runs a statement longer than this — an index
 * build during a migration, a single enormous import transaction — should
 * raise it with `requestTimeoutMs` rather than assume this default covers it.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
