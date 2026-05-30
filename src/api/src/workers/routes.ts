/**
 * Worker management API routes.
 *
 * Mounted on the main Elysia app in src/api/src/index.ts under /api/workers.
 * Reads live state from the in-process `stageRegistry` (see `./registry.ts`);
 * there is no external process to talk to.
 *
 * Config change flow for PATCH /:name/config:
 *   1. Validate the patch body.
 *   2. Write to worker_config in Mongo (persistence).
 *   3. Call stageRegistry.notifyConfigChanged(name); the running poll loop
 *      re-reads its config from Mongo and applies the new values live.
 *   4. Return { ok: true, config: WorkerConfig } (reads back saved config).
 *
 * Routes:
 *   GET  /api/workers/status            — aggregated status + pending/dead counts
 *   GET  /api/workers/:name/dead        — recent dead-lettered docs with reasons
 *   POST /api/workers/:name/pause       — pause a stage's poll loop
 *   POST /api/workers/:name/resume      — resume a paused stage
 *   POST /api/workers/:name/retry-dead  — reset dead docs for a stage
 *   PATCH /api/workers/:name/config     — update WorkerConfig fields + notify
 */

import { Elysia, t } from 'elysia';
import { type Filter, ObjectId } from 'mongodb';
import { getDb } from '../db/client.ts';
import { WorkerConfigRepo } from './worker-config.repo.ts';
import type { WorkerConfig, ImageDoc } from './run-stage.ts';
import { buildClaimQuery, deriveBatchSize } from './run-stage.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';
import { stageRegistry } from './registry.ts';
import type { StageStatusSnapshot } from './registry.ts';
import { MISSING_REAPER_NAME } from './missing-reaper.ts';
import { loadPruneWindowHours, savePruneWindowHours } from './missing-reaper-config.repo.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { ALL_STAGE_NAMES } from './stages/manifest.ts';
import { child } from '../log.ts';

const log = child('workers:routes');

// Names of the version-claim pipeline stages. Other registry entries (e.g.
// the `missing-reaper`, which is registered for pause/resume/status control
// but is NOT a per-asset claim stage) carry no `stages.<name>` subdocument, so
// the pending / dead `countDocuments` below is meaningless for them — and the
// `version: { $exists: false }` branch would match the ENTIRE collection. Gate
// the counts to real claim stages; everything else reports pending/dead 0.
const CLAIM_STAGE_NAMES = new Set<string>(ALL_STAGE_NAMES);

const DEAD_LIST_LIMIT_DEFAULT = 50;
const DEAD_LIST_LIMIT_MAX = 500;

/** Stages that stamp the `damaged` tag (those with `tagsDamagedOnDeadLetter`).
 * `POST /damaged/clear` resets their dead/attempt bookkeeping when un-tagging
 * so a cleared file is genuinely re-tried. Kept in sync with the stage configs
 * in `stages/{exif,thumb,preview}.ts`. */
const DAMAGE_TAGGING_STAGES = ['exif', 'thumb', 'preview'] as const;

/** Config knobs removed in #674. PATCH rejects these with a 400 so a stale
 * client that still sends them gets a clear signal instead of a silent no-op. */
const REMOVED_CONFIG_KEYS = ['pollIntervalMs', 'batchSize'] as const;

// Short-TTL cache for the DB-derived half of /status. Holds worker_config rows
// and per-stage pending/ready/dead counts; the registry-derived fields (status,
// inFlight, throughput, lastError) are recomposed from the in-process registry
// on every call so they stay fresh. Keyed on the stage-name + targetVersion
// signature so a stage gaining or changing targetVersion bypasses the cache.
// Polling FE clients (settings UI ticks every ~1-2s) hit cache on every other
// call, reducing the per-stage countDocuments round-trips to zero work.
//
// `pending` counts every doc this stage still owes work on (version < target,
// not dead). `ready` is the subset whose upstream deps are already met — i.e.
// what the claim query would actually pick up right now. `blocked` (derived as
// pending − ready in the response) is everything waiting on an upstream stage.
type StatusDbState = {
  configMap: Map<string, WorkerConfig>;
  pendingByStage: Map<string, number>;
  readyByStage: Map<string, number>;
  deadByStage: Map<string, number>;
  /** Collection-level count of assets tagged `damaged` (parked out of every
   * stage). Not per-stage — a damaged file is global state, surfaced as the
   * "Damaged" pill in the Workers UI. */
  damagedTotal: number;
};
const STATUS_CACHE_TTL_MS = 2000;
let statusCache: {
  key: string;
  data: StatusDbState;
  expiresAt: number;
} | null = null;

