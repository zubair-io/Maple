/**
 * Status computation utilities for worker routes.
 *
 * Handles caching, DB state fetching, and status assembly for the /status endpoint.
 */

import { type Collection, type Document, type Filter } from 'mongodb';
import { getDb } from '../db/client.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';
import type { WorkerConfig } from './run-stage.ts';
import { buildClaimQuery } from './run-stage.ts';
import { liveFileInfoElemMatch } from '../indexer/images.repo.ts';
import { deriveBatchSize } from './loop-policy.ts';
import { ALL_STAGE_NAMES } from './stages/manifest.ts';
import { MISSING_REAPER_NAME } from './missing-reaper.ts';
import { MIGRATION_WORKER_NAME } from './migration.ts';
import { DEDUPLICATE_NAME } from './dedupe.ts';
import { DISCOVER_NAME } from './discover/register.ts';
import type { StageStatusSnapshot } from './registry.ts';
import { stageRegistry } from './registry.ts';
import { readWorkerStatus } from './worker-status.repo.ts';
import { child } from '../log.ts';

const log = child('workers:routes:status');

// Names of the version-claim pipeline stages. Other registry entries (e.g.
// the `missing-reaper`, which is registered for pause/resume/status control
// but is NOT a per-asset claim stage) carry no `stages.<name>` subdocument, so
// the pending / dead `countDocuments` below is meaningless for them — and the
// `version: { $exists: false }` branch would match the ENTIRE collection. Gate
// the counts to real claim stages; everything else reports pending/dead 0.
export const CLAIM_STAGE_NAMES = new Set<string>(ALL_STAGE_NAMES);

/**
 * Canonical set of every worker name the status endpoint should surface,
 * regardless of whether a worker process is currently running. Keeps the
 * Workers UI stable (rows never disappear on a worker restart).
 */
export const ALL_KNOWN_WORKER_NAMES: ReadonlyArray<string> = [
  ...ALL_STAGE_NAMES,
  MISSING_REAPER_NAME,
  MIGRATION_WORKER_NAME,
  DEDUPLICATE_NAME,
  DISCOVER_NAME,
];

export const DEAD_LIST_LIMIT_DEFAULT = 50;
export const DEAD_LIST_LIMIT_MAX = 500;

/**
 * Config knobs removed in #674. PATCH rejects these with a 400 so a stale
 * client that still sends them gets a clear signal instead of a silent no-op.
 */
export const REMOVED_CONFIG_KEYS = ['pollIntervalMs', 'batchSize'] as const;

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
  newlyHiddenTotal: number;
};
export const STATUS_CACHE_TTL_MS = 2000;
let statusCache: {
  key: string;
  data: StatusDbState;
  expiresAt: number;
} | null = null;

