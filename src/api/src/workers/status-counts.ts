/**
 * DB-derived counts for the Workers page, computed in the WORKER process and
 * persisted — never on the request path (#3491).
 *
 * `GET /api/workers/status` used to run ~38 `countDocuments` in parallel on
 * every page load, and `GET /api/workers/migration/migrations` ran every
 * migration's `countRemaining()`. On a 335k-asset library several of those were
 * multi-second scans, so both endpoints took ~8 s and an open Workers tab kept
 * the database saturated. Now:
 *
 *  - `computeStatusCounts()` runs the per-stage pending / ready / dead counts
 *    plus the collection-level totals, SEQUENTIALLY (one query in flight at a
 *    time, so a refresh never starves real requests), and the result is written
 *    to the `worker_status` row.
 *  - `runMigrationCountsPass()` does the same for every migration's
 *    `remaining` (and `failedPermanently`), persisted on the migration state.
 *  - `startStatusCountsRefresher()` drives both on a demand-aware cadence: the
 *    API bumps `counts_wanted_until` while someone is looking at the page, and
 *    only then do the passes run quickly (backing off in proportion to how long
 *    the last pass took). Idle, stage counts refresh every 10 min and migration
 *    counts not at all (the migration worker persists `remaining` itself for
 *    every enabled migration on each tick).
 *
 * The API reads the snapshot with one keyed read (`routes-status.ts`).
 *
 * ## What the SQLite cutover changed here, and what it did not
 *
 * The counts are cheap now — `stage_dead` answers a dead count from the index
 * alone, and pending / ready are range scans of `stage_claim` — but they still
 * run here and are still persisted. The contract was never about the cost of
 * one count; it is that the request path does not go near the backlog. A future
 * reader tempted to move `countStageBacklog` into the route because it is fast
 * should read #3491 first.
 */
import { countStageBacklog, type StageBacklogQuery } from '../db/sqlite/repos/stage-state.repo.ts';
import {
  countDamagedAssets,
  countDuplicateAssets,
  countMissingTaggedAssets,
  countNewlyHiddenAssets,
} from '../db/sqlite/repos/worker-admin.repo.ts';
import { ALL_STAGE_NAMES, stageManifest } from './stages/manifest.ts';
import { MISSING_REAPER_NAME } from './missing-reaper.ts';
import { MIGRATION_WORKER_NAME } from './migration.ts';
import { DEDUPLICATE_NAME } from './dedupe.ts';
import { DISCOVER_NAME } from './discover/register.ts';
import type { StageStatusSnapshot } from './registry.ts';
import { stageRegistry } from './registry.ts';
import {
  readStatusCountsDemand,
  writeStatusCounts,
  type StatusCountsSnapshot,
} from '../db/sqlite/repos/worker-status.repo.ts';
import { MIGRATIONS } from './migration/index.ts';
import type { Migration } from './migration/types.ts';
import { patchMigrationState, type MigrationState } from './migration-config.repo.ts';
import { child } from '../log.ts';

const log = child('workers:status-counts');

/**
 * Names of the version-claim pipeline stages.
 *
 * Other registry entries — the `missing-reaper`, registered for pause/resume
 * and status control but not a per-asset claim stage — have no `stage_state`
 * rows at all, so a backlog count is meaningless for them. They report
 * pending/dead 0 unless one of the special cases below fills them in.
 */
const CLAIM_STAGE_NAMES = new Set<string>(ALL_STAGE_NAMES);

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

/**
 * name → the stage's optional extra claim predicate (`StageConfig.claimResidual`).
 *
 * The pending/ready counts apply it too, or a media-only stage like `transcribe`
 * reports the entire photo library as pending forever — assets it never claims,
 * and therefore never marks done, would otherwise sit in the count indefinitely
 * and defeat the operator diagnosis the split exists to give.
 */
const CLAIM_RESIDUAL_BY_STAGE = new Map(
  stageManifest.map((stage) => [stage.name, stage.claimResidual]),
);

/** Count one stage's backlog, reporting zeros rather than failing the pass. */
async function safeBacklog(query: StageBacklogQuery) {
  try {
    return await countStageBacklog(query);
  } catch (err) {
    log.warn({ stage: query.stage, err }, 'stage backlog count failed — reporting 0');
    return { pending: 0, ready: 0, dead: 0 };
  }
}

