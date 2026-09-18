/**
 * How many live faces a person has.
 *
 * On MongoDB this was a denormalised `face_count` field on the person, adjusted
 * by hand at every membership change (assign, unassign, hide, merge) and then
 * rewritten wholesale once per clustering pass to heal the drift those
 * incremental sites caused. A face is a row now, so the number is a `COUNT(*)`
 * over an index that already excludes hidden faces — there is no counter to
 * maintain and nothing for a self-heal pass to repair.
 *
 * That is why two names from the Mongo surface have no successor here.
 * `adjustPersonFaceCount` and `writeAuthoritativeFaceCounts` existed only to
 * keep a stored number in step with the rows, and the `people` table has no
 * `face_count` column at all. Their former call sites — `assignFaceToPerson`,
 * `hideFace`, `mergeInto` and the clustering pass's self-heal — simply do not
 * have the corresponding line any more.
 *
 * `recomputePersonFaceCount` keeps its name and signature because
 * `routes/admin-purge-subthreshold-faces.ts` still calls it, but it is now a
 * read: it returns the count and writes nothing. See
 * `db/sqlite/repos/people.face-count.ts` for the full argument.
 */

export {
  faceCountByPerson,
  recomputePersonFaceCount,
} from '../db/sqlite/repos/people.face-count.ts';
