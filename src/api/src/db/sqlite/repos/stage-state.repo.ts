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
 * ## Counts stay persisted by the worker
 *
 * {@link countStageBacklog} is cheap: `stage_dead` answers the dead count from
 * the index alone, and pending is a range scan of `stage_claim`. It is still
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
import {
  REGISTER_STAGE_SQL,
  SEED_STAGE_ROW_SQL,
  STAGE_DEAD_COUNT_SQL,
  STAGE_VERSION_BUMP_RESET_SQL,
  stagePendingCountSql,
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
  /** Assets parked at the attempt ceiling, awaiting operator triage. */
  dead: number;
}

/**
 * The backlog for one stage, for the worker's persisted-counts pass.
 *
 * `pending` deliberately ignores the retry gate and the dependency gates,
 * which is the same thing the Mongo `pending` count does: it answers "how much
 * work is left", where the claim answers "what can start right now". It does
 * apply the stage's `residual`, because a media-only stage that counted the
 * whole photo library as pending forever would defeat the diagnosis the
 * counter exists to give.
 */
export async function countStageBacklog(
  stage: string,
  targetVersion: number,
  residual?: StageClaimResidual,
  dbOverride?: SqliteDb,
): Promise<StageBacklog> {
  const db = assetsDb(dbOverride);
  const pendingRows = await db.read<{ n: number }>(stagePendingCountSql(residual?.sql), [
    stage,
    targetVersion,
    ...(residual?.params ?? []),
  ]);
  const deadRows = await db.read<{ n: number }>(STAGE_DEAD_COUNT_SQL, [stage]);
  return { pending: pendingRows[0]?.n ?? 0, dead: deadRows[0]?.n ?? 0 };
}