function statusCacheKey(
  stageNames: string[],
  statuses: Record<string, StageStatusSnapshot>,
): string {
  // Sort so the key is stable even if `statuses()` iteration order shifts
  // when stages transition from preregistered to registered (the registry
  // unions two Maps, and insertion order across those Maps is not stable).
  return stageNames
    .slice()
    .sort()
    .map((n) => `${n}:${statuses[n]?.targetVersion ?? 1}`)
    .join('|');
}

function invalidateStatusCache(): void {
  statusCache = null;
}

/**
 * Pick only the live `WorkerConfig` fields off a raw `worker_config` Mongo doc.
 * Existing docs may still carry removed knobs (`pollIntervalMs` / `batchSize`,
 * dropped in #674); without this projection those stale keys would leak back
 * out through GET /status and the WS `workers-status` frame. Mirrors
 * `WorkerConfigRepo.load`'s explicit field list so the two never drift.
 */
export function sanitizeWorkerConfig(doc: WorkerConfigDoc): WorkerConfig {
  return {
    concurrency: doc.concurrency,
    maxAttempts: doc.maxAttempts,
    paused: doc.paused,
    last_seen_target_version: doc.last_seen_target_version,
  };
}

/** Test-only: drop the cached /status snapshot so tests don't see prior state. */
export function _resetStatusCacheForTests(): void {
  invalidateStatusCache();
}

async function fetchStatusDbState(
  stageNames: string[],
  statuses: Record<string, StageStatusSnapshot>,
): Promise<StatusDbState> {
  const configMap = new Map<string, WorkerConfig>();
  const pendingByStage = new Map<string, number>();
  const readyByStage = new Map<string, number>();
  const deadByStage = new Map<string, number>();
  let damagedTotal = 0;
  let assets: import('mongodb').Collection<import('mongodb').Document> | null = null;

  try {
    const db = await getDb();
    assets = db.collection('assets') as import('mongodb').Collection<import('mongodb').Document>;
    const configColl = db.collection<WorkerConfigDoc>('worker_config');
    const allConfigs = await configColl.find({}).toArray();
    // Sanitize before exposing: strip any removed knobs that linger on older
    // docs so they don't leak through /status or the WS status frame.
    for (const cfg of allConfigs) configMap.set(cfg.name, sanitizeWorkerConfig(cfg));
  } catch {
    // DB unavailable — counts remain zeros, configMap empty.
  }

  const claimStageNames = stageNames.filter((name) => CLAIM_STAGE_NAMES.has(name));
  if (assets && claimStageNames.length > 0) {
    const counts = await Promise.all(
      claimStageNames.flatMap((name) => {
        const tv = statuses[name]?.targetVersion ?? 1;
        const deps = statuses[name]?.dependsOn ?? [];
        const pending = assets!
          .countDocuments({
            $or: [
              { [`stages.${name}.version`]: { $lt: tv } },
              { [`stages.${name}.version`]: { $exists: false } },
            ],
            [`stages.${name}.dead`]: { $ne: true },
          })
          .then((n) => ({ key: 'pending' as const, name, n }))
          .catch((err) => {
            log.warn({ stage: name, err }, 'countDocuments failed for pending — returning 0');
            return { key: 'pending' as const, name, n: 0 };
          });
        // `ready` mirrors the claim query exactly (same base predicate + the
        // upstream-dependency gates), so it's the subset of `pending` a worker
        // could actually pick up right now. Empty in-flight set: the few docs
        // momentarily in flight don't matter for an operator-facing count.
        const readyQuery = buildClaimQuery(name, tv, deps, new Set()) as import('mongodb').Filter<
          import('mongodb').Document
        >;
        const ready = assets!
          .countDocuments(readyQuery)
          .then((n) => ({ key: 'ready' as const, name, n }))
          .catch((err) => {
            log.warn({ stage: name, err }, 'countDocuments failed for ready — returning 0');
            return { key: 'ready' as const, name, n: 0 };
          });
        const dead = assets!
          .countDocuments({ [`stages.${name}.dead`]: true })
          .then((n) => ({ key: 'dead' as const, name, n }))
          .catch((err) => {
            log.warn({ stage: name, err }, 'countDocuments failed for dead — returning 0');
            return { key: 'dead' as const, name, n: 0 };
          });
        return [pending, ready, dead];
      }),
    );
    for (const c of counts) {
      if (c.key === 'pending') pendingByStage.set(c.name, c.n);
      else if (c.key === 'ready') readyByStage.set(c.name, c.n);
      else deadByStage.set(c.name, c.n);
    }
  }

  // The missing-reaper is NOT a claim stage, so the loop above leaves its
  // counts at 0 — which reads as "nothing to do" even while it's actively
  // pruning a large `missing_since` backlog. Surface the real tagged count as
  // its `pending` so the Workers UI reflects the work queue instead of 0/0/0.
  // `$type: "string"` matches the reaper's own query exactly: it counts only
  // tagged rows (not absent/null) AND lets the planner use the
  // `missing_since_1` partial index instead of COLLSCANning every asset.
  if (assets && stageNames.includes(MISSING_REAPER_NAME)) {
    try {
      pendingByStage.set(
        MISSING_REAPER_NAME,
        await assets.countDocuments({
          missing_since: { $type: 'string', $ne: null },
        }),
      );
    } catch (err) {
      log.warn({ err }, 'countDocuments failed for missing-reaper tagged count — leaving 0');
    }
  }

  // Collection-level damaged count. `$type: "string"` on `damaged.since`
  // matches exactly the tagged rows (and uses the `damaged_since_1` partial
  // index) — same shape + rationale as the missing-reaper count above.
  if (assets) {
    try {
      damagedTotal = await assets.countDocuments({
        'damaged.since': { $type: 'string' },
      });
    } catch (err) {
      log.warn({ err }, 'countDocuments failed for damaged count — leaving 0');
    }
  }

  return { configMap, pendingByStage, readyByStage, deadByStage, damagedTotal };
}

