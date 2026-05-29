// BrowseShell — 3-column layout + window chrome + keyboard handling.
// Ported from _design-reference/app.jsx (WindowChrome + App layout).
// P7: window.location.href navigation replaced by Router.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import { LAST_SOURCE_KEY } from '../../state/library-fetch.service';
import { LayoutService } from '../../layout-service';
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
import { AnchoredOverlayComponent } from '../anchored-overlay.component';

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
    AnchoredOverlayComponent,
  ],
  templateUrl: './browse-shell.component.html',
  styleUrl: './browse-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowseShellComponent implements OnInit {
  state = inject(LibraryStateService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private layout = inject(LayoutService);

  /** S7 follow-up (#645): tablet/desktop sidebar search-pill overlay
   * open-state. Two-way bound into `<app-anchored-overlay>` so the
   * primitive can close itself on Esc / outside-click. */
  protected readonly searchOverlayOpen = signal(false);

  /** Anchor for the search overlay. ElementRef signal so the @if in the
   * template can guard on its existence before binding into the
   * overlay's `anchor` (required) input. */
  protected readonly searchPillRef = viewChild<string, ElementRef<HTMLElement>>('searchPillBtn', {
    read: ElementRef,
  });

  /** Overlay column width per spec §2: 320pt tablet, 480pt desktop.
   * Tracks `LayoutService.layout()` so a window-resize across the
   * breakpoint widens / narrows the overlay live. Phone never opens
   * this overlay (search is full-page there), but the computed still
   * returns the tablet value as a safe default. */
  protected readonly overlayWidthPx = computed(() =>
    this.layout.layout() === 'desktop' ? 480 : 320,
  );

  protected onSearchPillClick(): void {
    this.searchOverlayOpen.update((v) => !v);
  }

  constructor() {
    // ── URL → selection ─────────────────────────────────────────────────────
    // `?folder=<absPath>` deep-links into a folder. Subscribes (not just the
    // snapshot) so back/forward navigation re-applies the URL.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((qp) => {
      const path = qp.get('folder');
      if (!path) return;
      const targetId = `fs:${path}`;
      if (this.state.selectedSourceId() === targetId) return;
      // `openSelfHostedSubfolder` no-ops on non-self-hosted backends; safe
      // to call without a backend check here.
      this.state.openSelfHostedSubfolder(path, targetId);
    });

    // ── Selection → URL + localStorage ──────────────────────────────────────
    // The folder-tree component, asset-grid breadcrumbs, and the post-load
    // auto-select in LibraryFetch all flow through `selectedSourceId`. Mirror
    // every change back into the URL so refreshing or copying the URL lands
    // the user on the same folder.
    effect(() => {
      const id = this.state.selectedSourceId();
      if (!id || !id.startsWith('fs:')) return;
      const path = id.slice(3);
      try {
        localStorage.setItem(LAST_SOURCE_KEY, id);
      } catch {
        /* noop — private mode / quota */
      }
      const current = this.route.snapshot.queryParamMap.get('folder');
      if (current === path) return;
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { folder: path },
        queryParamsHandling: 'merge',
      });
    });
  }

  ngOnInit(): void {
    // Self-Hosted: kick off folder enumeration once the browse page mounts.
    // Lives here (not on the root App component) so it runs AFTER the
    // authGuard passes — otherwise the unauthenticated request races the
    // sign-in redirect and returns 401. `loadFolderTree` also handles the
    // cold-start landing folder — see `_selectInitialFolder`.
    this.state.loadFolderTree();
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
      void this.router.navigate(['/edit', fid]);
      e.preventDefault();
      return;
    }
  }
}
