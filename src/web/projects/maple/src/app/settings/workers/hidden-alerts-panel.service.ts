// HiddenAlertsPanelService — owns the "newly auto-hidden" alert list +
// actions for the Workers page. Extracted from WorkersComponent so that
// file stays under the 600-LOC budget; the alert-list markup remains in the
// component template.
//
// Provided at the component level (not root) — the state is ephemeral UI
// for one page, so it lives and dies with the component instance.

import { Injectable, inject, signal } from '@angular/core';
import { type ApiHiddenPhoto, BunApiBackendService, BatchMetadataService } from '@maple-common';

@Injectable()
export class HiddenAlertsPanelService {
  private readonly enrichmentApi = inject(BunApiBackendService);
  private readonly batchMetaSvc = inject(BatchMetadataService);

  readonly alerts = signal<ApiHiddenPhoto[]>([]);

  /** Fetch the current newly-auto-hidden alert list. Best-effort — a failed
   * fetch just leaves the previous (or empty) list in place. */
  fetch(): void {
    this.enrichmentApi.getHiddenPhotos(true).subscribe({
      next: (assets) => this.alerts.set(assets),
      error: () => {},
    });
  }

  private dismiss(assetId: string): void {
    this.alerts.update((list) => list.filter((a) => a.id !== assetId));
  }

  acknowledge(asset: ApiHiddenPhoto): void {
    this.enrichmentApi.acknowledgeHidden(asset.id).subscribe({
      next: () => this.dismiss(asset.id),
    });
  }

  unhide(asset: ApiHiddenPhoto): void {
    if (!asset.address) {
      // No registered library slug for this asset — the batch route can't
      // resolve an address for it. Acknowledge so the alert stops
      // resurfacing; the operator can still unhide from the asset's own
      // detail/batch-metadata panel, which resolves addresses differently.
      this.acknowledge(asset);
      return;
    }
    const entry = {
      address: asset.address,
      metadata: {
        hidden: false,
      },
    };
    this.batchMetaSvc.batchApply([entry]).subscribe({
      next: (res) => {
        if (res.results?.[0]?.ok) {
          this.enrichmentApi.acknowledgeHidden(asset.id).subscribe({
            next: () => this.dismiss(asset.id),
          });
        }
      },
    });
  }
}
