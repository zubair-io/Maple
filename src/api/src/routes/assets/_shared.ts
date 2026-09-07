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
import { findCoreInfoById, parseAssetId, type AssetCoreInfo } from '../../db/assets.repo.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
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

/** An `:id` param resolved to its catalog row. */
export interface ResolvedAssetInfo {
  id: ObjectId;
  info: AssetCoreInfo;
}

/** A catalog row resolved to its primary on-disk location. `libs` is the
 * library-roots map `absPath` was resolved against, handed back so a
 * caller that goes on to derive cache paths from the same roots (histogram)
 * doesn't re-load it. */
export interface ResolvedAssetAbsPath {
  absPath: string;
  libs: ReadonlyMap<string, string>;
}

/** An `:id` param resolved to its catalog row AND its on-disk location. */
export interface ResolvedAssetLocation extends ResolvedAssetInfo, ResolvedAssetAbsPath {}

/** The error body every prelude helper below hands back; callers narrow
 * with `'error' in result` and return it as-is (the status is already on
 * `set`). */
export type AssetRouteError = { error: string };

/** Parse a route's `:id` param and load its catalog row, writing 400
 * (`Invalid asset id`) or 404 (`Asset not found`) into `set` and returning
 * the error body on failure. The first two steps of the prelude nearly
 * every `/api/assets/:id/*` handler opens with — shared so the status codes
 * and messages can't drift between sub-routers, and so fallow-audit stops
 * reporting the block as a clone family across histogram / metadata /
 * overrides / xmp (#1988). Routes that need the on-disk path as well use
 * `resolveAssetLocationOrRespond`. */
export async function resolveAssetInfoOrRespond(
  idParam: string,
  set: { status?: number | string },
): Promise<ResolvedAssetInfo | AssetRouteError> {
  const id = resolveAssetIdOrRespond(idParam, set);
  if ('error' in id) return id;
  const info = await findCoreInfoById(id);
  if (info) return { id, info };
  set.status = 404;
  return { error: 'Asset not found' };
}

/** Resolve an already-loaded catalog row to its primary on-disk path
 * against the registered library roots, writing a 404 (`Asset has no
 * resolvable location`) into `set` and returning the error body when the
 * asset has no live location. */
export async function resolveAssetAbsPathOrRespond(
  info: AssetCoreInfo,
  set: { status?: number | string },
): Promise<ResolvedAssetAbsPath | AssetRouteError> {
  const libs = await loadLibraryRoots();
  const absPath = assetAbsPath(info, libs);
  if (absPath) return { absPath, libs };
  set.status = 404;
  return { error: 'Asset has no resolvable location' };
}

/** The full three-step prelude: parse `:id` → load the row → resolve its
 * on-disk path. Same statuses and messages as the two helpers it composes. */
export async function resolveAssetLocationOrRespond(
  idParam: string,
  set: { status?: number | string },
): Promise<ResolvedAssetLocation | AssetRouteError> {
  const resolved = await resolveAssetInfoOrRespond(idParam, set);
  if ('error' in resolved) return resolved;
  const located = await resolveAssetAbsPathOrRespond(resolved.info, set);
  return 'error' in located ? located : { ...resolved, ...located };
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
