/**
 * The writes the library-wide sweeper workers perform, once they have
 * classified a candidate (#3787).
 *
 * Split from `./assets.sweeps.ts`, which holds the candidate queries, because
 * the two halves are read by different people for different reasons: the reads
 * are a performance argument to be checked against the index map, and these are
 * a set of atomicity claims. Both are re-exported from that module, so a caller
 * imports from one place.
 *
 * ## One transaction per asset, never one per sweep
 *
 * After boot the API process and the worker child both hold SQLite writer
 * connections, arbitrated by the file lock with a five-second busy timeout.
 * That is only safe while no transaction is long, so a sweep is a loop over
 * these calls rather than a transaction around the pass. Scoping to one asset
 * loses nothing: `live_location_count` is maintained by triggers on
 * `asset_locations`, so a location change and the roll-up that counts it still
 * commit together.
 *
 * ## What the rows fixed
 *
 * Two of these replace Mongo array updates whose failure modes were invisible
 * at the call site. A `$set` clearing a tag and a `$pull` removing an entry both
 * touch the `fileinfo` path and so could not share one update — the reaper
 * issued two writes and a crash between them left a row half-reconciled. And a
 * `$pull` matching on `{library_id, path, filename}` cannot be `$or`-ed:
 * MongoDB ignores the operator silently and modifies nothing, so the file moved
 * and the entry stayed. Neither is expressible against rows.
 */

import type { SqlStatement } from '../protocol.ts';
import { sqliteDb, updateOutcome, type SqliteDb, type UpdateOutcome } from './db-handle.ts';
import type { AuditMark, LocationAddress } from './assets.sweeps.ts';

const ENTRY_PREDICATE = `asset_id = ? AND library_id = ? AND path = ? AND filename = ?`;

const CLEAR_MISSING_SQL = `
  UPDATE asset_locations
     SET missing_since = NULL, missing_reason = NULL
   WHERE ${ENTRY_PREDICATE}`;

const DELETE_ENTRY_SQL = `DELETE FROM asset_locations WHERE ${ENTRY_PREDICATE}`;

/**
 * First detection wins: an entry already carrying a tag keeps its original
 * timestamp, so a second pass cannot restart the reaper's cooldown clock and
 * strand the entry forever. On Mongo this was an `arrayFilters` condition; here
 * it is part of the `WHERE`.
 */
const TAG_MISSING_SQL = `
  UPDATE asset_locations
     SET missing_since = ?, missing_reason = ?
   WHERE ${ENTRY_PREDICATE} AND missing_since IS NULL`;

function entryParams(assetId: string, entry: LocationAddress): (string | number)[] {
  return [assetId, entry.libraryId, entry.path, entry.filename];
}

/** Statements clearing the missing tag on each named entry. */
export function clearLocationsMissingStatements(
  assetId: string,
  entries: readonly LocationAddress[],
): SqlStatement[] {
  return entries.map((entry) => ({ sql: CLEAR_MISSING_SQL, params: entryParams(assetId, entry) }));
}

/** Statements removing each named entry from the asset. */
export function deleteLocationsStatements(
  assetId: string,
  entries: readonly LocationAddress[],
): SqlStatement[] {
  return entries.map((entry) => ({ sql: DELETE_ENTRY_SQL, params: entryParams(assetId, entry) }));
}

/**
 * Recover the entries whose file came back, drop the ones confirmed gone, and
 * commit whatever the caller wants to land with them — a stage re-arm,
 * typically. One transaction per asset; see the module note on why not per pass.
 *
 * A `$set` clearing a tag and a `$pull` removing an entry could not share one
 * Mongo update (both touch the `fileinfo` path), so the reaper issued two writes
 * and a crash between them left the row half-reconciled. As rows they are
 * ordinary statements and go in together.
 */
