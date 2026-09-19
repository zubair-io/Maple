/**
 * Resolving references the source could not have enforced.
 *
 * MongoDB has no foreign keys, so a production library accumulates references
 * to rows that are no longer there: a face assigned to a person who was merged
 * away and deleted, a location under a library root the operator unregistered,
 * a change-log row naming an asset that has since been purged. None of that is
 * corruption on the Mongo side — the read paths already walk past a reference
 * that does not resolve — but SQLite will not accept it, and the bulk load runs
 * with `PRAGMA foreign_keys = OFF` anyway because the source has a genuine
 * cycle: a face points at a person, and a person's cover points at an asset.
 *
 * So enforcement is deferred to one pass at the end, and the pass applies the
 * schema's own stated intent rather than inventing a policy:
 *
 *  - a NULLABLE foreign key declares `ON DELETE SET NULL`, which means "when
 *    the target goes, this becomes null" — so a dangling one becomes null;
 *  - a NOT NULL foreign key has no such escape, so the row goes. This is the
 *    same verdict the Mongo read paths already reach: a `fileinfo` entry whose
 *    library no longer resolves is skipped by every caller that walks the
 *    array.
 *
 * Both are counted and reported. Silently dropping rows during a migration is
 * exactly the kind of thing an operator should hear about, so the run's summary
 * names the table and the number for each.
 *
 * `PRAGMA foreign_key_check` then confirms nothing is left, which is what makes
 * turning the pragma back on for the running server safe.
 */

import type { Database } from 'bun:sqlite';
import { readMeta, writeMeta } from './bookkeeping.ts';

/** One foreign-key column and the table it points at. */
export interface ForeignKey {
  table: string;
  column: string;
  parent: string;
  parentKey: string;
}

/** Nullable references — a dangling one is nulled, as `ON DELETE SET NULL` says. */
export const NULLABLE_FOREIGN_KEYS: readonly ForeignKey[] = [
  { table: 'faces', column: 'person_id', parent: 'people', parentKey: 'id' },
  { table: 'people', column: 'cover_asset_id', parent: 'assets', parentKey: 'id' },
  { table: 'people', column: 'merged_into', parent: 'people', parentKey: 'id' },
  { table: 'people', column: 'suggested_merge_person_id', parent: 'people', parentKey: 'id' },
  { table: 'asset_changes', column: 'asset_id', parent: 'assets', parentKey: 'id' },
  { table: 'asset_changes', column: 'folder_id', parent: 'folders', parentKey: 'id' },
  { table: 'refresh_tokens', column: 'replaced_by', parent: 'refresh_tokens', parentKey: 'id' },
  { table: 'challenges', column: 'user_id', parent: 'users', parentKey: 'id' },
];

/** NOT NULL references — a dangling one takes its row with it. */
export const REQUIRED_FOREIGN_KEYS: readonly ForeignKey[] = [
  { table: 'asset_locations', column: 'library_id', parent: 'folders', parentKey: 'id' },
  { table: 'imports', column: 'library_id', parent: 'folders', parentKey: 'id' },
  { table: 'import_files', column: 'import_id', parent: 'imports', parentKey: 'id' },
  { table: 'discover_frontier', column: 'folder_id', parent: 'folders', parentKey: 'id' },
  { table: 'backup_sessions', column: 'library_id', parent: 'folders', parentKey: 'id' },
  { table: 'upload_sessions', column: 'library_id', parent: 'folders', parentKey: 'id' },
  { table: 'apns_device_tokens', column: 'user_id', parent: 'users', parentKey: 'id' },
  { table: 'credentials', column: 'user_id', parent: 'users', parentKey: 'id' },
  { table: 'invites', column: 'invited_by', parent: 'users', parentKey: 'id' },
  { table: 'refresh_tokens', column: 'user_id', parent: 'users', parentKey: 'id' },
  { table: 'service_api_keys', column: 'created_by', parent: 'users', parentKey: 'id' },
  { table: 'native_auth_codes', column: 'user_id', parent: 'users', parentKey: 'id' },
  { table: 'lan_handoff_codes', column: 'user_id', parent: 'users', parentKey: 'id' },
  // The Meilisearch redrive list is a work list rather than a record, and its
  // column says so with `ON DELETE CASCADE`: a parked row whose asset has been
  // purged is not history, it is a unit of work that can never succeed.
  {
    table: 'meilisearch_backfill_failures',
    column: 'asset_id',
    parent: 'assets',
    parentKey: 'id',
  },
];

/** `import_meta` key under which a run records what the repair pass changed. */
export const REPAIR_META_KEY = 'repair';

/** What the repair pass changed. */
export interface RepairResult {
  nulled: Record<string, number>;
  dropped: Record<string, number>;
}

