// library-store-rename.ts — pure rekey helper backing
// `LibraryStore.renameAssetId` (#2637).
//
// Extracted out of library-store.service.ts to keep that file under the
// file-size budget headroom (tools/check-budget-headroom.sh, #2311's "split
// with real margin") — this is a self-contained concern (repoint every
// id-keyed map/signal LibraryStore owns after a rename) that doesn't need
// any other method on the class, so it reads cleanly as a free function
// operating on the maps/signal it's handed.

import { WritableSignal } from '@angular/core';
import { Asset, AssetId } from '../models/asset';
import { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling } from '../xmp/xmp.types';

/** The subset of `LibraryStore`'s id-keyed state a rename has to repoint.
 * Passed by reference — the Maps/Sets are mutated in place; `assets` and
 * `adjustmentModels` go through their signal's `update()` since they're
 * read reactively elsewhere. */
export interface RenameRekeyDeps {
  assets: WritableSignal<Asset[]>;
  adjustmentModels: WritableSignal<Map<AssetId, AdjustmentModel>>;
  apiAssetIds: Map<AssetId, string>;
  assetAbsPaths: Map<AssetId, string>;
  asShotWb: Map<AssetId, { temperature: number; tint: number }>;
  sessionEdited: Set<AssetId>;
  sessionCullingPatches: Map<AssetId, Partial<XmpCulling>>;
}

/**
 * Repoint an asset from `oldId` to `newId` after a successful rename.
 * `Asset.id` IS the `slug:relPath` address (see `maple-address.ts`), so a
 * rename — which changes `relPath` — mints a new id; every id-keyed map
 * here has to follow rather than orphan its entry under the stale key.
 * `newFilename` is written onto the asset row itself in the same pass.
 *
 * Selection (`LibrarySelection.selectedAssetIds`/`focusedAssetId`) is a
 * separate store and rekeys itself — see `LibrarySelection.renameAssetId`.
 */
export function rekeyAssetId(
  deps: RenameRekeyDeps,
  oldId: AssetId,
  newId: AssetId,
  newFilename: string,
): void {
  if (oldId === newId) return;
  deps.assets.update((list) =>
    list.map((a) => (a.id === oldId ? { ...a, id: newId, filename: newFilename } : a)),
  );
  const rekeyMap = <V>(map: Map<AssetId, V>): void => {
    if (!map.has(oldId)) return;
    const value = map.get(oldId) as V;
    map.delete(oldId);
    map.set(newId, value);
  };
  deps.adjustmentModels.update((map) => {
    const next = new Map(map);
    rekeyMap(next);
    return next;
  });
  rekeyMap(deps.apiAssetIds);
  rekeyMap(deps.assetAbsPaths);
  rekeyMap(deps.asShotWb);
  if (deps.sessionEdited.has(oldId)) {
    deps.sessionEdited.delete(oldId);
    deps.sessionEdited.add(newId);
  }
  if (deps.sessionCullingPatches.has(oldId)) {
    const patch = deps.sessionCullingPatches.get(oldId) as Partial<XmpCulling>;
    deps.sessionCullingPatches.delete(oldId);
    deps.sessionCullingPatches.set(newId, patch);
  }
}
