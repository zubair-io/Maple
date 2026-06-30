// BrowseShell — 3-column layout + window chrome + keyboard handling.
// Ported from _design-reference/app.jsx (WindowChrome + App layout).
// P7: window.location.href navigation replaced by Router.

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import { LAST_SOURCE_KEY } from '../../state/library-fetch.service';
import { TypedStorage } from '../../util/typed-storage';
import { parseAddress, formatAddress } from '../../addressing/maple-address';
import {
  routeSegmentsToAddress,
  addressToRouteSegments,
  editRouteCommands,
} from '../../addressing/route-address';
import { FolderTreeComponent } from '../../components/folder-tree/folder-tree.component';
import { AssetGridComponent } from '../../components/asset-grid/asset-grid.component';
import { DropZoneComponent } from '../../components/drop-zone/drop-zone.component';
import { LoadingBannerComponent } from '../../components/loading-banner/loading-banner.component';
import { ErrorBannerComponent } from '../../components/error-banner/error-banner.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { MaterialIconComponent } from '../../icons/material-icon.component';
import { LibraryPickerComponent } from '../../components/library-picker/library-picker.component';
import { LibraryPickerModalComponent } from '../../components/library-picker-modal/library-picker-modal.component';
import { TimelineViewComponent } from '../../components/timeline-view/timeline-view.component';
import { PanoDialogComponent } from '../../pano/pano-dialog.component';
import { BatchMetadataPanelComponent } from '../../batch-metadata/batch-metadata-panel.component';
import { BatchMetadataService } from '../../batch-metadata/batch-metadata.service';
import type { AssetMetadataSnapshot } from '../../batch-metadata/batch-metadata.types';

