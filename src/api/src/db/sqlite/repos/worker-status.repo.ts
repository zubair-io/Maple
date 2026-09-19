/**
 * `worker_status` — the one row the worker process keeps up to date and the
 * API process reads to answer `GET /api/workers/status` (#3787).
 *
 * ## Three writers, one row, and no two of them touch the same column
 *
 * The singleton carries three independent things, and keeping them in one row
 * is only safe because each has exactly one writer:
 *
 *  - `statuses` / `face_models` / `updated_at` — the worker's registry
 *    snapshot, rewritten every couple of seconds by `start-workers.ts`.
 *  - `counts` — the expensive per-stage backlog numbers, written by the
 *    worker's count refresher (`workers/status-counts.ts`).
 *  - `counts_wanted_until` — the demand flag, raised by the API whenever
 *    someone is looking at Settings → Workers.
 *
 * Every statement below names only its own columns, so the upserts cannot
 * clobber each other the way a whole-document write would. That is the same
 * discipline the Mongo version kept with its narrow `$set`s, restated in SQL.
 *
 * ## Counts are never derived on the request path
 *
 * This module reads and writes a stored snapshot; it counts nothing. That is
 * the architecture #3491 established and it is not an implementation detail:
 * `/api/workers/status` used to run ~38 `countDocuments` per page load and took
 * eight seconds. The demand flag exists so the worker refreshes quickly only
 * while a human is watching, and the endpoint stays one keyed read.
 *
 * ## Why the demand flag's upsert spells `MAX` twice
 *
 * The Mongo write is `$max`, so two API processes poking overlapping windows
 * can never move the deadline backwards. SQLite's scalar `MAX(a, b)` returns
 * NULL if either argument is NULL, and the column is nullable — so the stored
 * side is wrapped in `COALESCE` before the comparison. Without it the first
 * poke against a row created by the status writer would blank the flag instead
 * of raising it.
 */

import type { FaceModelsLoadStatus } from '../../../enrichment/face-models.ts';
import type { StageStatusSnapshot } from '../../../workers/registry.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { parseJson } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/**
 * What the ONNX face-model loader is doing, mirrored out of the worker.
 *
 * Both imports above are type-only and therefore erased, which matters here:
 * `enrichment/face-models.ts` loads ONNX at runtime and `workers/registry.ts`
 * pulls in the whole stage registry, and neither belongs in the module graph
 * `db/sqlite/pool.ts` is loaded inside.
 */
export interface FaceModelsStatusSnapshot {
  kind: FaceModelsLoadStatus;
  errorDetail: string | null;
}

/** The persisted DB-derived counts for the Workers page. */
export interface StatusCountsSnapshot {
  /** Assets still owing work for a stage (below target, not dead, live). */
  pending: Record<string, number>;
  /** The subset of `pending` the claim would pick up right now. */
  ready: Record<string, number>;
  /** Assets parked at the attempt ceiling for a stage. */
  dead: Record<string, number>;
  /** Assets tagged damaged — parked out of every stage. */
  damaged: number;
  /** Assets auto-hidden for nudity that the operator has not acknowledged. */
  newly_hidden: number;
  /** Epoch ms when this snapshot was computed. */
  computed_at: number;
  /** Wall-clock cost of computing it — drives the refresher's back-off. */
  duration_ms: number;
}

/** What the status route reads back. */
export interface WorkerStatusRead {
  statuses: Record<string, StageStatusSnapshot>;
  face_models?: FaceModelsStatusSnapshot;
  updated_at: number;
  counts: StatusCountsSnapshot | null;
}

interface WorkerStatusRow {
  statuses: string;
  face_models: string | null;
  updated_at: number;
  counts: string | null;
  counts_wanted_until: number | null;
}

const SINGLETON = 'singleton';

/**
 * Persist the registry snapshot, and the face-model load state alongside it.
 *
 * `face_models` is left as it was when the caller has nothing to say about it,
 * which is what `...(faceModels !== undefined ? … : {})` did on the document —
 * `json(NULL)` is NULL, so the `COALESCE` keeps the stored value.
 */
export async function writeWorkerStatus(
  snapshot: Record<string, unknown>,
  updatedAt: number,
  faceModels?: FaceModelsStatusSnapshot,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO worker_status (id, statuses, updated_at, face_models)
     VALUES (?, json(?), ?, json(?))
     ON CONFLICT (id) DO UPDATE SET
       statuses = excluded.statuses,
       updated_at = excluded.updated_at,
       face_models = COALESCE(excluded.face_models, worker_status.face_models)`,
    [
      SINGLETON,
      JSON.stringify(snapshot),
      updatedAt,
      faceModels === undefined ? null : JSON.stringify(faceModels),
    ],
  );
}

/**
 * Worker-side: store a freshly computed counts snapshot.
 *
 * The insert branch seeds `statuses` and `updated_at` rather than leaving them
 * out, because the column is `NOT NULL` — the SQL equivalent of the Mongo
 * write's `$setOnInsert: { statuses: {}, updated_at: 0 }`, and for the same
 * reason: the counts pass can legitimately run before the status writer's first
 * tick.
 */
export async function writeStatusCounts(
  counts: StatusCountsSnapshot,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO worker_status (id, statuses, updated_at, counts)
     VALUES (?, '{}', 0, json(?))
     ON CONFLICT (id) DO UPDATE SET counts = excluded.counts`,
    [SINGLETON, JSON.stringify(counts)],
  );
}

/** API-side: record that the Workers page is being watched until `untilMs`. */
export async function pokeStatusCountsDemand(
  untilMs: number,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO worker_status (id, statuses, updated_at, counts_wanted_until)
     VALUES (?, '{}', 0, ?)
     ON CONFLICT (id) DO UPDATE SET
       counts_wanted_until =
         MAX(COALESCE(worker_status.counts_wanted_until, 0), excluded.counts_wanted_until)`,
    [SINGLETON, untilMs],
  );
}

/**
 * Worker-side: the current demand deadline (epoch ms), 0 when never poked.
 *
 * Swallows a read failure and reports "nobody is watching", which is the
 * conservative answer: the idle cadence still refreshes counts every ten
 * minutes, so a database blip slows the page down rather than emptying it.
 */
export async function readStatusCountsDemand(dbOverride?: SqliteDb): Promise<number> {
  try {
    const rows = await sqliteDb(dbOverride).read<{ counts_wanted_until: number | null }>(
      `SELECT counts_wanted_until FROM worker_status WHERE id = ?`,
      [SINGLETON],
    );
    return rows[0]?.counts_wanted_until ?? 0;
  } catch {
    return 0;
  }
}

/** The whole snapshot, or null when the worker has never written one. */
export async function readWorkerStatus(dbOverride?: SqliteDb): Promise<WorkerStatusRead | null> {
  try {
    const rows = await sqliteDb(dbOverride).read<WorkerStatusRow>(
      `SELECT statuses, face_models, updated_at, counts, counts_wanted_until
         FROM worker_status WHERE id = ?`,
      [SINGLETON],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const faceModels = parseJson<FaceModelsStatusSnapshot | null>(row.face_models, null);
    return {
      statuses: parseJson<Record<string, StageStatusSnapshot>>(row.statuses, {}),
      ...(faceModels === null ? {} : { face_models: faceModels }),
      updated_at: row.updated_at,
      counts: parseJson<StatusCountsSnapshot | null>(row.counts, null),
    };
  } catch {
    return null;
  }
}
