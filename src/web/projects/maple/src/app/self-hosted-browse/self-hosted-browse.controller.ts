import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import {
  BatchMetadataService,
  LibraryStateService,
  parseAddress,
  type AssetMetadataSnapshot,
} from '@maple-common';
import { Subscription } from 'rxjs';

@Injectable()
export class SelfHostedBrowseController {
  private readonly state = inject(LibraryStateService);
  private readonly metadata = inject(BatchMetadataService);
  private snapshotsSubscription: Subscription | null = null;

  readonly panoVisible = signal(false);
  readonly panoAssetIds = signal<string[]>([]);
  readonly metadataVisible = signal(false);
  readonly metadataSnapshots = signal<AssetMetadataSnapshot[]>([]);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.snapshotsSubscription?.unsubscribe());
  }

  openPano(): void {
    this.panoAssetIds.set([...this.state.selectedAssetIds()]);
    this.panoVisible.set(true);
  }

  dismissPano(): void {
    this.panoVisible.set(false);
    this.panoAssetIds.set([]);
  }

  openMetadata(): void {
    const selected = this.state.selectedAssetIds();
    const assets = this.state.assetsInSelectedFolder().filter((asset) => selected.has(asset.id));
    if (assets.length === 0) return;

    this.snapshotsSubscription?.unsubscribe();
    this.snapshotsSubscription = this.metadata
      .fetchSnapshots(assets.map(({ id }) => id))
      .subscribe({
        next: (snapshots) => {
          this.metadataSnapshots.set(snapshots);
          this.metadataVisible.set(true);
        },
        error: () => {
          this.metadataSnapshots.set(
            assets.map((asset) => ({
              address: asset.id,
              metadata: {
                gpsLatitude: asset.gps?.lat,
                gpsLongitude: asset.gps?.lon,
                city: asset.city ?? undefined,
                country: asset.country ?? undefined,
                title: asset.title ?? undefined,
                keywords: asset.keywords,
              },
            })),
          );
          this.metadataVisible.set(true);
        },
      });
  }

  dismissMetadata(): void {
    this.snapshotsSubscription?.unsubscribe();
    this.snapshotsSubscription = null;
    this.metadataVisible.set(false);
    this.metadataSnapshots.set([]);
    this.state.loadFolderTree();

    const currentId = this.state.selectedSourceId();
    if (!currentId?.includes(':')) return;
    try {
      const address = parseAddress(currentId);
      this.state.openSelfHostedSubfolder(address.relPath, currentId);
    } catch {
      // A legacy source id has no subfolder route to refresh.
    }
  }
}
