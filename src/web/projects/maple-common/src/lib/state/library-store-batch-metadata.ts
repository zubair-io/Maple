// library-store-batch-metadata.ts — apply server-persisted Batch Metadata
// updates directly to in-memory LibraryStore state (#5295).
//
// Extracted out of library-store.service.ts to keep that file under the
// file-size budget headroom (tools/check-budget-headroom.sh, #2311).

import { WritableSignal } from '@angular/core';
import type { BatchApplyMetadata } from '../batch-metadata/batch-metadata.types';
import { Asset, AssetId } from '../models/asset';
import type { XmpCulling } from '../xmp/xmp.types';

export interface BatchMetadataStoreDeps {
  readonly assets: WritableSignal<Asset[]>;
  readonly sessionCullingPatches: Map<AssetId, Partial<XmpCulling>>;
}

export interface BatchMetadataStoreUpdate {
  readonly id: AssetId;
  readonly metadata: BatchApplyMetadata;
}

function toCullingPatch(meta: BatchApplyMetadata): Partial<XmpCulling> {
  return {
    ...(meta.rating !== undefined ? { rating: meta.rating ?? 0 } : {}),
    ...(meta.flag !== undefined ? { flag: meta.flag ?? 'unflagged' } : {}),
    ...(meta.colorLabel !== undefined ? { colorLabel: meta.colorLabel } : {}),
    ...(meta.keywords !== undefined ? { keywords: meta.keywords ? [...meta.keywords] : [] } : {}),
  };
}

function applyMetadataToAsset(
  asset: Asset,
  meta: BatchApplyMetadata,
  cullingPatch: Partial<XmpCulling>,
): Asset {
  const next: Asset = { ...asset, ...cullingPatch, edited: true };
  if (meta.hidden !== undefined) {
    if (meta.hidden === null) delete next.hidden;
    else next.hidden = meta.hidden;
  }
  if (meta.title !== undefined) {
    if (meta.title === null) delete next.title;
    else next.title = meta.title;
  }
  if (meta.city !== undefined) {
    if (meta.city === null) delete next.city;
    else next.city = meta.city;
  }
  if (meta.state !== undefined) {
    if (meta.state === null) delete next.region;
    else next.region = meta.state;
  }
  if (meta.country !== undefined) {
    if (meta.country === null) delete next.country;
    else next.country = meta.country;
  }
  if (meta.gpsLatitude !== undefined || meta.gpsLongitude !== undefined) {
    if (meta.gpsLatitude === null || meta.gpsLongitude === null) {
      delete next.gps;
    } else if (meta.gpsLatitude != null && meta.gpsLongitude != null) {
      next.gps = { lat: meta.gpsLatitude, lon: meta.gpsLongitude };
    }
  }
  return next;
}

export function applyBatchMetadataToStore(
  deps: BatchMetadataStoreDeps,
  updates: readonly BatchMetadataStoreUpdate[],
): void {
  if (updates.length === 0) return;
  const patchesByAsset = new Map<
    AssetId,
    { metadata: BatchApplyMetadata; cullingPatch: Partial<XmpCulling> }
  >();
  for (const { id, metadata } of updates) {
    const cullingPatch = toCullingPatch(metadata);
    if (Object.keys(cullingPatch).length > 0) {
      deps.sessionCullingPatches.set(id, {
        ...deps.sessionCullingPatches.get(id),
        ...cullingPatch,
      });
    }
    patchesByAsset.set(id, { metadata, cullingPatch });
  }

  deps.assets.update((list) =>
    list.map((asset) => {
      const update = patchesByAsset.get(asset.id);
      return update ? applyMetadataToAsset(asset, update.metadata, update.cullingPatch) : asset;
    }),
  );
}
