/**
 * DB-derived counts for the Workers page, computed in the WORKER process and
 * persisted — never on the request path (#3491).
 *
 * `GET /api/workers/status` used to run ~38 `countDocuments` in parallel on
 * every page load, and `GET /api/workers/migration/migrations` ran every
 * migration's `countRemaining()`. On a 335k-asset library several of those are
 * multi-second scans (a case-insensitive filename regex is never filtered at a
 * multikey index, and `$ne` done-markers / `$exists: false` have no index
 * shape at all), so both endpoints took ~8 s and an open Workers tab kept the
 * DB saturated. Now:
 *
 *  - `computeStatusCounts()` runs the per-stage pending / ready / dead counts
 *    plus the collection-level totals, SEQUENTIALLY (one query in flight at a
 *    time, so a refresh never starves real requests), and the result is
 *    written to `worker_status.counts`.
 *  - `runMigrationCountsPass()` does the same for every migration's
 *    `remaining` (and `failedPermanently`), persisted on the migration state.
 *  - `startStatusCountsRefresher()` drives both on a demand-aware cadence: the
 *    API bumps `counts_wanted_until` while someone is looking at the page, and
 *    only then do the passes run quickly (backing off in proportion to how
 *    long the last pass took). Idle, stage counts refresh every 10 min and
 *    migration counts not at all (the migration worker persists `remaining`
 *    itself for every enabled migration on each tick).
 *
 * The API reads the snapshot with a single `findOne` (`routes-status.ts`).
 */
import { type Collection, type Document, type Filter } from 'mongodb';
import { getDb } from '../db/client.ts';
import { buildClaimQuery } from './claim-query.ts';
import { liveFileInfoElemMatch } from '../indexer/images.repo.ts';
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
} from './worker-status.repo.ts';
import { MIGRATIONS } from './migration/index.ts';
import type { Migration } from './migration/types.ts';
import { patchMigrationState, type MigrationState } from './migration-config.repo.ts';
import { child } from '../log.ts';

const log = child('workers:status-counts');

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

/**
 * name → the stage's optional extra claim predicate (`StageConfig.claimFilter`).
 * The `pending`/`ready` counts must apply it too, or a media-only stage like
 * `transcribe` reports the entire photo library as pending forever — docs it
 * never claims (and, with the filter, never marks done) would otherwise sit in
 * the count indefinitely, defeating the operator diagnosis the filter exists
 * to give. `undefined` for stages without one → counts are unchanged.
 */
const CLAIM_FILTER_BY_STAGE = new Map(stageManifest.map((s) => [s.name, s.claimFilter]));

/**
 * Build the `pending` and `ready` count queries for one claim stage. Applies
 * the stage's optional `claimFilter` to BOTH so the counts match what the
 * runner actually claims (a media-only stage must not count the whole library
 * as pending).
 */
export function stageCountQueries(
  name: string,
  tv: number,
  deps: Parameters<typeof buildClaimQuery>[2],
): { pendingQuery: Filter<Document>; readyQuery: Filter<Document> } {
  const claimFilter = CLAIM_FILTER_BY_STAGE.get(name);
  const pendingBase = {
    $or: [
      { [`stages.${name}.version`]: { $lt: tv } },
      { [`stages.${name}.version`]: { $exists: false } },
    ],
    [`stages.${name}.dead`]: { $ne: true },
    // Require a live location the same way the claim query (`ready`) does, so
    // `blocked = pending - ready` doesn't absorb the no-live-location backlog
    // (the reaper's queue) into every claim stage's blocked count.
    ...liveFileInfoElemMatch(),
  };
  // The claimFilter is $and-merged (not spread) so it can't collide with the
  // base query's own `fileinfo`/`$or` keys — same reasoning as buildClaimQuery.
  return {
    pendingQuery: (claimFilter
      ? { $and: [pendingBase, claimFilter] }
      : pendingBase) as Filter<Document>,
    readyQuery: buildClaimQuery(name, tv, deps, new Set(), claimFilter) as Filter<Document>,
  };
}

async function safeCount(
  assets: Collection<Document>,
  filter: Filter<Document>,
  label: string,
): Promise<number> {
  try {
    return await assets.countDocuments(filter);
  } catch (err) {
    log.warn({ count: label, err }, 'countDocuments failed — reporting 0');
    return 0;
  }
}

