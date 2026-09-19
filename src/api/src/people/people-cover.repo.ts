/**
 * Manual cover selection — pins a specific face as a person's cover thumbnail.
 *
 * The bbox is always read SERVER-SIDE from the face row; the client supplies
 * only `assetId` + `faceIndex`, never coordinates. A manually-set cover is
 * never clobbered by `backfillCoverAssets` (which only fills MISSING covers).
 *
 * The implementation lives in `db/repos/people.cover.ts`, including the
 * verbatim error strings the web client renders.
 */

export { setPersonCover } from '../db/repos/people.cover.ts';