/**
 * "This row's reference does not resolve."
 *
 * The parent is aliased, and that alias is load-bearing rather than tidiness:
 * three of these foreign keys are self-referential — `people.merged_into`,
 * `people.suggested_merge_person_id`, `refresh_tokens.replaced_by` — so without
 * the alias both sides of the comparison bind to the INNER copy of the table.
 * The subquery then asks "is there a row whose id equals its own merged_into",
 * the answer is always no, and the pass silently nulls every merge reference in
 * the library. That is precisely the failure mode this whole pass exists to
 * avoid, so it is worth a sentence.
 */
function danglingPredicate(fk: ForeignKey): string {
  return `${fk.column} IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM ${fk.parent} AS fk_parent
             WHERE fk_parent.${fk.parentKey} = ${fk.table}.${fk.column}
          )`;
}

/** What every repair pass this database has run did, in total. */
function readRepairTotals(db: Database): RepairResult {
  const stored = readMeta(db, REPAIR_META_KEY);
  if (stored === null) return { nulled: {}, dropped: {} };
  const parsed = JSON.parse(stored) as Partial<RepairResult>;
  return { nulled: parsed.nulled ?? {}, dropped: parsed.dropped ?? {} };
}

/**
 * Nulls or drops every reference that does not resolve, and adds what it did
 * to the running total.
 *
 * ## Why the tally accumulates instead of being rewritten
 *
 * Verification asks the source how many rows a table should hold and subtracts
 * the rows this pass dropped, because a location under a library root the
 * operator unregistered is a row the source counts and the destination
 * correctly does not. That subtraction has to survive a second run of the same
 * command — which the documentation actively tells an operator to do after an
 * interruption. The first run drops K rows and records K; the second finds
 * nothing dangling, because the first already dealt with it. Overwriting the
 * record with that second, empty answer made verification expect K rows that
 * were never supposed to be there, so re-running a finished, correct import
 * reported FAILED. Adding to the total instead leaves it at K.
 *
 * ## Why each foreign key commits its own tally
 *
 * The count, the statement and the record of it go in one transaction, for the
 * same reason a batch commits with its checkpoint: a pass interrupted halfway
 * through the list would otherwise leave rows deleted and nothing saying so,
 * and the re-run cannot recount them — they are already gone.
 */
export function repairForeignKeys(db: Database): RepairResult {
  const nulled = NULLABLE_FOREIGN_KEYS.reduce(
    (totals, fk) =>
      applyRepair(db, fk, totals, 'nulled', (predicate) =>
        db.run(`UPDATE ${fk.table} SET ${fk.column} = NULL WHERE ${predicate}`),
      ),
    readRepairTotals(db),
  );
  return REQUIRED_FOREIGN_KEYS.reduce(
    (totals, fk) =>
      applyRepair(db, fk, totals, 'dropped', (predicate) =>
        db.run(`DELETE FROM ${fk.table} WHERE ${predicate}`),
      ),
    nulled,
  );
}

/** One foreign key's verdict, its statement and its tally, in one transaction. */
function applyRepair(
  db: Database,
  fk: ForeignKey,
  totals: RepairResult,
  bucket: 'nulled' | 'dropped',
  run: (predicate: string) => void,
): RepairResult {
  const affected = countMatching(db, fk);
  if (affected === 0) return totals;
  const key = `${fk.table}.${fk.column}`;
  const merged = { ...totals[bucket], [key]: (totals[bucket][key] ?? 0) + affected };
  const updated: RepairResult =
    bucket === 'nulled' ? { ...totals, nulled: merged } : { ...totals, dropped: merged };

  db.exec('BEGIN IMMEDIATE');
  try {
    run(danglingPredicate(fk));
    writeMeta(db, REPAIR_META_KEY, JSON.stringify(updated));
    db.exec('COMMIT');
    return updated;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * How many rows the repair is about to touch.
 *
 * Counted with a `SELECT` before the statement rather than read back from
 * `total_changes()` afterwards, because a `DELETE` can fire a trigger whose own
 * `UPDATE` is counted too — `asset_locations` maintains
 * `assets.live_location_count` that way, and one deleted location reported as
 * two changed rows would make the verifier's expected count wrong by exactly
 * the number of deletions.
 */
function countMatching(db: Database, fk: ForeignKey): number {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM ${fk.table} WHERE ${danglingPredicate(fk)}`)
    .get() as { n: number };
  return row.n;
}

/** Surviving `PRAGMA foreign_key_check` rows, as `table → count`. */
export function foreignKeyViolations(db: Database): Record<string, number> {
  const rows = db.query(`PRAGMA foreign_key_check`).all() as Array<{ table: string }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.table] = (out[row.table] ?? 0) + 1;
  return out;
}
