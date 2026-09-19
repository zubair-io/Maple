/**
 * Nearby-asset-folder lookup for the Imports feature (ticket #1752).
 *
 * Split out of `imports/repo.ts` to keep that file under the repo's file-size
 * budget (see `CONTRIBUTING.md`) — this is a single self-contained query, not
 * part of the `imports` claim/lease/progress accessor surface.
 *
 * The query itself moved to `db/sqlite/repos/assets.locations.repo.ts` at the
 * cutover (#3787); what stays here is the one thing that is not a database
 * concern — telling the operator when the candidate window was truncated, which
 * is a judgement about this feature rather than about the rows.
 */

import type { ObjectId } from '../db/object-id.ts';
import {
  loadNearbyAssetCandidateRows as loadCandidates,
  NEARBY_CANDIDATE_CAP,
} from '../db/sqlite/repos/assets.locations.repo.ts';
import type { NearbyAssetCandidate } from '../db/sqlite/repos/assets.locations.repo.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('import-nearby');

/**
 * Load already-indexed assets in `libraryId` whose capture time falls in
 * `[minMs, maxMs]` (capped at `NEARBY_CANDIDATE_CAP`), for the in-memory
 * nearest-match lookup by the caller — see `dest.ts`'s `nearestCandidateFolder`,
 * used from `scan.ts`'s `buildImportFiles`.
 *
 * A SINGLE range query for the whole import batch, not one per file: the caller
 * passes the min/max mtime across every file it is about to place, already
 * padded by the proximity window on both ends, so an import of thousands of
 * files costs one query rather than thousands.
 */
export async function loadNearbyAssetCandidates(
  libraryId: ObjectId,
  minMs: number,
  maxMs: number,
): Promise<NearbyAssetCandidate[]> {
  const { candidates, truncated } = await loadCandidates(libraryId, minMs, maxMs);
  if (truncated) {
    log.warn(
      { libraryId: libraryId.toHexString(), minMs, maxMs, cap: NEARBY_CANDIDATE_CAP },
      'nearby-asset candidate window exceeded cap; results truncated',
    );
  }
  return candidates;
}
