import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import {
  BatchMetadataService,
  LibraryStateService,
  parseAddress,
  type Asset,
  type AssetId,
  type AssetMetadataSnapshot,
  type BatchRenameSelection,
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
  readonly batchRenameVisible = signal(false);
  readonly batchRenameSelections = signal<BatchRenameSelection[]>([]);
  readonly moveToVisible = signal(false);
  readonly moveToAssetIds = signal<AssetId[]>([]);
  readonly moveToFolderIds = signal<string[]>([]);
  readonly moveToSourceFolderId = signal<string>('');

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

  /** The currently-selected assets, resolved against the selected folder's
   * live asset list — shared by every action that operates on "whatever is
   * selected right now" (`openMetadata`, `openBatchRename`). `null` when
   * nothing is selected, so callers can early-return with one check instead
   * of repeating the selected-ids-to-assets filter. */
  private selectedAssetsOrNull(): Asset[] | null {
    const selected = this.state.selectedAssetIds();
    const assets = this.state.assetsInSelectedFolder().filter((asset) => selected.has(asset.id));
    return assets.length === 0 ? null : assets;
  }

  /** Re-sync the folder tree and, if the current source is a live Self
   * Hosted subfolder, reopen it — shared by every action whose completion
   * can change filenames/addresses under the current folder
   * (`dismissMetadata`, `onBatchRenameApplied`). */
  private refreshCurrentFolder(): void {
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

  openMetadata(): void {
    const assets = this.selectedAssetsOrNull();
    if (!assets) return;

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
    this.refreshCurrentFolder();
  }

  // ── Batch Rename (#2640) ──────────────────────────────────────────────

  openBatchRename(): void {
    const assets = this.selectedAssetsOrNull();
    if (!assets) return;
    this.batchRenameSelections.set(
      assets.map((asset) => ({ address: asset.id, filename: asset.filename })),
    );
    this.batchRenameVisible.set(true);
  }

  dismissBatchRename(): void {
    this.batchRenameVisible.set(false);
    this.batchRenameSelections.set([]);
  }

  /** Renamed files change filenames/addresses under the current folder —
   * refresh the same way `dismissMetadata` does so the grid reflects the
   * new names without a full page reload. */
  onBatchRenameApplied(): void {
    this.refreshCurrentFolder();
  }

  // ── Move to… (#2644 keyboard-reachable drag-move equivalent) ───────────

  openMoveTo(): void {
    const assets = this.selectedAssetsOrNull() ?? [];
    // Selected grid folders (#2976) ride along in the same move queue,
    // resolved against the live folder list the same way assets are.
    const selectedFolders = this.state.selectedFolderIds();
    const folders = this.state
      .foldersInSelectedFolder()
      .filter((folder) => selectedFolders.has(folder.id));
    const sourceId = this.state.selectedSourceId();
    if ((assets.length === 0 && folders.length === 0) || !sourceId) return;
    this.moveToAssetIds.set(assets.map((asset) => asset.id));
    this.moveToFolderIds.set(folders.map((folder) => folder.id));
    this.moveToSourceFolderId.set(sourceId);
    this.moveToVisible.set(true);
  }

  /** The dialog itself only starts `DragMoveService`'s relocate queue
   * (`DragMoveCapability.beginMove`) and closes immediately — the queue's
   * own collision prompt / completion summary render from
   * `browse-shell.component.html`, not here, so there is nothing else for
   * this dismiss to do beyond resetting the dialog's own inputs. */
  dismissMoveTo(): void {
    this.moveToVisible.set(false);
    this.moveToAssetIds.set([]);
    this.moveToFolderIds.set([]);
    this.moveToSourceFolderId.set('');
  }
}
