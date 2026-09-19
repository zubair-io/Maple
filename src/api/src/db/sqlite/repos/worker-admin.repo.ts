/**
 * The operator-facing half of Settings → Workers: the dead-letter and damaged
 * lists, the two buttons that clear them, and the collection-level badge counts
 * the worker's refresh pass persists (#3787).
 *
 * ## Why these live together rather than in `stage-state.repo.ts`
 *
 * Every verb here spans `stage_state` *and* `assets`, and the two clearing
 * operations write both in one transaction — clearing the damaged tag while
 * leaving the tagging stages dead-lettered would un-park a file the pipeline
 * then refuses to pick up. `stage-state.repo.ts` owns the claim-time
 * bookkeeping, which is the runner's; this owns what an operator does to it
 * from the outside.
 *
 * ## The counts are still worker-side work
 *
 * {@link countDamagedAssets} and friends answer from an index, but they are
 * called from the worker's persisted-counts pass and never from a request
 * handler. That contract is what made `/api/workers/status` stop being an
 * eight-second endpoint (#3491), and it is about where a count runs rather
 * than how much it costs.
 *
 * ## Absolute paths are resolved here
 *
 * Both list queries report `abs_path`, which needs the library roots. Resolving
 * it in the repository keeps the route free of a second data source — on Mongo
 * it reached into `indexer/libraries.cache.ts` for the same map — and means the
 * roots read shares the batch's round trip rather than adding one.
 */

import { loadLibraries } from './assets.read.ts';
import { groupByAsset, resolvePrimary, toFileInfo, type LocationRow } from './assets.rows.ts';
import { bucketedIds, locationsByAssetIdsSql } from './assets.sql.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';

/** One row of a stage's dead-letter list. */
export interface DeadAssetRow {
  id: string;
  abs_path: string;
  last_error: string | null;
  attempts: number;
  processed_at: string | null;
}

/** One row of the collection-wide damaged list. */
export interface DamagedAssetRow {
  id: string;
  maple_id: string | null;
  abs_path: string;
  stage: string | null;
  reason: string | null;
  since: string | null;
}

/** Assets tagged damaged — the "Damaged" pill, and the list below it. */
export async function countDamagedAssets(dbOverride?: SqliteDb): Promise<number> {
  return await countOne(
    `SELECT COUNT(*) AS n FROM assets WHERE damaged_since IS NOT NULL`,
    [],
    dbOverride,
  );
}

/** Assets auto-hidden for nudity that the operator has not acknowledged. */
export async function countNewlyHiddenAssets(dbOverride?: SqliteDb): Promise<number> {
  return await countOne(
    `SELECT COUNT(*) AS n FROM assets
      WHERE hidden = 1 AND hidden_ack = 0 AND hidden_reason IN ('nudity', 'nudity-burst')`,
    [],
    dbOverride,
  );
}

/**
 * Assets with at least one location tagged `missing_since` — the
 * missing-reaper's queue.
 *
 * A semi-join rather than a join, so an asset whose several locations all went
 * missing counts once. The Mongo filter (`'fileinfo.missing_since': { $type:
 * 'string' }`) had that property for free by matching the array element.
 */
export async function countMissingTaggedAssets(dbOverride?: SqliteDb): Promise<number> {
  return await countOne(
    `SELECT COUNT(*) AS n FROM assets
      WHERE EXISTS (
        SELECT 1 FROM asset_locations
         WHERE asset_id = assets.id AND missing_since IS NOT NULL
      )`,
    [],
    dbOverride,
  );
}

/** Assets with two or more live locations — the deduplicate worker's queue. */
export async function countDuplicateAssets(dbOverride?: SqliteDb): Promise<number> {
  return await countOne(
    `SELECT COUNT(*) AS n FROM assets WHERE live_location_count >= 2`,
    [],
    dbOverride,
  );
}

async function countOne(
  sql: string,
  params: readonly (string | number)[],
  dbOverride?: SqliteDb,
): Promise<number> {
  const rows = await assetsDb(dbOverride).read<{ n: number }>(sql, [...params]);
  return rows[0]?.n ?? 0;
}

/**
 * One stage's dead-lettered assets, most recently processed first.
 *
 * `processed_at DESC` puts rows that never completed — a `NULL` — at the end,
 * where SQLite sorts them. That is the useful order: an asset that failed after
 * having once succeeded is the interesting one.
 */