export function statusCacheKey(
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

export function invalidateStatusCache(): void {
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

export async function fetchStatusDbState(
  stageNames: string[],
  statuses: Record<string, StageStatusSnapshot>,
): Promise<StatusDbState> {
  const configMap = new Map<string, WorkerConfig>();
  const pendingByStage = new Map<string, number>();
  const readyByStage = new Map<string, number>();
  const deadByStage = new Map<string, number>();
  let damagedTotal = 0;
  let newlyHiddenTotal = 0;
  let assets: Collection<Document> | null = null;
  try {
    const db = await getDb();
    assets = db.collection<Document>('assets') as Collection<Document>;
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
        // Prefer the cross-process worker_status snapshot; fall back to the
        // in-process registry (populated in tests + the API-collocated worker
        // path) so that stage count queries use the correct targetVersion.
        const registryEntry = stageRegistry.statuses()[name];
        const tv = statuses[name]?.targetVersion ?? registryEntry?.targetVersion ?? 1;
        const deps = statuses[name]?.dependsOn ?? registryEntry?.dependsOn ?? [];
        const pending = assets!
          .countDocuments({
            $or: [
              { [`stages.${name}.version`]: { $lt: tv } },
              { [`stages.${name}.version`]: { $exists: false } },
            ],
            [`stages.${name}.dead`]: { $ne: true },
            // Require a live location the same way the claim query (`ready`)
            // does. Otherwise `blocked = pending - ready` absorbs the entire
            // no-live-location backlog (the reaper's queue) into every claim
            // stage's blocked count, even though those docs can't be claimed
            // here. The reaper backlog is surfaced separately on the
            // missing-reaper row below.
            ...liveFileInfoElemMatch(),
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
        const readyQuery = buildClaimQuery(name, tv, deps, new Set()) as Filter<Document>;
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
  // pruning a large backlog. Surface the real tagged count as its `pending` so
  // the Workers UI reflects the work queue instead of 0/0/0. Matches the
  // reaper's own scan exactly: rows with any per-entry `missing_since` string,
  // using the `fileinfo_missing_since_1` partial index instead of a COLLSCAN.
  if (assets && stageNames.includes('missing-reaper')) {
    try {
      const pending = await assets.countDocuments({
        'fileinfo.missing_since': { $type: 'string' },
      });
      pendingByStage.set('missing-reaper', pending);
      readyByStage.set('missing-reaper', pending);
    } catch (err) {
      log.warn({ err }, 'countDocuments failed for missing-reaper tagged count — leaving 0');
    }
  }

  // The `migration` worker is likewise not a claim stage. Surface the sum of
  // remaining work across its ENABLED migrations as `pending` so the Workers UI
  // shows the live queue instead of 0/0/0 while a migration is running.
  if (stageNames.includes('migration')) {
    try {
      const { migrationPendingCount } = await import('./migration.ts');
      const pending = await migrationPendingCount();
      pendingByStage.set('migration', pending);
      readyByStage.set('migration', pending);
    } catch (err) {
      log.warn({ err }, 'could not compute migration pending count — leaving 0');
    }
  }

  // `deduplicate` is not a claim stage either. Surface the count of assets with
  // ≥2 *live* fileinfo entries as `pending` so the Workers UI badge reflects
  // what the worker can actually act on and can reach 0 from deduplicate alone
  // (#1290, #1302).
  //
  // Query plan (#1302): `live_location_count_gte2` is a partial index whose
  // filter is `{ live_location_count: { $gte: 2 } }`, so this countDocuments
  // is answered by an index COUNT_SCAN with no per-row FETCH — replacing the
  // `$expr`+`$filter` scan that `liveAwareDuplicatePredicate` required. The
  // predicate for the count is the indexed field; `liveAwareDuplicatePredicate`
  // is kept as the correctness reference (used by the worker's candidate find
  // and by the parity test in live-location-count.test.ts).
  //
  // Fallback: assets missing `live_location_count` (pre-migration) are not
  // in the partial index and are excluded from the count until the
  // `backfill-live-location-count` migration runs. The migration's pending
  // count on the Workers UI signals this state to operators.
  if (assets && stageNames.includes(DEDUPLICATE_NAME)) {
    try {
      const pending = await assets.countDocuments({
        live_location_count: { $gte: 2 },
      });
      pendingByStage.set(DEDUPLICATE_NAME, pending);
      readyByStage.set(DEDUPLICATE_NAME, pending);
    } catch (err) {
      log.warn({ err }, 'countDocuments failed for deduplicate pending count — leaving 0');
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
      newlyHiddenTotal = await assets.countDocuments({
        hidden: true,
        hidden_ack: false,
        hidden_reason: { $in: ['nudity', 'nudity-burst'] },
      });
    } catch (err) {
      log.warn({ err }, 'countDocuments failed for damaged/newlyHidden counts — leaving 0');
    }
  }

  return { configMap, pendingByStage, readyByStage, deadByStage, damagedTotal, newlyHiddenTotal };
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
  newlyHiddenTotal: number;
}

/**
 * Resolve the DB-derived half of `/status` through the shared cache. Exposed
 * so the WS broadcaster (routes/events.ts) reuses the exact same cache + count
 * queries instead of duplicating ~4×nStages countDocuments per tab.
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
 * `workers-status` frame so both render identically.
 *
 * Iterates the UNION of `ALL_KNOWN_WORKER_NAMES`, `Object.keys(statuses)`,
 * and the dbState map keys, so every known worker always appears in the
 * response — even when the worker process is not running (statuses is empty
 * or missing that name). Workers absent from `statuses` default to
 * `status: 'stopped'` with zeroed live fields. */
export function assembleWorkersStatus(
  statuses: Record<string, StageStatusSnapshot>,
  dbState: StatusDbState,
): WorkersStatusPayload {
  // Build the full set of names to surface.
  const nameSet = new Set<string>([
    ...ALL_KNOWN_WORKER_NAMES,
    ...Object.keys(statuses),
    ...dbState.configMap.keys(),
    ...dbState.pendingByStage.keys(),
  ]);

  const stages = Array.from(nameSet).map((name) => {
    const s = statuses[name];
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
      status: s?.status ?? ('stopped' as const),
      inFlight: s?.inFlight ?? 0,
      configured,
      pending,
      ready,
      blocked,
      dead,
      throughput: s?.throughput ?? 0,
      lastError: s?.lastError ?? null,
      config,
      batchSize,
    };
  });
  return { stages, damaged: dbState.damagedTotal, newlyHiddenTotal: dbState.newlyHiddenTotal };
}

/** Full `/status` payload, resolving the DB half through the shared cache.
 *
 * The live stage state comes from the `worker_status` Mongo doc written by the
 * worker process (~2 s interval).  The API process no longer holds a populated
 * in-process registry — reading it there would always return an empty map.
 * DB-derived counts (pending / ready / dead / config) are unchanged: they come
 * from `getStatusDbStateCached` which queries Mongo directly.
 *
 * Always passes the full `ALL_KNOWN_WORKER_NAMES` union as stageNames so that
 * DB-derived pending/dead counts are fetched for every stage even when no
 * worker process is running (statuses may be empty). */
export async function computeWorkersStatus(): Promise<WorkersStatusPayload> {
  const statuses = (await readWorkerStatus())?.statuses ?? {};
  // Union of live worker names and the static known set so DB counts are
  // fetched for every stage regardless of whether a worker process is up.
  const stageNames = Array.from(new Set([...ALL_KNOWN_WORKER_NAMES, ...Object.keys(statuses)]));
  const dbState = await getStatusDbStateCached(stageNames, statuses);
  return assembleWorkersStatus(statuses, dbState);
}
