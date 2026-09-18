/**
 * The stage-state table's non-claim verbs — the SQLite port of
 * `workers/stages/manifest.ts`'s `blankStagesSkeleton`, of
 * `stage-config.ts`'s `versionBumpReset`, and of the per-stage counts
 * `workers/status-counts.ts` persists (#3748).
 *
 * ## Registering a stage is an insert
 *
 * On Mongo a stage is registered by declaring two indexes on `assets` —
 * `stage_<name>_version` and a partial `stage_<name>_dead` — which the next
 * boot rebuilds over the whole collection. Fifteen stages is 24 of the 50
 * indexes the collection carries, plus the ones for stages that were retired
 * and never dropped. Here the stage name is data in a column, two indexes
 * serve every stage, and {@link registerStage} is one `INSERT … SELECT`.
 *
 * ## Rows are seeded, not lazy
 *
 * {@link seedStageRows} is the counterpart of the `stages` skeleton the
 * discover producer writes onto every new asset, and it exists for a sharper
 * reason than symmetry. On Mongo a missing `stages.<name>` subdocument is
 * claimable, because BSON orders a missing field below any number so
 * `{ version: { $lt: target } }` matches it. The SQL equivalent of that is an
 * anti-join against `assets`, which cannot use an index on `stage_state` at
 * all. A seeded row makes the claim a plain index range scan instead —
 * measured at 0.05 ms for 500 candidates over 12 million rows.
 *
 * ## Defaults here say "nobody has chosen yet", and that is checked
 *
 * `version`, `attempts` and `dead` all default to 0, and none of them has the
 * ambiguity that forced `worker_config`'s scalars to be relaxed to nullable in
 * #3751's migration `0003`: there, `paused = 0` by default is indistinguishable
 * from an operator actively resuming a worker, which would silently defeat
 * `pausedOnFirstBoot`. Nothing like that applies to these three. Zero means "not
 * processed", "no attempts spent" and "not parked", and every writer that sets
 * one back to zero means exactly that — a re-arm, a retry reset, a cleared
 * dead-letter. There is no second sense an operator could intend.
 *
 * "Registered but unprocessed" and "not registered for this stage" stay
 * distinguishable too, because the row's existence carries that: dense seeding
 * is what makes a missing row mean the stage was never registered for the asset
 * rather than that it has nothing to do.
 *
 * The one column carrying two meanings is `next_attempt_at`, which holds both a
 * claim lease and a retry backoff — deliberately, since they are the same gate.
 * They remain tellable apart if anything ever needs to: only the failure path
 * writes `failed_at`.
 *
 * ## Counts stay persisted by the worker
 *
 * {@link countStageBacklog} is cheap: `stage_dead` answers the dead count from
 * the index alone, and pending and ready are range scans of `stage_claim`. It is still
 * meant to be called from the worker's own refresh pass and written to
 * `worker_status`, never from `GET /api/workers/status`. The reason is the
 * contract rather than the cost — the demand flag (`counts_wanted_until`), the
 * worker-side pass and the single `findOne` the endpoint does instead are one
 * mechanism, and re-deriving counts on the request path is what made that
 * endpoint an 8-second stall (#3491).
 */

import type { SqlStatement } from '../protocol.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';
import type { StageClaimResidual } from './stage-claim.ts';
import type { ResolvedStageDep } from './stage-claim.ts';
import {
  REGISTER_STAGE_SQL,
  SEED_STAGE_ROW_SQL,
  STAGE_DEAD_COUNT_SQL,
  STAGE_VERSION_BUMP_RESET_SQL,
  stagePendingCountSql,
  stageReadyCountSql,
} from './stage-runtime.sql.ts';

/**
 * One row per registered stage for a newly created asset, all at version 0.
 *
 * Returned as statements rather than executed, because the caller that needs
 * them is asset creation, which writes the asset row and its locations in the
 * same transaction — a seeded stage row for an asset that does not exist yet
 * would be rejected by the foreign key and would roll that transaction back.
 */
export function seedStageRowStatements(assetId: string, stages: readonly string[]): SqlStatement[] {
  return stages.map((stage) => ({ sql: SEED_STAGE_ROW_SQL, params: [assetId, stage] }));
}

/** Seed one asset's stage rows on their own. Idempotent. */
export async function seedStageRows(
  assetId: string,
  stages: readonly string[],
  dbOverride?: SqliteDb,
): Promise<void> {
  if (stages.length === 0) return;
  await assetsDb(dbOverride).transaction(seedStageRowStatements(assetId, stages));
}