export async function reconcileLocations(args: {
  assetId: string;
  recover?: readonly LocationAddress[];
  prune?: readonly LocationAddress[];
  extra?: readonly SqlStatement[];
  dbOverride?: SqliteDb;
}): Promise<void> {
  const statements = [
    ...clearLocationsMissingStatements(args.assetId, args.recover ?? []),
    ...deleteLocationsStatements(args.assetId, args.prune ?? []),
    ...(args.extra ?? []),
  ];
  if (statements.length === 0) return;
  await sqliteDb(args.dbOverride).transaction(statements);
}

/**
 * Tag every named entry missing. The reported count is how many rows actually
 * changed, which is how a caller tells "tagged now" from "already tagged".
 */
export async function tagLocationsMissing(
  assetId: string,
  entries: readonly LocationAddress[],
  reason: string,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  if (entries.length === 0) return updateOutcome(0);
  const iso = new Date().toISOString();
  const results = await sqliteDb(dbOverride).transaction(
    entries.map((entry) => ({
      sql: TAG_MISSING_SQL,
      params: [iso, reason, ...entryParams(assetId, entry)],
    })),
  );
  return updateOutcome(results.reduce((total, result) => total + result.changes, 0));
}

/**
 * Soft-delete an asset whose every location is confirmed gone (#2977).
 *
 * Guarded, and the guard is the point: a discover revive or a user trash landing
 * between the reaper's classification and this write turns the reap into a
 * no-op rather than stamping over it. `live_location_count > 0` is the row's own
 * roll-up of "has a live entry", so the compare-and-swap is one predicate rather
 * than the Mongo version's nested `$not`/`$elemMatch`.
 *
 * Returns whether the row was actually reaped.
 */
export async function reapAsset(assetId: string, dbOverride?: SqliteDb): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE assets
        SET deleted_at = ?, deleted_reason = 'reaped'
      WHERE id = ? AND deleted_at IS NULL AND live_location_count = 0`,
    [new Date().toISOString(), assetId],
  );
  return result.changes > 0;
}

/**
 * Set one stage's mark, creating the detail row when the asset has none.
 *
 * `SELECT … FROM assets WHERE id = ?` as the insert's source keeps a mark from
 * being written for an asset that does not exist, which the foreign key would
 * reject and which would roll the surrounding transaction back.
 */
const AUDIT_MARK_SET_SQL = `
  INSERT INTO asset_detail (asset_id, derivative_audit)
  SELECT id, json_set('{}', '$.' || ?, json(?)) FROM assets WHERE id = ?
  ON CONFLICT (asset_id) DO UPDATE SET
    derivative_audit = json_set(COALESCE(derivative_audit, '{}'), '$.' || ?, json(?))`;

const AUDIT_MARK_CLEAR_SQL = `
  UPDATE asset_detail
     SET derivative_audit = json_remove(derivative_audit, '$.' || ?)
   WHERE asset_id = ? AND derivative_audit IS NOT NULL`;

/**
 * Write one asset's audit cooldown marks and clear the ones whose derivative
 * was positively verified present.
 *
 * Both halves are `json_set`/`json_remove` on one key rather than a rewrite of
 * the whole object, so two stages' marks written in the same pass cannot lose
 * each other. `extra` carries the stage re-arms the audit issues alongside, so
 * a re-arm and the mark that rate-limits it commit together — otherwise a crash
 * between them re-arms a stage with no record that it had been.
 */
export async function writeAuditMarks(args: {
  assetId: string;
  set?: ReadonlyMap<string, AuditMark>;
  clear?: readonly string[];
  extra?: readonly SqlStatement[];
  dbOverride?: SqliteDb;
}): Promise<void> {
  const setStatements = [...(args.set ?? new Map<string, AuditMark>())].map(([stage, mark]) => ({
    sql: AUDIT_MARK_SET_SQL,
    params: [stage, JSON.stringify(mark), args.assetId, stage, JSON.stringify(mark)],
  }));
  const clearStatements = (args.clear ?? []).map((stage) => ({
    sql: AUDIT_MARK_CLEAR_SQL,
    params: [stage, args.assetId],
  }));
  const statements = [...(args.extra ?? []), ...setStatements, ...clearStatements];
  if (statements.length === 0) return;
  await sqliteDb(args.dbOverride).transaction(statements);
}
