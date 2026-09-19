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
 *
 * ## What deriving it costs, and where that cost is bounded
 *
 * Deriving is not free — it is one pass over the assigned faces, with a
 * liveness probe per face. On a generated 335,377-asset library (335,028
 * faces, ~251k of them assigned) the whole-library count measures 175 ms, and
 * that is with `assets_live_id` answering the liveness probe from the index
 * rather than from the asset row; without that index the same query takes
 * 591 ms. The grid endpoint asks for every live person, so it pays that pass.
 *
 * The two recovery listings do not, and this is where the review of #3767 was
 * right: Hidden and Excluded hold a handful of operator-marked people out of
 * tens of thousands, and counting them by walking the entire face table is
 * work with no reader. Passing the ids turns it into one seek per person.
 */

import { peopleDb, type SqliteDb } from './db-handle.ts';
import {
  faceCountsForPeopleSql,
  FACE_COUNT_FOR_PERSON_SQL,
  FACE_COUNTS_BY_PERSON_SQL,
} from './people.sql.ts';
import { safeObjectId } from '../../safe-object-id.ts';

/**
 * Above this many people, the keyed form stops being the cheaper plan.
 *
 * It would have to be chunked past SQLite's bound-parameter ceiling, and the
 * chunks together read the same rows the grouped scan reads in one pass —
 * paying a seek per person on top. Whole-library listings are far past this,
 * so they take the scan; the recovery listings are far below it.
 */
const KEYED_COUNT_MAX = 500;

/**
 * Live assigned face counts, keyed by lowercase hex person id.
 *
 * `personHexes` names the people the caller actually needs. Pass them: a short
 * list is answered by seeking each person in `faces_person` instead of walking
 * every assigned face in the library. Omitting them (or passing more than
 * `KEYED_COUNT_MAX`) falls back to the grouped scan, which is what the
 * whole-library grid wants anyway.
 *
 * People with no live faces are absent from the map rather than present with a
 * zero, which is the same thing the Mongo aggregation does — every caller reads
 * it through a `?? 0`.
 */
export async function faceCountByPerson(
  personHexes?: readonly string[],
  dbOverride?: SqliteDb,
): Promise<Map<string, number>> {
  const db = peopleDb(dbOverride);
  const keyed = personHexes !== undefined && personHexes.length <= KEYED_COUNT_MAX;
  if (keyed && personHexes.length === 0) return new Map();
  const rows = keyed
    ? await db.read<{ person_id: string; n: number }>(faceCountsForPeopleSql(personHexes.length), [
        ...personHexes,
      ])
    : await db.read<{ person_id: string; n: number }>(FACE_COUNTS_BY_PERSON_SQL);
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
