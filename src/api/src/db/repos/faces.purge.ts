/**
 * The sub-threshold face purge: the audit it reports and the delete it applies
 * (#3787).
 *
 * Its own module rather than an addition to `people.repo.ts` or `people.sql.ts`
 * because it belongs to one operator route and shares nothing with the
 * clustering, merge and listing machinery those files carry — and both are
 * already near the file-size budget (CONTRIBUTING.md § "File-size budget").
 *
 * ## What changed when faces stopped being an array
 *
 * On MongoDB a face was an element of `assets.faces[]`, so removing one meant
 * `$pull` with an element predicate, and the route needed a JavaScript mirror of
 * that predicate to tally the audit it printed — two spellings of "this face is
 * removable" that had to be kept in lockstep by hand. A face is a row here, so
 * the predicate is written once, in SQL, and the audit and the delete are the
 * same `WHERE` under two different verbs.
 *
 * The removal is also safer than the one it replaces. `$pull` compacted the
 * array, shifting every later element's index — which is why the route's own
 * documentation tells the operator to pause the face workers first, since an
 * in-flight `$set faces.<i>.embedding` would land on the wrong face afterwards.
 * `face_index` is a stored column here, so a delete leaves the surviving rows'
 * indices exactly where they were and a concurrent embed write still addresses
 * the face it read.
 *
 * ## "Below threshold" is an OR, not a min
 *
 * `min(bbox_w, bbox_h) < t` and `bbox_w < t OR bbox_h < t` select the same
 * rows. The OR form is kept because it is the shape the Mongo predicate had and
 * because it is the shape an index could serve, should this ever need one.
 */

import { peopleDb, type SqliteDb } from './db-handle.ts';

/**
 * Faces small enough to be candidates, whatever their assignment or visibility.
 *
 * The audit counts every one of these and sorts them into three buckets; only
 * some of them are removable. Both bounds are bound parameters, and both
 * placeholders take the same value.
 */
const BELOW_THRESHOLD = '(faces.bbox_w < ? OR faces.bbox_h < ?)';

/**
 * The faces a purge actually deletes.
 *
 * Hidden faces are always preserved — hiding one was a deliberate act, and the
 * route says so on the wire with `preservesHidden: true`. Assigned faces are
 * preserved unless the caller opted in, because an assignment is curation too.
 */
function removableSql(includeAssigned: boolean): string {
  const assignment = includeAssigned ? '' : ' AND faces.person_id IS NULL';
  return `${BELOW_THRESHOLD} AND faces.hidden = 0${assignment}`;
}

/** How many sub-threshold faces of each kind exist, and who holds them. */
export interface SubthresholdAudit {
  /** Assets carrying at least one face at all. */
  assetsScanned: number;
  /** Assets carrying at least one sub-threshold face. */
  assetsAffected: number;
  /** Sub-threshold, visible, unassigned — what a default purge removes. */
  unassigned: number;
  /** Sub-threshold, visible, assigned — removed only when opted in. */
  assigned: number;
  /** Sub-threshold and hidden — never removed. */
  hidden: number;
  /** Person id → how many sub-threshold assigned faces they hold. */
  personLoss: Map<string, number>;
}

/** One row of the three-way tally, as SQLite groups it. */
interface CategoryRow {
  hidden: number;
  assigned: number;
  count: number;
}

/**
 * The read-only half: what a purge at this threshold would be acting on.
 *
 * Four statements rather than one pass with conditional aggregates, because
 * they answer four differently-shaped questions — two distinct-asset counts, a
 * three-way split, and a per-person breakdown — and the pool runs them
 * concurrently on separate readers.
 *
 * The population is every face in the database, live asset or not. That matches
 * the Mongo scan this replaces, and it is the right population: a soft-deleted
 * asset can be restored, and restoring it should not bring back the faces the
 * operator just purged.
 */
export async function auditSubthresholdFaces(
  minSize: number,
  dbOverride?: SqliteDb,
): Promise<SubthresholdAudit> {
  const db = peopleDb(dbOverride);
  const bounds = [minSize, minSize];
  const [scanned, affected, categories, losses] = await Promise.all([
    db.read<{ n: number }>(`SELECT COUNT(DISTINCT faces.asset_id) AS n FROM faces`),
    db.read<{ n: number }>(
      `SELECT COUNT(DISTINCT faces.asset_id) AS n FROM faces WHERE ${BELOW_THRESHOLD}`,
      bounds,
    ),
    db.read<CategoryRow>(
      `SELECT faces.hidden AS hidden,
              CASE WHEN faces.person_id IS NULL THEN 0 ELSE 1 END AS assigned,
              COUNT(*) AS count
         FROM faces
        WHERE ${BELOW_THRESHOLD}
        GROUP BY hidden, assigned`,
      bounds,
    ),
    db.read<{ id: string; count: number }>(
      `SELECT faces.person_id AS id, COUNT(*) AS count
         FROM faces
        WHERE ${BELOW_THRESHOLD} AND faces.hidden = 0 AND faces.person_id IS NOT NULL
        GROUP BY faces.person_id`,
      bounds,
    ),
  ]);

  // Hidden wins over assigned, matching the order the audit's three buckets
  // were tallied in: a hidden face that also carries a person id is reported
  // as hidden, because that is the reason it survives a purge.
  const tally = (predicate: (row: CategoryRow) => boolean): number =>
    categories.filter(predicate).reduce((sum, row) => sum + row.count, 0);

  return {
    assetsScanned: scanned[0]?.n ?? 0,
    assetsAffected: affected[0]?.n ?? 0,
    hidden: tally((row) => row.hidden === 1),
    assigned: tally((row) => row.hidden === 0 && row.assigned === 1),
    unassigned: tally((row) => row.hidden === 0 && row.assigned === 0),
    personLoss: new Map(losses.map((row) => [row.id, row.count] as const)),
  };
}

/** What a purge removed. */
export interface PurgeOutcome {
  facesRemoved: number;
  /** Assets that lost at least one face — the `modifiedCount` equivalent. */
  assetsUpdated: number;
}

/**
 * Remove every removable sub-threshold face, and report what went.
 *
 * The affected-asset count is read before the delete rather than derived from
 * it, because once the rows are gone there is nothing left to count them by.
 * Both statements carry the identical predicate, so the number describes
 * exactly the delete that follows it.
 *
 * Idempotent: a second run at the same threshold matches nothing and reports
 * zeroes.
 */
export async function purgeSubthresholdFaces(
  minSize: number,
  includeAssigned: boolean,
  dbOverride?: SqliteDb,
): Promise<PurgeOutcome> {
  const db = peopleDb(dbOverride);
  const predicate = removableSql(includeAssigned);
  const bounds = [minSize, minSize];
  const affected = await db.read<{ n: number }>(
    `SELECT COUNT(DISTINCT faces.asset_id) AS n FROM faces WHERE ${predicate}`,
    bounds,
  );
  // `faces` is the only table named, so the bare column names the DELETE needs
  // are unambiguous — the qualified spelling above is what `faces.` buys, and
  // SQLite resolves it to the same table either way.
  const result = await db.write(`DELETE FROM faces WHERE ${predicate}`, bounds);
  return { facesRemoved: result.changes, assetsUpdated: affected[0]?.n ?? 0 };
}