export async function listDeadAssets(
  stage: string,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<DeadAssetRow[]> {
  const db = assetsDb(dbOverride);
  const rows = await db.read<{
    asset_id: string;
    last_error: string | null;
    attempts: number;
    processed_at: string | null;
  }>(
    `SELECT asset_id, last_error, attempts, processed_at
       FROM stage_state
      WHERE stage = ? AND dead = 1
      ORDER BY processed_at DESC
      LIMIT ?`,
    [stage, limit],
  );
  const paths = await resolvePaths(
    db,
    rows.map((row) => row.asset_id),
  );
  return rows.map((row) => ({
    id: row.asset_id,
    abs_path: paths.get(row.asset_id) ?? '',
    last_error: row.last_error,
    attempts: row.attempts,
    processed_at: row.processed_at,
  }));
}

/** Every asset tagged damaged, newest detection first. */
export async function listDamagedAssets(
  limit: number,
  dbOverride?: SqliteDb,
): Promise<DamagedAssetRow[]> {
  const db = assetsDb(dbOverride);
  const rows = await db.read<{
    id: string;
    maple_id: string | null;
    damaged_since: string | null;
    damaged_stage: string | null;
    damaged_reason: string | null;
  }>(
    `SELECT id, maple_id, damaged_since, damaged_stage, damaged_reason
       FROM assets
      WHERE damaged_since IS NOT NULL
      ORDER BY damaged_since DESC
      LIMIT ?`,
    [limit],
  );
  const paths = await resolvePaths(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    maple_id: row.maple_id,
    abs_path: paths.get(row.id) ?? '',
    stage: row.damaged_stage,
    reason: row.damaged_reason,
    since: row.damaged_since,
  }));
}

/** Asset id → absolute path of its primary live location. */
async function resolvePaths(
  db: SqliteDb,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const bound = bucketedIds(ids);
  const [locations, libraries] = await Promise.all([
    db.read<LocationRow>(locationsByAssetIdsSql(bound.length), bound),
    loadLibraries(db),
  ]);
  const byAsset = groupByAsset(locations);
  return new Map(
    ids.map((id) => [id, resolvePrimary(toFileInfo(byAsset.get(id) ?? []), libraries).abs_path]),
  );
}

/**
 * Lift a stage's dead-letter flags so its poll loop picks the assets up again.
 *
 * Returns how many rows were re-queued. `next_attempt_at` is cleared too, which
 * the Mongo version could not express — there, "Retry dead" reset `dead` and
 * `attempts` but left the backoff gate standing, so an operator pressing the
 * button watched nothing happen for up to fifteen minutes (#2729).
 */
export async function retryDeadStage(stage: string, dbOverride?: SqliteDb): Promise<number> {
  const result = await assetsDb(dbOverride).write(
    `UPDATE stage_state
        SET dead = 0, attempts = 0, last_error = NULL, next_attempt_at = NULL
      WHERE stage = ? AND dead = 1`,
    [stage],
  );
  return result.changes;
}

/**
 * Clear the damaged tag from one asset or from every tagged asset, and re-arm
 * the stages that do the tagging.
 *
 * The stage resets run BEFORE the tag is dropped and select through the tag
 * themselves, so "which assets" is decided once by a predicate both halves
 * share. Doing it the other way round would clear the tag first and leave the
 * reset matching nothing, which is the bug the ordering exists to avoid.
 *
 * One transaction, so an asset can never end up un-tagged with its stages still
 * dead-lettered — un-parked for reads and permanently ignored by the pipeline.
 *
 * ## Why the tag is dropped by two statements
 *
 * The count this returns is the operator's "cleared N", so it has to be assets
 * and not rows. Clearing `damaged_since` un-parks the asset, which re-stamps
 * `stage_state.asset_claimable` on every stage row it has (#3804), and
 * `bun:sqlite` counts trigger writes in a statement's row count — so the single
 * `UPDATE` this used to be would report one asset as a dozen.
 *
 * Splitting the write gives an exact answer without a second round trip. The
 * first statement clears the two companion columns, which no trigger watches,
 * so its row count IS the number of assets; the second clears the tag itself
 * and its count is ignored. The order matters as much as the split: the second
 * statement still selects on `damaged_since IS NOT NULL`, which the first
 * deliberately leaves alone.
 */
export async function clearDamagedAssets(
  assetId: string | null,
  stages: readonly string[],
  dbOverride?: SqliteDb,
): Promise<number> {
  const scope = assetId === null ? '' : ' AND id = ?';
  const scopeParams = assetId === null ? [] : [assetId];
  const resets = stages.map((stage) => ({
    sql: `UPDATE stage_state
             SET dead = 0, attempts = 0, last_error = NULL, next_attempt_at = NULL
           WHERE stage = ?
             AND asset_id IN (SELECT id FROM assets WHERE damaged_since IS NOT NULL${scope})`,
    params: [stage, ...scopeParams],
  }));
  const results = await assetsDb(dbOverride).transaction([
    ...resets,
    {
      sql: `UPDATE assets SET damaged_stage = NULL, damaged_reason = NULL
             WHERE damaged_since IS NOT NULL${scope}`,
      params: scopeParams,
    },
    {
      sql: `UPDATE assets SET damaged_since = NULL
             WHERE damaged_since IS NOT NULL${scope}`,
      params: scopeParams,
    },
  ]);
  return results[resets.length]?.changes ?? 0;
}
