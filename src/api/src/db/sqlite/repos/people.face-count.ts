/**
 * How many live faces a person has — derived, never stored (#3749).
 *
 * ## What changed, and why it could not change before
 *
 * On MongoDB a face lives inside its asset's `faces[]` array, so counting one
 * person's faces means `$unwind`-ing the array of every asset that mentions
 * them and discarding the other entries. That is why the number is a
 * denormalised `face_count` field on the person: it is adjusted by hand at
 * every membership change — assign, unassign, hide, merge — and then rewritten
 * wholesale once per clustering pass by a block whose own comment explains that
 * it exists to heal the drift those incremental sites cause, "up AND down …
 * regardless of incremental bugs".
 *
 * A face is a row now. The count is one `COUNT(*)` over `faces_person`, a
 * partial index on `(person_id, asset_id)` that already excludes hidden faces,
 * joined to `assets` for liveness. So there is no counter to maintain, no
 * incremental adjustment to get wrong, and nothing for a self-heal pass to
 * repair. The `people` table has no `face_count` column at all, which is what
 * makes that a guarantee rather than a convention: the drift cannot be
 * reintroduced by a future write path forgetting to call something.
 *
 * ## The surface that went away
 *
 * `adjustPersonFaceCount` and `writeAuthoritativeFaceCounts` have no successor
 * here, deliberately. Both exist only to keep a stored number in step with the
 * rows, and there is no stored number. Their Mongo call sites — `assignFace`,
 * `hideFace`, `mergeInto`, and the clustering pass's self-heal — simply do not
 * have the corresponding line in the SQLite repos. The cutover (#3752) drops
 * those imports; it has nothing to point them at.
 *
 * `recomputePersonFaceCount` keeps its name and its signature because a route
 * still calls it, but it is now a read: it returns the count and writes
 * nothing.
 */

import { peopleDb, type SqliteDb } from './db-handle.ts';
import { FACE_COUNT_FOR_PERSON_SQL, FACE_COUNTS_BY_PERSON_SQL } from './people.sql.ts';
import { safeObjectId } from '../../safe-object-id.ts';

/**
 * Live assigned face counts for every person that has at least one, keyed by
 * lowercase hex id.
 *
 * People with no live faces are absent from the map rather than present with a
 * zero, which is the same thing the Mongo aggregation does — every caller reads
 * it through a `?? 0`.
 */
export async function faceCountByPerson(dbOverride?: SqliteDb): Promise<Map<string, number>> {
  const db = peopleDb(dbOverride);
  const rows = await db.read<{ person_id: string; n: number }>(FACE_COUNTS_BY_PERSON_SQL);
  return new Map(rows.map((row) => [row.person_id, row.n] as const));
}

/**
 * One person's live face count.
 *
 * Named for the Mongo function it replaces, which recomputed the stored counter
 * from ground truth and returned what it wrote. Here there is no counter, so
 * this only returns — `admin-purge-subthreshold-faces` calls it to report how
 * many faces a person has left after a purge, and that answer is unchanged.
 *
 * A malformed hex returns 0 rather than throwing, matching the Mongo version,
 * which logs and returns 0 so one bad id cannot fail a whole purge.
 */
export async function recomputePersonFaceCount(
  personHex: string,
  dbOverride?: SqliteDb,
): Promise<number> {
  if (!safeObjectId(personHex)) return 0;
  const db = peopleDb(dbOverride);
  const rows = await db.read<{ n: number }>(FACE_COUNT_FOR_PERSON_SQL, [personHex]);
  return rows[0]?.n ?? 0;
}