/**
 * Compute every count the Workers page shows. Queries run one at a time on
 * purpose: this is background work, and a 38-wide parallel burst is exactly
 * what used to saturate the DB while the page was open.
 *
 * `statuses` supplies each stage's targetVersion / dependsOn (the worker's
 * own registry snapshot in production; tests pass an explicit map). Stages
 * absent from it fall back to the in-process registry, then to version 1.
 */
export async function computeStatusCounts(
  stageNames: readonly string[],
  statuses: Record<string, StageStatusSnapshot>,
): Promise<StatusCountsSnapshot> {
  const startedAt = Date.now();
  const pending: Record<string, number> = {};
  const ready: Record<string, number> = {};
  const dead: Record<string, number> = {};
  const assets = await getDb()
    .then((db) => db.collection<Document>('assets'))
    .catch(() => null);
  if (!assets) {
    // DB unavailable — zeros, stamped so the reader can still tell "counted,
    // nothing there" from "never counted".
    return {
      pending,
      ready,
      dead,
      damaged: 0,
      newly_hidden: 0,
      computed_at: startedAt,
      duration_ms: 0,
    };
  }

  for (const name of stageNames) {
    if (!CLAIM_STAGE_NAMES.has(name)) continue;
    const registryEntry = stageRegistry.statuses()[name];
    const tv = statuses[name]?.targetVersion ?? registryEntry?.targetVersion ?? 1;
    const deps = statuses[name]?.dependsOn ?? registryEntry?.dependsOn ?? [];
    const { pendingQuery, readyQuery } = stageCountQueries(name, tv, deps);
    pending[name] = await safeCount(assets, pendingQuery, `${name}.pending`);
    ready[name] = await safeCount(assets, readyQuery, `${name}.ready`);
    dead[name] = await safeCount(assets, { [`stages.${name}.dead`]: true }, `${name}.dead`);
  }

  if (stageNames.includes(MISSING_REAPER_NAME)) {
    const tagged = await safeCount(
      assets,
      { 'fileinfo.missing_since': { $type: 'string' } },
      'missing-reaper',
    );
    pending[MISSING_REAPER_NAME] = tagged;
    ready[MISSING_REAPER_NAME] = tagged;
  }
  if (stageNames.includes(DEDUPLICATE_NAME)) {
    const dupes = await safeCount(assets, { live_location_count: { $gte: 2 } }, 'deduplicate');
    pending[DEDUPLICATE_NAME] = dupes;
    ready[DEDUPLICATE_NAME] = dupes;
  }
  const damaged = await safeCount(assets, { 'damaged.since': { $type: 'string' } }, 'damaged');
  const newlyHidden = await safeCount(
    assets,
    { hidden: true, hidden_ack: false, hidden_reason: { $in: ['nudity', 'nudity-burst'] } },
    'newly-hidden',
  );
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
export const REFRESH_POLL_MS = 2_000;
/** Stage counts while watched: at least this often … */
export const STAGE_COUNTS_MIN_INTERVAL_MS = 5_000;
/** … and at most this rarely, however slow the last pass was. */
export const STAGE_COUNTS_MAX_INTERVAL_MS = 120_000;
/** Stage counts while nobody is watching. */
export const STAGE_COUNTS_IDLE_INTERVAL_MS = 10 * 60_000;
export const MIGRATION_COUNTS_MIN_INTERVAL_MS = 30_000;
export const MIGRATION_COUNTS_MAX_INTERVAL_MS = 300_000;
/** A pass that took T ms earns a rest of BACKOFF_FACTOR × T (clamped). */
export const BACKOFF_FACTOR = 3;

export function nextDelayMs(lastDurationMs: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(minMs, lastDurationMs * BACKOFF_FACTOR));
}

export interface RefreshClock {
  /** When the refresher started — the idle cadence counts from here so a
   * fresh worker doesn't spend its first minute counting; a demand poke
   * still gets an immediate first pass. */
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
 * Start the demand-aware refresh loop. Iterations never overlap: the next
 * poll is scheduled only after the current one (including any pass it ran)
 * has finished, so a slow pass simply delays the next check.
 */
export function startStatusCountsRefresher(deps: RefresherDeps = {}): RefresherHandle {
  const pollMs = deps.pollMs ?? REFRESH_POLL_MS;
  const now = deps.now ?? Date.now;
  const readDemand = deps.readDemand ?? readStatusCountsDemand;
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
