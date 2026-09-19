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

import { availableParallelism } from 'node:os';

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

/**
 * Environment variable an operator can widen the reader pool with, without a
 * deploy. See {@link readerCountFromEnvironment} for why this is an environment
 * variable rather than a settings row.
 */
export const READER_COUNT_ENV = 'MAPLE_SQLITE_READERS';

/**
 * Cores left to the worker child. The API process and the worker child it
 * spawns share one box, and the child runs the enrichment tier — which is the
 * genuinely CPU-hungry half. Sizing the reader pool to every core would have
 * the database's own threads compete with the work they are feeding.
 */
const CORES_RESERVED_FOR_WORKER_CHILD = 2;

/**
 * Fewest readers the pool will size itself to, however small the box.
 *
 * The floor is set by how many long reads this process can have running at once
 * rather than by the core count, because a pool of N tolerates N−1 sustained
 * long reads and collapses at N — measured, and reproducible with
 * `scripts/sqlite-bench/reader-pool.ts`. Four leaves room for three: the worker
 * tier's per-stage backlog counts (one at a time, deliberately — see
 * `workers/status-counts.ts`), the change feed, and whatever a request happens
 * to be doing. It is the smallest count that is not one step from the edge.
 *
 * A small box pays for the floor in facet latency — a 12-wide search fan-out
 * costs 18.8 ms on four readers against 12.7 on eight — which is the right way
 * round: four cores cannot absorb eight busy reader threads, and a slower
 * search is a better failure than a pool one long read from collapsing.
 */
const READER_FLOOR = 4;

/**
 * Most readers the pool will size itself to unasked.
 *
 * Eight rather than six, and the reason needs stating because the benchmark
 * beside this contains a table that looks like it says six.
 *
 * Run a 12-wide search fan-out — the shape `searchFacets` issues — where each
 * of the twelve is a full backlog scan, and the wall time is *not* monotonic in
 * the reader count: 4 readers beat 8, and somewhere around four to six is the
 * minimum. Twelve CPU-bound scans compete for memory bandwidth rather than for
 * cores, so adding threads makes each one slower. On that table alone the
 * ceiling should be six, or four.
 *
 * That table measures a workload #3768 removes. Once the six expensive facets
 * read an index and stop (12–37 ms each at 335,377 assets, against 252–1,134
 * ms), the same fan-out is monotonically *better* with more readers — measured
 * at 34.1 ms on two, 18.8 on four, 13.3 on six, 12.7 on eight. There is no
 * inversion left to optimise around, because there is no longer enough CPU in a
 * faceted search for the threads to fight over. The location of the old minimum
 * was not stable across runs either; only its existence was.
 *
 * What does not go away is the property the count exists for: a pool of N
 * tolerates N−1 sustained long reads and falls off a cliff at N. Six stays
 * healthy through five concurrent long reads and collapses at six (tail 18 ms →
 * 324 ms); eight is still flat at seven. Two more tolerated long reads is worth
 * more than a millisecond of facet latency, because concurrent long reads are
 * what took production down and facet latency is not.
 *
 * So the ceiling optimises for **surviving concurrent long reads**, and gives
 * up a little throughput on a burst of simultaneous heavy scans — a trade that
 * only costs anything at all in the window before #3768 lands, and even there
 * costs about 140 ms on a search to buy three more long reads of headroom.
 *
 * Eight rather than more: the API process and the worker child each open a pool,
 * so this is doubled on the box, and past eight the measured gain is fractions
 * of a millisecond per search against real thread and page-cache cost. An
 * operator on a large machine who wants more sets {@link READER_COUNT_ENV};
 * that is what it is for.
 */
const READER_CEILING = 8;

/** Largest value {@link READER_COUNT_ENV} will accept — a fat-finger guard. */
const READER_ENV_MAX = 64;

/**
 * Reader workers to spawn when the caller does not say otherwise.
 *
 * Scaled from the box rather than fixed, because the number of concurrent long
 * reads this process can produce grows with the stage list and the background
 * passes rather than staying constant. Four on a small box, eight on anything
 * with ten or more cores. Cost is one thread and its page cache each.
 */
export function defaultReaderCount(): number {
  const spare = availableParallelism() - CORES_RESERVED_FOR_WORKER_CHILD;
  return Math.min(READER_CEILING, Math.max(READER_FLOOR, spare));
}

/**
 * The operator's override, or null when unset.
 *
 * This is one of the cases the project's settings-over-environment-variables
 * rule genuinely carves out, and the carve-out is structural rather than a
 * preference: the settings this would otherwise live in are rows in the
 * database the pool has not opened yet. A settings row could only be read after
 * the pool exists, which is after the reader count has been decided.
 *
 * It throws rather than falling back on a value it cannot parse. An operator
 * who widened the pool during an outage and silently got the default back would
 * conclude that widening it did not help and go looking somewhere else; the
 * process refusing to start with the variable named is the cheaper failure.
 */
export function readerCountFromEnvironment(): number | null {
  const raw = process.env[READER_COUNT_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > READER_ENV_MAX) {
    throw new Error(
      `sqlite pool: ${READER_COUNT_ENV} must be an integer between 1 and ${READER_ENV_MAX}, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

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