/** One stage row in the `/status` response (and the WS `workers-status` frame). */
export interface StageStatusRow {
  name: string;
  status: StageStatusSnapshot['status'];
  inFlight: number;
  configured: number;
  pending: number;
  ready: number;
  blocked: number;
  dead: number;
  throughput: number;
  lastError: string | null;
  config: WorkerConfig | null;
  batchSize: number;
}

export interface WorkersStatusPayload {
  stages: StageStatusRow[];
  /** Collection-level count of assets tagged `damaged` (unreadable bytes,
   * parked out of every stage). Drives the "Damaged" pill in the Workers UI. */
  damaged: number;
}

/**
 * Resolve the DB-derived half of `/status` through the short-TTL cache. Exposed
 * so the WS broadcaster (routes/events.ts) reuses the exact same cache + count
 * queries instead of duplicating ~4×nStages `countDocuments` per tab.
 */
export async function getStatusDbStateCached(
  stageNames: string[],
  statuses: Record<string, StageStatusSnapshot>,
): Promise<StatusDbState> {
  const cacheKey = statusCacheKey(stageNames, statuses);
  const now = Date.now();
  if (statusCache && statusCache.key === cacheKey && statusCache.expiresAt > now) {
    return statusCache.data;
  }
  const dbState = await fetchStatusDbState(stageNames, statuses);
  statusCache = {
    key: cacheKey,
    data: dbState,
    expiresAt: now + STATUS_CACHE_TTL_MS,
  };
  return dbState;
}

/** Compose the per-stage status rows from the live registry + DB-derived
 * counts. Pure assembly — no I/O. Shared by the `/status` route and the WS
 * `workers-status` frame so both render identically. */
export function assembleWorkersStatus(
  statuses: Record<string, StageStatusSnapshot>,
  dbState: StatusDbState,
): WorkersStatusPayload {
  const stages = Object.entries(statuses).map(([name, s]) => {
    const pending = dbState.pendingByStage.get(name) ?? 0;
    const ready = dbState.readyByStage.get(name) ?? 0;
    // pending and ready are counted by separate (non-atomic) queries, so
    // clamp the derived blocked count to avoid a transient negative.
    const blocked = Math.max(0, pending - ready);
    const dead = dbState.deadByStage.get(name) ?? 0;
    const config = dbState.configMap.get(name) ?? null;
    const configured = config?.concurrency ?? 0;
    // batchSize is no longer a knob — it's derived as 5×concurrency at the
    // claim site (#674). Surface the derived value so the UI's
    // "inFlight / batchSize" cell stays meaningful.
    const batchSize = deriveBatchSize(configured);
    return {
      name,
      status: s.status,
      inFlight: s.inFlight,
      configured,
      pending,
      ready,
      blocked,
      dead,
      throughput: s.throughput,
      lastError: s.lastError,
      config,
      batchSize,
    };
  });
  return { stages, damaged: dbState.damagedTotal };
}

