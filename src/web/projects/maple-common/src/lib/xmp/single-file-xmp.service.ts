import { Injectable, inject, signal } from '@angular/core';
import type { AssetId } from '../models/asset';
import { LibraryStore } from '../state/library-store.service';
import { XmpParserService } from './xmp-parser.service';
import { XmpStoreService } from './xmp-store.service';
import { rdfDescriptions } from './xmp-dom-utils';

export type SingleFileXmpDurability = 'none' | 'paired' | 'downloaded';

export interface SingleFileXmpStatus {
  readonly assetId: AssetId | null;
  readonly durability: SingleFileXmpDurability;
  readonly unsaved: boolean;
}

const EMPTY_STATUS: SingleFileXmpStatus = {
  assetId: null,
  durability: 'none',
  unsaved: false,
};

export function assertValidSingleFileXmp(xmp: string): void {
  const document = new DOMParser().parseFromString(xmp, 'text/xml');
  if (document.querySelector('parseerror') || rdfDescriptions(document).length === 0) {
    throw new Error('The paired XMP is not a valid sidecar.');
  }
}

/**
 * Tracks the durability contract for Hosted sessions that cannot write beside
 * the source file. It also owns paired-XMP hydration so model, culling, and
 * unknown XML always enter the editor together.
 */
@Injectable({ providedIn: 'root' })
export class SingleFileXmpService {
  private readonly store = inject(LibraryStore);
  private readonly parser = inject(XmpParserService);
  private readonly xmpStore = inject(XmpStoreService);
  private readonly _status = signal<SingleFileXmpStatus>(EMPTY_STATUS);

  readonly status = this._status.asReadonly();

  open(assetId: AssetId, xmp?: string): void {
    if (xmp === undefined) {
      this.xmpStore.replacePassthroughs([assetId], new Map());
      this._status.set({ assetId, durability: 'none', unsaved: false });
      return;
    }

    assertValidSingleFileXmp(xmp);
    const culling = this.parser.parseCulling(xmp);
    const { model, passthrough } = this.parser.parseAdjustmentModel(xmp);
    this.store.restoreAdjustment(assetId, model);
    this.store.mergePersistedCulling(assetId, culling);
    this.xmpStore.replacePassthroughs([assetId], new Map([[assetId, passthrough]]));
    this._status.set({ assetId, durability: 'paired', unsaved: false });
  }

  markEdited(assetId: AssetId): void {
    const current = this._status();
    this._status.set({
      assetId,
      durability: current.assetId === assetId ? current.durability : 'none',
      unsaved: true,
    });
  }

  markDownloaded(assetId: AssetId): void {
    this._status.set({ assetId, durability: 'downloaded', unsaved: false });
  }
}