/** One collection-level count, reporting 0 rather than failing the pass. */
async function safeCount(count: () => Promise<number>, label: string): Promise<number> {
  try {
    return await count();
  } catch (err) {
    log.warn({ count: label, err }, 'count failed — reporting 0');
    return 0;
  }
}

/**
 * Compute every count the Workers page shows. Queries run one at a time on
 * purpose: this is background work, and a 38-wide parallel burst is exactly
 * what used to saturate the database while the page was open.
 *
 * `statuses` supplies each stage's targetVersion / dependsOn (the worker's own
 * registry snapshot in production; tests pass an explicit map). Stages absent
 * from it fall back to the in-process registry, then to version 1.
 */
export async function computeStatusCounts(
  stageNames: readonly string[],
  statuses: Record<string, StageStatusSnapshot>,
): Promise<StatusCountsSnapshot> {
  const startedAt = Date.now();
  const pending: Record<string, number> = {};
  const ready: Record<string, number> = {};
  const dead: Record<string, number> = {};

  for (const name of stageNames) {
    if (!CLAIM_STAGE_NAMES.has(name)) continue;
    const registryEntry = stageRegistry.statuses()[name];
    const backlog = await safeBacklog({
      stage: name,
      targetVersion: statuses[name]?.targetVersion ?? registryEntry?.targetVersion ?? 1,
      dependsOn: statuses[name]?.dependsOn ?? registryEntry?.dependsOn ?? [],
      residual: CLAIM_RESIDUAL_BY_STAGE.get(name),
    });
    pending[name] = backlog.pending;
    ready[name] = backlog.ready;
    dead[name] = backlog.dead;
  }

  // Two workers whose queue is a property of the asset rather than a stage row.
  if (stageNames.includes(MISSING_REAPER_NAME)) {
    const tagged = await safeCount(countMissingTaggedAssets, 'missing-reaper');
    pending[MISSING_REAPER_NAME] = tagged;
    ready[MISSING_REAPER_NAME] = tagged;
  }
  if (stageNames.includes(DEDUPLICATE_NAME)) {
    const dupes = await safeCount(countDuplicateAssets, 'deduplicate');
    pending[DEDUPLICATE_NAME] = dupes;
    ready[DEDUPLICATE_NAME] = dupes;
  }

  const damaged = await safeCount(countDamagedAssets, 'damaged');
  const newlyHidden = await safeCount(countNewlyHiddenAssets, 'newly-hidden');
  const computedAt = Date.now();
  return {
    pending,
    ready,
    dead,
    damaged,
    newly_hidden: newlyHidden,
    computed_at: computedAt,
    duration_ms: computedAt - startedAt,
  };
}

/** One full stage-counts pass against the worker's own registry, persisted. */
export async function runStatusCountsPass(): Promise<StatusCountsSnapshot> {
  const statuses = stageRegistry.statuses();
  const stageNames = Array.from(new Set([...ALL_KNOWN_WORKER_NAMES, ...Object.keys(statuses)]));
  const counts = await computeStatusCounts(stageNames, statuses);
  await writeStatusCounts(counts);
  return counts;
}

/** The persisted-count fields one migration pass writes. */
export async function countMigration(
  m: Migration,
  nowIso: string,
): Promise<Partial<MigrationState>> {
  const patch: Partial<MigrationState> = {};
  try {
    patch.remaining = await m.countRemaining();
    patch.remaining_at = nowIso;
  } catch (err) {
    log.warn({ migration: m.id, err }, 'countRemaining failed — leaving the last value');
  }
  if (m.countFailedPermanently) {
    try {
      patch.failed_permanently = await m.countFailedPermanently();
    } catch (err) {
      log.warn({ migration: m.id, err }, 'countFailedPermanently failed — leaving the last value');
    }
  }
  return patch;
}

/** Refresh `remaining` for every registered migration, one at a time. */
export async function runMigrationCountsPass(
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  for (const m of migrations) {
    const patch = await countMigration(m, new Date().toISOString());
    if (Object.keys(patch).length === 0) continue;
    try {
      await patchMigrationState(m.id, patch);
    } catch (err) {
      log.warn({ migration: m.id, err }, 'could not persist migration counts');
    }
  }
}

// ── Cadence ─────────────────────────────────────────────────────────────────

