/**
 * Internal helpers shared across the `/api/assets` sub-routers.
 *
 * Kept private to the `routes/assets/` folder — nothing outside the
 * folder should import from here. The public surface is the composed
 * `assetsRoutes` plugin re-exported from `./index.ts` (and the
 * `routes/assets.ts` shim that re-exports it).
 */

import { child as childLogger } from '../../log.ts';
import type { ObjectId } from 'mongodb';
import { parseAssetId } from '../../db/assets.repo.ts';
import type { RelocateAssetResult } from '../../library/relocate-asset.ts';

/** Shared logger for every `/api/assets` sub-router. */
export const assetsLog = childLogger('routes:assets');

/** Parse a route's `:id` param, writing a 400 into `set` and returning the
 * error body to return immediately on failure — or the parsed id on
 * success. Shared by `relocate.ts` and `rename.ts` (both take a single
 * `:id` and do nothing else before this check): collapsing the parse AND
 * the early-return into one call (rather than each route re-doing its own
 * `if (!result.ok) { set.status = ...; return ...; }`) is what keeps this
 * from being flagged as a clone by fallow-audit. Callers narrow with
 * `instanceof ObjectId`. */
export function resolveAssetIdOrRespond(
  idParam: string,
  set: { status?: number | string },
): ObjectId | { error: string } {
  const id = parseAssetId(idParam);
  if (id) return id;
  set.status = 400;
  return { error: 'Invalid asset id' };
}

/**
 * Maps a `relocateAsset` result to the `(status, body)` pair every
 * relocate-shaped route (`relocate.ts`'s generic move/copy, `rename.ts`'s
 * same-folder rename) returns — both are, at bottom, "call `relocateAsset`
 * and report what happened," and were flagged as a 23-line clone by
 * fallow-audit before this extraction. `extraOnRelocated` lets a caller add
 * response fields specific to its own shape (e.g. `rename.ts`'s
 * `extension_changed`) on the success case without re-duplicating the whole
 * switch just to add one field.
 */
export function relocateResultResponse(
  result: RelocateAssetResult,
  extraOnRelocated?: (
    result: Extract<RelocateAssetResult, { kind: 'relocated' }>,
  ) => Record<string, unknown>,
): { status: number; body: unknown } {
  switch (result.kind) {
    case 'relocated':
      return {
        status: 200,
        body: {
          new_abs_path: result.newAbsPath,
          new_path: result.newPath,
          new_filename: result.newFilename,
          renamed_on_collision: result.renamedOnCollision,
          ...(extraOnRelocated ? extraOnRelocated(result) : {}),
        },
      };
    case 'skipped':
      return { status: 200, body: { skipped: true, reason: result.reason } };
    case 'not-found':
      return { status: 404, body: { error: 'Asset not found' } };
    case 'invalid':
      return { status: 400, body: { error: result.error } };
    case 'occupied':
      return {
        status: 409,
        body: {
          error: 'destination is occupied by another asset',
          occupied_by_asset_id: result.occupiedByAssetId,
        },
      };
    case 'error':
      return { status: 500, body: { error: result.error } };
  }
}
