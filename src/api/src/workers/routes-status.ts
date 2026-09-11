/**
 * Status assembly for `GET /api/workers/status` and the WS `workers-status`
 * frame.
 *
 * Everything here is cheap by construction (#3491): the live registry half
 * (status / inFlight / throughput / lastError) and the DB-derived counts
 * (pending / ready / dead / damaged / newly-hidden) both arrive in ONE
 * `worker_status` document that the worker process keeps up to date — see
 * `status-counts.ts` for how and when the counts are computed. The only other
 * reads are the tiny `worker_config` collection and the migration state doc.
 */

import { getDb } from '../db/client.ts';
import type { WorkerConfigDoc } from './worker-config.repo.ts';
import type { WorkerConfig } from './run-stage.ts';
import { deriveBatchSize } from './loop-policy.ts';
import { MIGRATION_WORKER_NAME } from './migration.ts';
import type { StageStatusSnapshot } from './registry.ts';
import {
  pokeStatusCountsDemand,
  readWorkerStatus,
  type StatusCountsSnapshot,
} from './worker-status.repo.ts';
import { ALL_KNOWN_WORKER_NAMES } from './status-counts.ts';
import { enabledRemainingTotal, loadAllMigrationStates } from './migration-config.repo.ts';

export { ALL_KNOWN_WORKER_NAMES } from './status-counts.ts';

export const DEAD_LIST_LIMIT_DEFAULT = 50;
export const DEAD_LIST_LIMIT_MAX = 500;

/**
 * Config knobs removed in #674. PATCH rejects these with a 400 so a stale
 * client that still sends them gets a clear signal instead of a silent no-op.
 */
export const REMOVED_CONFIG_KEYS = ['pollIntervalMs', 'batchSize'] as const;

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
    ...(typeof doc.pause_reason === 'string' ? { pause_reason: doc.pause_reason } : {}),
  };
}

// ── Demand signal ───────────────────────────────────────────────────────────

/** How long one poke keeps the worker in "watched" cadence. */
export const COUNTS_DEMAND_WINDOW_MS = 30_000;
/** Pokes closer together than this are dropped (one tiny write per window). */
const COUNTS_DEMAND_POKE_THROTTLE_MS = 5_000;
let lastDemandPokeAt = 0;

/**
 * Tell the worker someone is looking at the Workers page. Called from the
 * HTTP status + migrations routes and the WS broadcaster tick. Throttled and
 * best-effort: a failed poke only delays a refresh, never a response.
 */
export async function requestStatusCounts(now: number = Date.now()): Promise<void> {
  if (now - lastDemandPokeAt < COUNTS_DEMAND_POKE_THROTTLE_MS) return;
  lastDemandPokeAt = now;
  await pokeStatusCountsDemand(now + COUNTS_DEMAND_WINDOW_MS).catch(() => {});
}

/** Test-only: forget the throttle so the next poke is not dropped. */
export function _resetDemandThrottleForTests(): void {
  lastDemandPokeAt = 0;
}

// ── Assembly ────────────────────────────────────────────────────────────────

export type StatusDbState = {
  configMap: Map<string, WorkerConfig>;
  /** The worker's persisted counts, or null when it has not counted yet. */
  counts: StatusCountsSnapshot | null;
  /** Sum of `remaining` over enabled migrations — the `migration` row's pending. */
  migrationPending: number;
};

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
  /** Epoch ms when the pending / ready / dead / damaged counts were computed,
   * or null when the worker has not counted yet (every count reads 0). */
  countsAt: number | null;
}

async function loadConfigMap(): Promise<Map<string, WorkerConfig>> {
  const configMap = new Map<string, WorkerConfig>();
  try {
    const db = await getDb();
    const allConfigs = await db.collection<WorkerConfigDoc>('worker_config').find({}).toArray();
    // Sanitize before exposing: strip any removed knobs that linger on older
    // docs so they don't leak through /status or the WS status frame.
    for (const cfg of allConfigs) configMap.set(cfg.name, sanitizeWorkerConfig(cfg));
  } catch {
    // DB unavailable — configMap empty.
  }
  return configMap;
}

/** Compose the per-stage status rows from the live registry + persisted
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
  const counts = dbState.counts;
  const nameSet = new Set<string>([
    ...ALL_KNOWN_WORKER_NAMES,
    ...Object.keys(statuses),
    ...dbState.configMap.keys(),
    ...Object.keys(counts?.pending ?? {}),
  ]);

  const stages = Array.from(nameSet).map((name) => {
    const s = statuses[name];
    const pending =
      name === MIGRATION_WORKER_NAME ? dbState.migrationPending : (counts?.pending[name] ?? 0);
    const ready =
      name === MIGRATION_WORKER_NAME ? dbState.migrationPending : (counts?.ready[name] ?? 0);
    // pending and ready are counted by separate (non-atomic) queries, so
    // clamp the derived blocked count to avoid a transient negative.
    const blocked = Math.max(0, pending - ready);
    const dead = counts?.dead[name] ?? 0;
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
  return {
    stages,
    damaged: counts?.damaged ?? 0,
    newlyHiddenTotal: counts?.newly_hidden ?? 0,
    countsAt: counts?.computed_at ?? null,
  };
}

/** Full `/status` payload: one `worker_status` read (registry snapshot +
 * persisted counts), the `worker_config` rows, and the migration state doc.
 * No `countDocuments` anywhere on this path. */
export async function computeWorkersStatus(): Promise<WorkersStatusPayload> {
  const [snap, configMap, migrationStates] = await Promise.all([
    readWorkerStatus(),
    loadConfigMap(),
    loadAllMigrationStates(),
  ]);
  return assembleWorkersStatus(snap?.statuses ?? {}, {
    configMap,
    counts: snap?.counts ?? null,
    migrationPending: enabledRemainingTotal(migrationStates),
  });
}
