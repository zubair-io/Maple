// adjustment-clipboard.service.ts — app-level develop-settings clipboard
// for copy / paste / selective paste (#944).
//
// Session-scoped, in-memory only. Deliberately NOT persisted to IndexedDB
// or localStorage (YAGNI — not in the ticket, and a stale cross-session
// clipboard pasting onto the wrong photos is a foot-gun, not a feature).

import { Injectable, computed, signal } from '@angular/core';
import type { AssetId } from '../../models/asset';
import type { AdjustmentModel } from '../../models/adjustment-model';

/** A copied asset's full develop settings plus enough identity to label
 * the source in the paste-settings dialog. */
export interface AdjustmentClipboardEntry {
  readonly sourceAssetId: AssetId;
  readonly sourceLabel: string;
  readonly model: AdjustmentModel;
}

@Injectable({ providedIn: 'root' })
export class AdjustmentClipboardService {
  private readonly _entry = signal<AdjustmentClipboardEntry | null>(null);

  readonly entry = this._entry.asReadonly();
  readonly hasContents = computed(() => this._entry() !== null);

  /**
   * Snapshot `model` into the clipboard. Deep-copies `crop` so later edits
   * to the source asset's live model (an object owned by `LibraryStore`)
   * can never mutate the clipboard's frozen copy.
   */
  copyFrom(sourceAssetId: AssetId, sourceLabel: string, model: AdjustmentModel): void {
    this._entry.set({
      sourceAssetId,
      sourceLabel,
      model: { ...model, crop: { ...model.crop } },
    });
  }

  clear(): void {
    this._entry.set(null);
  }
}