/**
 * Give every existing asset a row for `stage`, so assets that predate the
 * stage become eligible for it.
 *
 * This is the whole cost of registering a stage, and it is what the schema
 * means by "an insert". Returns how many rows it created, which is zero on
 * every boot after the first — the conflict clause makes a re-run free rather
 * than an error to swallow.
 */
export async function registerStage(stage: string, dbOverride?: SqliteDb): Promise<number> {
  const result = await assetsDb(dbOverride).write(REGISTER_STAGE_SQL, [stage]);
  return result.changes;
}

/** Register every stage in the manifest. Returns rows created per stage. */
export async function registerStages(
  stages: readonly string[],
  dbOverride?: SqliteDb,
): Promise<Record<string, number>> {
  const db = assetsDb(dbOverride);
  const entries: Array<[string, number]> = [];
  for (const stage of stages) entries.push([stage, await registerStage(stage, db)]);
  return Object.fromEntries(entries);
}

/**
 * Re-queue everything below a newly raised target version: dead-letter flags
 * lifted, attempt counts and retry gates cleared.
 *
 * Runs once per stage on boot when `targetVersion` exceeds the last the runner
 * saw. Rows already at or above the new target are untouched — they are done.
 *
 * It does not touch `next_attempt_at`, which is what keeps it from revoking a
 * claim the outgoing process is still holding across a restart. See
 * `STAGE_VERSION_BUMP_RESET_SQL` for why that costs nothing.
 */
export async function versionBumpReset(
  stage: string,
  targetVersion: number,
  lastSeenVersion: number,
  dbOverride?: SqliteDb,
): Promise<number> {
  if (targetVersion <= lastSeenVersion) return 0;
  const result = await assetsDb(dbOverride).write(STAGE_VERSION_BUMP_RESET_SQL, [
    stage,
    targetVersion,
  ]);
  return result.changes;
}

/** What one stage's row on Settings → Workers reports. */
export interface StageBacklog {
  /** Assets still below target, not dead-lettered, with a live original. */
  pending: number;
  /** How many of those could be claimed right now. */
  ready: number;
  /** Assets parked at the attempt ceiling, awaiting operator triage. */
  dead: number;
}

/** What {@link countStageBacklog} needs to know to count one stage. */
export interface StageBacklogQuery {
  stage: string;
  targetVersion: number;
  /** The stage's resolved `dependsOn`. Only `ready` applies these. */
  dependsOn?: readonly ResolvedStageDep[];
  residual?: StageClaimResidual;
  now?: Date;
}

/**
 * The backlog for one stage, for the worker's persisted-counts pass.
 *
 * Three numbers, and the split between the first two is the point. `pending`
 * ignores the retry gate and the dependency gates — it answers "how much work
 * is left" — while `ready` asks the claim's own question, "what could start
 * right now". The Workers page renders the difference as "N ready · M blocked
 * on an upstream stage", which is the one place an operator can see that a
 * stage with a five-figure backlog is not stuck but parked behind something
 * upstream. Counting only `pending` would show the backlog and hide the reason.
 *
 * Both apply the stage's `residual`, because a media-only stage that counted
 * the whole photo library would defeat that diagnosis just as thoroughly.
 */
export async function countStageBacklog(
  query: StageBacklogQuery,
  dbOverride?: SqliteDb,
): Promise<StageBacklog> {
  const db = assetsDb(dbOverride);
  const { stage, targetVersion, residual } = query;
  const dependsOn = query.dependsOn ?? [];
  const residualParams = residual?.params ?? [];
  const pendingRows = await db.read<{ n: number }>(stagePendingCountSql(residual?.sql), [
    stage,
    targetVersion,
    ...residualParams,
  ]);
  const readyRows = await db.read<{ n: number }>(
    stageReadyCountSql(dependsOn.length, residual?.sql),
    [
      stage,
      targetVersion,
      (query.now ?? new Date()).toISOString(),
      ...dependsOn.flatMap((dep) => [dep.name, dep.minVersion]),
      ...residualParams,
    ],
  );
  const deadRows = await db.read<{ n: number }>(STAGE_DEAD_COUNT_SQL, [stage]);
  return {
    pending: pendingRows[0]?.n ?? 0,
    ready: readyRows[0]?.n ?? 0,
    dead: deadRows[0]?.n ?? 0,
  };
}