@Component({
  selector: 'browse-shell',
  standalone: true,
  imports: [
    RouterLink,
    FolderTreeComponent,
    AssetGridComponent,
    DropZoneComponent,
    LoadingBannerComponent,
    ErrorBannerComponent,
    MapleIconComponent,
    MaterialIconComponent,
    LibraryPickerComponent,
    LibraryPickerModalComponent,
    TimelineViewComponent,
    PanoDialogComponent,
    BatchMetadataPanelComponent,
  ],
  templateUrl: './browse-shell.component.html',
  styleUrl: './browse-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowseShellComponent implements OnInit, OnDestroy {
  state = inject(LibraryStateService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private readonly svc = inject(BatchMetadataService);

  /** True when the pano options dialog is open. */
  readonly panoDialogVisible = signal(false);

  /** Asset ids to stitch — snapshot of selected ids when the dialog opens. */
  readonly panoAssetIds = signal<string[]>([]);

  /** True when ≥2 assets are selected (enables the "Merge to panorama…" button). */
  readonly canMergePano = computed(() => this.state.selectedCount() >= 2);

  /** True when the batch metadata panel is open. */
  readonly batchMetaDialogVisible = signal(false);

  /** Snapshotted asset metadata when the panel opens. */
  readonly batchMetaAssetSnapshots = signal<AssetMetadataSnapshot[]>([]);

  /** True when ≥1 asset is selected (enables "Edit Metadata…" button). */
  readonly canEditMetadata = computed(() => this.state.selectedCount() >= 1);

  private fetchSnapshotsSub: Subscription | null = null;

  constructor() {
    // ── URL (slug:relPath) → selection ─────────────────────────────────────
    // M2: read the MapleAddress from :slug + ** wildcard segments. With
    // paramsInheritanceStrategy:'always', :slug is inherited by the ** child
    // route so paramMap.get('slug') works here. We also subscribe to
    // route.url (which emits when the wildcard segments change) so that
    // navigating within the same library (same slug, different relPath) re-
    // triggers the address resolution.
    const applyRouteAddress = (slug: string): void => {
      // route.snapshot.url contains ONLY the wildcard (child) segments — no
      // leading slug segment — because :slug lives on the parent route.
      const segments = this.route.snapshot.url.map((s) => s.path);
      const addr = routeSegmentsToAddress(slug, segments);
      const addrStr = formatAddress(addr);
      if (this.state.selectedSourceId() === addrStr) return;
      this.state.openSelfHostedSubfolder(addr.relPath, addrStr);
    };

    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((pm) => {
      const slug = pm.get('slug');
      if (!slug) return;
      applyRouteAddress(slug);
    });

    // Re-fire when wildcard segments change (intra-library folder navigation).
    this.route.url.pipe(takeUntilDestroyed()).subscribe(() => {
      const slug = this.route.snapshot.paramMap.get('slug');
      if (!slug) return;
      applyRouteAddress(slug);
    });

    // ── Selection → URL + localStorage ──────────────────────────────────────
    // Mirror every address change back into the path-based URL.
    effect(() => {
      const id = this.state.selectedSourceId();
      if (!id || !id.includes(':')) return;
      try {
        const addr = parseAddress(id);
        TypedStorage.setRaw(LAST_SOURCE_KEY, id);
        const segments = addressToRouteSegments(addr, 'browse');
        void this.router.navigate(segments);
      } catch {
        // Legacy id or unparseable — ignore.
      }
    });
  }

  // ── Pano dialog ───────────────────────────────────────────────────────────
  onMergePano(): void {
    // Snapshot the selection at click time so the dialog has a stable list.
    this.panoAssetIds.set([...this.state.selectedAssetIds()]);
    this.panoDialogVisible.set(true);
  }

  onPanoDismiss(): void {
    this.panoDialogVisible.set(false);
    this.panoAssetIds.set([]);
  }

  // ── Batch metadata dialog ─────────────────────────────────────────────────
  onEditMetadata(): void {
    const selectedIds = this.state.selectedAssetIds();
    const assets = this.state.assetsInSelectedFolder().filter((a) => selectedIds.has(a.id));
    const addresses = assets.map((a) => a.id);
    if (addresses.length === 0) return;

    // Fetch the full effective metadata from the API so computeMixedValues can
    // show "(mixed)" across all 22 fields, not just the thin asset view-model subset.
    this.fetchSnapshotsSub?.unsubscribe();
    this.fetchSnapshotsSub = this.svc.fetchSnapshots(addresses).subscribe({
      next: (snapshots) => {
        this.batchMetaAssetSnapshots.set(snapshots);
        this.batchMetaDialogVisible.set(true);
      },
      error: () => {
        // API unavailable — fall back to the thin snapshot so the panel still opens.
        const thinSnapshots: AssetMetadataSnapshot[] = assets.map((a) => ({
          address: a.id,
          metadata: {
            gpsLatitude: a.gps?.lat,
            gpsLongitude: a.gps?.lon,
            city: a.city ?? undefined,
            country: a.country ?? undefined,
            title: a.title ?? undefined,
            keywords: a.keywords,
          },
        }));
        this.batchMetaAssetSnapshots.set(thinSnapshots);
        this.batchMetaDialogVisible.set(true);
      },
    });
  }

  onBatchMetaDismiss(): void {
    this.fetchSnapshotsSub?.unsubscribe();
    this.fetchSnapshotsSub = null;
    this.batchMetaDialogVisible.set(false);
    this.batchMetaAssetSnapshots.set([]);
  }

  ngOnInit(): void {
    // Self-Hosted: kick off folder enumeration once the browse page mounts.
    // Lives here (not on the root App component) so it runs AFTER the
    // authGuard passes — otherwise the unauthenticated request races the
    // sign-in redirect and returns 401. `loadFolderTree` also handles the
    // cold-start landing folder — see `_selectInitialFolder`.
    this.state.loadFolderTree();
  }

  ngOnDestroy(): void {
    this.fetchSnapshotsSub?.unsubscribe();
  }

  onRetryLoad(): void {
    this.state.loadFolderTree();
  }

  // ── Toolbar search input ──────────────────────────────────────────────────
  onSearchInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.state.searchQuery.set(v);
  }

  /** Enter on the search input — push the query to the structured /search
   * page so the user can filter across the whole index, not just this folder. */
  onSearchEnter(): void {
    const q = this.state.searchQuery().trim();
    void this.router.navigate(['/search'], {
      queryParams: q.length > 0 ? { q } : {},
    });
  }

  // ── Page unload — flush pending XMP writes ───────────────────────────────
  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    void this.state.flushPendingXmpWrites();
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    // Skip when focus is in a text input or textarea.
    const target = e.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
    )
      return;

    const fid = this.state.focusedAssetId();

    // 1–5: star rating
    if (['1', '2', '3', '4', '5'].includes(e.key) && fid) {
      this.state.setRating(fid, Number(e.key));
      e.preventDefault();
      return;
    }

    // 0: clear rating
    if (e.key === '0' && fid) {
      this.state.setRating(fid, 0);
      e.preventDefault();
      return;
    }

    // P: pick
    if ((e.key === 'p' || e.key === 'P') && fid) {
      const asset = this.state.focusedAsset();
      if (asset) {
        this.state.setFlag(fid, asset.flag === 'pick' ? 'unflagged' : 'pick');
      }
      e.preventDefault();
      return;
    }

    // X: reject
    if ((e.key === 'x' || e.key === 'X') && fid) {
      const asset = this.state.focusedAsset();
      if (asset) {
        this.state.setFlag(fid, asset.flag === 'reject' ? 'unflagged' : 'reject');
      }
      e.preventDefault();
      return;
    }

    // U: clear flag
    if ((e.key === 'u' || e.key === 'U') && fid) {
      this.state.setFlag(fid, 'unflagged');
      e.preventDefault();
      return;
    }

    // Arrow keys: navigate grid
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      this.state.focusNext();
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      this.state.focusPrev();
      e.preventDefault();
      return;
    }

    // ⌘⌥S / Ctrl+Alt+S — toggle sidebar
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
      this.state.toggleSidebar();
      e.preventDefault();
      return;
    }

    // Enter on focused asset — navigate to editor
    if (e.key === 'Enter' && fid) {
      void this.router.navigate(editRouteCommands(fid));
      e.preventDefault();
      return;
    }
  }
}