/** How often the refresher checks the demand flag. */
const REFRESH_POLL_MS = 2_000;
/** Stage counts while watched: at least this often … */
export const STAGE_COUNTS_MIN_INTERVAL_MS = 5_000;
/** … and at most this rarely, however slow the last pass was. */
export const STAGE_COUNTS_MAX_INTERVAL_MS = 120_000;
/** Stage counts while nobody is watching. */
export const STAGE_COUNTS_IDLE_INTERVAL_MS = 10 * 60_000;
export const MIGRATION_COUNTS_MIN_INTERVAL_MS = 30_000;
const MIGRATION_COUNTS_MAX_INTERVAL_MS = 300_000;
/** A pass that took T ms earns a rest of BACKOFF_FACTOR × T (clamped). */
export const BACKOFF_FACTOR = 3;

export function nextDelayMs(lastDurationMs: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(minMs, lastDurationMs * BACKOFF_FACTOR));
}

export interface RefreshClock {
  /** When the refresher started — the idle cadence counts from here so a fresh
   * worker doesn't spend its first minute counting; a demand poke still gets an
   * immediate first pass. */
  bootAt: number;
  lastStageRunAt: number;
  lastStageDurationMs: number;
  lastMigrationRunAt: number;
  lastMigrationDurationMs: number;
}

/** Which passes are due at `now`, given the demand deadline and history. */
export function dueRefreshes(
  now: number,
  wantedUntil: number,
  clock: RefreshClock,
): { stage: boolean; migration: boolean } {
  const watched = wantedUntil > now;
  const stageDelay = watched
    ? nextDelayMs(
        clock.lastStageDurationMs,
        STAGE_COUNTS_MIN_INTERVAL_MS,
        STAGE_COUNTS_MAX_INTERVAL_MS,
      )
    : STAGE_COUNTS_IDLE_INTERVAL_MS;
  const migrationDelay = nextDelayMs(
    clock.lastMigrationDurationMs,
    MIGRATION_COUNTS_MIN_INTERVAL_MS,
    MIGRATION_COUNTS_MAX_INTERVAL_MS,
  );
  const stageFrom = watched ? clock.lastStageRunAt : Math.max(clock.lastStageRunAt, clock.bootAt);
  return {
    stage: now >= stageFrom + stageDelay,
    migration: watched && now >= clock.lastMigrationRunAt + migrationDelay,
  };
}

export interface RefresherDeps {
  pollMs?: number;
  now?: () => number;
  readDemand?: () => Promise<number>;
  stagePass?: () => Promise<unknown>;
  migrationPass?: () => Promise<unknown>;
}

export interface RefresherHandle {
  stop(): void;
  /** Test hook: run one poll iteration now (no timer). */
  _pollForTests(): Promise<void>;
}

/**
 * Start the demand-aware refresh loop. Iterations never overlap: the next poll
 * is scheduled only after the current one (including any pass it ran) has
 * finished, so a slow pass simply delays the next check.
 */
export function startStatusCountsRefresher(deps: RefresherDeps = {}): RefresherHandle {
  const pollMs = deps.pollMs ?? REFRESH_POLL_MS;
  const now = deps.now ?? Date.now;
  const readDemand = deps.readDemand ?? (() => readStatusCountsDemand());
  const stagePass = deps.stagePass ?? runStatusCountsPass;
  const migrationPass = deps.migrationPass ?? runMigrationCountsPass;
  const clock: RefreshClock = {
    bootAt: now(),
    lastStageRunAt: 0,
    lastStageDurationMs: 0,
    lastMigrationRunAt: 0,
    lastMigrationDurationMs: 0,
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const runPass = async (
    label: 'stage' | 'migration',
    pass: () => Promise<unknown>,
  ): Promise<number> => {
    const startedAt = now();
    try {
      await pass();
    } catch (err) {
      log.warn({ pass: label, err }, 'status counts pass failed');
    }
    return now() - startedAt;
  };

  const poll = async (): Promise<void> => {
    const due = dueRefreshes(now(), await readDemand(), clock);
    if (due.stage && !stopped) {
      clock.lastStageRunAt = now();
      clock.lastStageDurationMs = await runPass('stage', stagePass);
    }
    if (due.migration && !stopped) {
      clock.lastMigrationRunAt = now();
      clock.lastMigrationDurationMs = await runPass('migration', migrationPass);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void poll()
        .catch((err) => log.warn({ err }, 'status counts poll failed'))
        .finally(schedule);
    }, pollMs);
    timer.unref?.();
  };
  schedule();
  log.info({ pollMs }, 'status counts refresher started');

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    _pollForTests: poll,
  };
}
