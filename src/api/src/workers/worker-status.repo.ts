/**
 * Cross-process worker status snapshot.
 *
 * The worker process writes a snapshot of `stageRegistry.statuses()` here every
 * ~2 s (`start-workers.ts`). The API process — whose in-process registry is
 * empty — reads it to answer `GET /api/workers/status` and to feed the WS
 * `workers-status` frame.
 *
 * Single-doc design: fixed `_id: 'singleton'` — upsert on every write, read
 * with one `findOne`.
 *
 * The same doc carries two more things (#3491):
 *
 *  - `counts` — the DB-derived half of `/status` (per-stage pending / ready /
 *    dead plus the collection-level damaged / newly-hidden totals). Computed
 *    by the worker's count refresher (`status-counts.ts`), never on the
 *    request path: on a 335k-asset library several of those counts are
 *    multi-second scans, and they used to run 38-wide in parallel on every
 *    page load.
 *  - `counts_wanted_until` — a demand flag the API bumps whenever someone is
 *    looking at the Workers page (HTTP `/status` or a live WS subscriber).
 *    The worker refreshes counts quickly only while this is in the future,
 *    so an idle deployment never burns DB time on display-only counts.
 */
import { getDb } from '../db/client.ts';
import type { StageStatusSnapshot } from './registry.ts';
import type { FaceModelsLoadStatus } from '../enrichment/face-models.ts';

export interface FaceModelsStatusSnapshot {
  kind: FaceModelsLoadStatus;
  errorDetail: string | null;
}

/** Persisted DB-derived counts for the Workers page — see `status-counts.ts`. */
export interface StatusCountsSnapshot {
  /** `stages.<name>` docs still owing work (version < target, not dead, live location). */
  pending: Record<string, number>;
  /** Subset of `pending` the claim query would pick up right now. */
  ready: Record<string, number>;
  /** Docs at `stages.<name>.dead: true`. */
  dead: Record<string, number>;
  /** Assets tagged `damaged` (parked out of every stage). */
  damaged: number;
  /** Assets auto-hidden for nudity that the operator has not acknowledged. */
  newly_hidden: number;
  /** Epoch ms when this snapshot was computed. */
  computed_at: number;
  /** Wall-clock cost of computing it — drives the refresher's back-off. */
  duration_ms: number;
}

export interface WorkerStatusDoc {
  _id: string;
  statuses: Record<string, StageStatusSnapshot>;
  face_models?: FaceModelsStatusSnapshot;
  updated_at: number;
  counts?: StatusCountsSnapshot;
  /** Epoch ms until which the Workers page is considered "being watched". */
  counts_wanted_until?: number;
}

export interface WorkerStatusRead {
  statuses: Record<string, StageStatusSnapshot>;
  face_models?: FaceModelsStatusSnapshot;
  updated_at: number;
  counts: StatusCountsSnapshot | null;
}

async function coll() {
  return (await getDb()).collection<WorkerStatusDoc>('worker_status');
}

/**
 * Persist the registry snapshot. Never touches `counts` /
 * `counts_wanted_until` — each field on the singleton has exactly one writer.
 *
 * NOTE: do NOT include `_id` in `$set` — Mongo rejects mutations of the
 * immutable `_id` field on update.
 */
export async function writeWorkerStatus(
  snapshot: Record<string, unknown>,
  updatedAt: number,
  faceModels?: FaceModelsStatusSnapshot,
): Promise<void> {
  await (
    await coll()
  ).updateOne(
    { _id: 'singleton' },
    {
      $set: {
        statuses: snapshot as Record<string, StageStatusSnapshot>,
        updated_at: updatedAt,
        ...(faceModels !== undefined ? { face_models: faceModels } : {}),
      },
    },
    { upsert: true },
  );
}

/** Worker-side: persist a freshly computed counts snapshot. */
export async function writeStatusCounts(counts: StatusCountsSnapshot): Promise<void> {
  await (
    await coll()
  ).updateOne(
    { _id: 'singleton' },
    { $set: { counts }, $setOnInsert: { statuses: {}, updated_at: 0 } },
    { upsert: true },
  );
}

/**
 * API-side: record that the Workers page is being watched until `untilMs`.
 * `$max` so overlapping pokes from several API calls never move the deadline
 * backwards.
 */
export async function pokeStatusCountsDemand(untilMs: number): Promise<void> {
  await (
    await coll()
  ).updateOne(
    { _id: 'singleton' },
    { $max: { counts_wanted_until: untilMs }, $setOnInsert: { statuses: {}, updated_at: 0 } },
    { upsert: true },
  );
}

/** Worker-side: the current demand deadline (epoch ms), 0 when never poked. */
export async function readStatusCountsDemand(): Promise<number> {
  try {
    const doc = await (
      await coll()
    ).findOne({ _id: 'singleton' }, { projection: { counts_wanted_until: 1 } });
    return doc?.counts_wanted_until ?? 0;
  } catch {
    return 0;
  }
}

export async function readWorkerStatus(): Promise<WorkerStatusRead | null> {
  try {
    const doc = await (await coll()).findOne({ _id: 'singleton' });
    if (!doc) return null;
    return {
      statuses: doc.statuses ?? {},
      face_models: doc.face_models,
      updated_at: doc.updated_at,
      counts: doc.counts ?? null,
    };
  } catch {
    return null;
  }
}