/** Full `/status` payload, resolving the DB half through the shared cache. */
export async function computeWorkersStatus(): Promise<WorkersStatusPayload> {
  const statuses = stageRegistry.statuses();
  const stageNames = Object.keys(statuses);
  const dbState = await getStatusDbStateCached(stageNames, statuses);
  return assembleWorkersStatus(statuses, dbState);
}

export function workerRoutes(): Elysia {
  return (
    new Elysia({ prefix: '/api/workers' })

      .get('/status', async () => {
        return computeWorkersStatus();
      })

      // Missing-reaper prune window (hours an original must be missing before the
      // reaper hard-deletes the row). The reaper re-reads this each tick, so a
      // PATCH takes effect on the next pass without a restart.
      .get('/missing-reaper/prune-window', async () => {
        return { hours: await loadPruneWindowHours() };
      })

      .patch(
        '/missing-reaper/prune-window',
        async ({ body, set }) => {
          try {
            const hours = await savePruneWindowHours((body as { hours: number }).hours);
            return { ok: true, hours };
          } catch (err) {
            set.status = 500;
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        { body: t.Object({ hours: t.Number({ minimum: 1, maximum: 8760 }) }) },
      )

      .get('/:name/dead', async ({ params, query, set }) => {
        if (!stageRegistry.has(params.name)) {
          set.status = 404;
          return { error: `unknown stage: ${params.name}` };
        }
        const requested = Number(query.limit ?? DEAD_LIST_LIMIT_DEFAULT);
        const limit = Number.isFinite(requested)
          ? Math.max(1, Math.min(DEAD_LIST_LIMIT_MAX, Math.floor(requested)))
          : DEAD_LIST_LIMIT_DEFAULT;
        try {
          const db = await getDb();
          const assets = db.collection<ImageDoc>('assets');
          const stageKey = `stages.${params.name}`;
          const docs = await assets
            .find(
              { [`${stageKey}.dead`]: true },
              {
                projection: {
                  _id: 1,
                  abs_path: 1,
                  fileinfo: 1,
                  folder_id: 1,
                  [`${stageKey}.last_error`]: 1,
                  [`${stageKey}.attempts`]: 1,
                  [`${stageKey}.processed_at`]: 1,
                },
              },
            )
            .sort({ [`${stageKey}.processed_at`]: -1 })
            .limit(limit)
            .toArray();
          const libs = await loadLibraryRoots();
          const items = docs.map((doc) => {
            const stage = doc.stages?.[params.name];
            return {
              id: String(doc._id),
              abs_path: assetAbsPath(doc, libs),
              last_error: stage?.last_error ?? null,
              attempts: stage?.attempts ?? 0,
              processed_at: stage?.processed_at ? new Date(stage.processed_at).toISOString() : null,
            };
          });
          return { items };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })

      // Damaged files — assets tagged `damaged` (unreadable bytes) by a
      // file-reading stage that exhausted its retries. Collection-level: one
      // list across the whole pipeline, each row keyed by maple_id.
      .get('/damaged', async ({ query, set }) => {
        const requested = Number(query.limit ?? DEAD_LIST_LIMIT_DEFAULT);
        const limit = Number.isFinite(requested)
          ? Math.max(1, Math.min(DEAD_LIST_LIMIT_MAX, Math.floor(requested)))
          : DEAD_LIST_LIMIT_DEFAULT;
        try {
          const db = await getDb();
          const assets = db.collection<ImageDoc>('assets');
          const docs = await assets
            .find(
              { 'damaged.since': { $type: 'string' } },
              {
                projection: { _id: 1, maple_id: 1, fileinfo: 1, damaged: 1 },
              },
            )
            .sort({ 'damaged.since': -1 })
            .limit(limit)
            .toArray();
          const libs = await loadLibraryRoots();
          const items = docs.map((doc) => {
            const damaged = (doc as { damaged?: { since: string; stage: string; reason: string } })
              .damaged;
            return {
              id: String(doc._id),
              maple_id: (doc as { maple_id?: string }).maple_id ?? null,
              abs_path: assetAbsPath(doc, libs),
              stage: damaged?.stage ?? null,
              reason: damaged?.reason ?? null,
              since: damaged?.since ?? null,
            };
          });
          return { items };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })

      // Clear the `damaged` tag so the pipeline re-processes the file. `id`
      // (asset _id hex) clears one; omit it to clear all. Also resets the
      // tagging stages' dead/attempt bookkeeping so the file is actually
      // re-tried, not just un-parked.
      .post(
        '/damaged/clear',
        async ({ body, set }) => {
          try {
            const db = await getDb();
            const images = db.collection<ImageDoc>('assets');
            const id = (body as { id?: string } | null)?.id;
            let filter: Filter<ImageDoc>;
            if (id) {
              let oid: ObjectId;
              try {
                oid = new ObjectId(id);
              } catch {
                set.status = 400;
                return { error: `invalid asset id: ${id}` };
              }
              filter = { _id: oid, 'damaged.since': { $type: 'string' } };
            } else {
              filter = { 'damaged.since': { $type: 'string' } };
            }
            // Reset the dead/attempt bookkeeping on the file-reading stages so a
            // cleared file is genuinely re-tried, then drop the tag.
            const stageResets: Record<string, unknown> = { damaged: null };
            for (const stageName of DAMAGE_TAGGING_STAGES) {
              stageResets[`stages.${stageName}.dead`] = false;
              stageResets[`stages.${stageName}.attempts`] = 0;
              stageResets[`stages.${stageName}.last_error`] = null;
            }
            const result = await images.updateMany(filter, {
              $set: stageResets,
            });
            invalidateStatusCache();
            return { ok: true, cleared: result.modifiedCount };
          } catch (err) {
            set.status = 500;
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        { body: t.Optional(t.Object({ id: t.Optional(t.String()) })) },
      )

      .post('/:name/pause', async ({ params, set }) => {
        if (!stageRegistry.has(params.name)) {
          set.status = 404;
          return { error: `unknown stage: ${params.name}` };
        }
        const result = await stageRegistry.pause(params.name);
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
        return { ok: true };
      })

      .post('/:name/resume', async ({ params, set }) => {
        if (!stageRegistry.has(params.name)) {
          set.status = 404;
          return { error: `unknown stage: ${params.name}` };
        }
        const result = await stageRegistry.resume(params.name);
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
        return { ok: true };
      })

      .post('/:name/retry-dead', async ({ params, set }) => {
        if (!stageRegistry.has(params.name)) {
          set.status = 404;
          return { error: `unknown stage: ${params.name}` };
        }
        try {
          const db = await getDb();
          const images = db.collection<ImageDoc>('assets');
          const result = await images.updateMany(
            { [`stages.${params.name}.dead`]: true },
            {
              $set: {
                [`stages.${params.name}.dead`]: false,
                [`stages.${params.name}.attempts`]: 0,
                [`stages.${params.name}.last_error`]: null,
              },
            },
          );
          invalidateStatusCache();
          return { ok: true, reset: result.modifiedCount };
        } catch (err) {
          set.status = 500;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      })

      .patch(
        '/:name/config',
        async ({ params, body, set }) => {
          if (!stageRegistry.has(params.name)) {
            set.status = 404;
            return { error: `unknown stage: ${params.name}` };
          }
          // `pollIntervalMs` / `batchSize` were removed as knobs (#674) — the
          // poll cadence is a global constant and batch size is derived as
          // 5×concurrency. Elysia strips unknown keys before the typed `body`
          // reaches us, so reject them explicitly from the raw payload rather
          // than silently ignoring a caller that still sends them.
          const raw = body as Record<string, unknown>;
          const removed = REMOVED_CONFIG_KEYS.filter((k) => k in raw);
          if (removed.length > 0) {
            set.status = 400;
            return {
              error: `removed config keys not accepted: ${removed.join(', ')}`,
            };
          }
          try {
            const db = await getDb();
            const coll = db.collection('worker_config');
            const repo = new WorkerConfigRepo(coll as never);
            await repo.patch(params.name, body as Partial<WorkerConfig>);
            // Tell the running poll loop to re-read its config from Mongo.
            await stageRegistry.notifyConfigChanged(params.name);
            const savedConfig = await repo.load(params.name);
            invalidateStatusCache();
            return { ok: true, config: savedConfig };
          } catch (err) {
            set.status = 500;
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
        {
          // Loosely-typed body (`additionalProperties: true`, the default) so the
          // removed knobs survive normalization and the handler can 400 on them.
          // The accepted fields are still bounds-validated here; concurrency's
          // ceiling rose 32 → 100 (#674).
          body: t.Object({
            concurrency: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
            maxAttempts: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
            paused: t.Optional(t.Boolean()),
            pollIntervalMs: t.Optional(t.Unknown()),
            batchSize: t.Optional(t.Unknown()),
          }),
        },
      )
  );
}
