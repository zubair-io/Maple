// PreviewShellComponent — fast, static-image preview surface (#Web Preview
// Surface, Task 3).
//
// Renders a plain cached JPEG (grid thumbnail → display preview) with NO
// EditSession/canvas/WASM pipeline — this is the "just show me the photo"
// surface, distinct from the full canvas-first EditorShell.
//
// Route resolution is copied verbatim from EditorShellComponent.applyRouteAddress
// (see editor-shell.component.ts) so slug/fs/imported deep-links resolve
// identically between /edit/:slug/** and /view/:slug/**.
//
// Surface contents: header (back + filename) + fit-to-screen image +
// left filmstrip (routeMode "view") + Flag/Edit/Info bottom bar + prev/next
// navigation via swipe/arrow-keys + rating/flag shortcuts. Edit reaches the
// canvas-first editor (the S5 editor was retired once it reached feature
// parity, epic #1807).

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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import type { Asset, AssetId } from '../../models/asset';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { RatingFlagsRowComponent } from '../../info/rating-flags-row.component';
import { InfoPanelComponent } from '../../info/info-panel.component';
import { BottomSheetComponent } from '../bottom-sheet.component';
import { LayoutService } from '../../layout-service';
import { getPersistedFile } from '../../folder-access/file-cache';
import { formatAddress, parseAddress } from '../../addressing/maple-address';
import {
  routeSegmentsToAddress,
  viewRouteCommands,
  editRouteCommands,
} from '../../addressing/route-address';
import { previewKeyAction } from './preview-shell-keyboard';
import { FilmstripComponent } from '../../components/filmstrip/filmstrip.component';
import { TabBarVisibilityService } from '../tab-bar-visibility.service';

/** Horizontal swipe distance (px) past which a pointerdown→pointerup drag on
 * `.preview-image-wrap` counts as a prev/next gesture rather than a tap. */
const SWIPE_THRESHOLD_PX = 40;

@Component({
  selector: 'preview-shell',
  standalone: true,
  imports: [
    MapleIconComponent,
    RatingFlagsRowComponent,
    InfoPanelComponent,
    BottomSheetComponent,
    FilmstripComponent,
  ],
  templateUrl: './preview-shell.component.html',
  styleUrl: './preview-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreviewShellComponent implements OnInit, OnDestroy {
  state = inject(LibraryStateService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private layoutService = inject(LayoutService);
  private tabBar = inject(TabBarVisibilityService);

  readonly thumbUrl = signal<string | undefined>(undefined);
  readonly previewUrl = signal<string | undefined>(undefined);
  private unsubThumb?: () => void;
  private unsubPreview?: () => void;

  /** Flag popover open/closed (Flag button in the bottom action bar). */
  readonly flagOpen = signal(false);
  /** Info sheet/pane open/closed (Info button in the bottom action bar). */
  readonly infoOpen = signal(false);

  /** Pointer position at the last `pointerdown` on `.preview-image-wrap`,
   * used to classify the matching `pointerup` as a horizontal swipe. */
  private swipeStart: { x: number; y: number } | null = null;

  /** True at the tablet/desktop breakpoint — the shared `LayoutService`
   * signal every shell reads (see root-shell.component.ts). Below this,
   * Info renders in the phone `<app-bottom-sheet>`; at/above it, Info
   * renders as a right-side pane inline in the template. */
  readonly isTabletPlus = computed(() => this.layoutService.layout() !== 'phone');

  readonly assetName = computed<string>(() => {
    const a = this.state.focusedAsset();
    if (!a) return '';
    const parts = a.filename.split('/');
    return parts[parts.length - 1] ?? a.filename;
  });

  constructor() {
    this.route.url.pipe(takeUntilDestroyed()).subscribe(() => this.applyRouteAddress());
    // Re-subscribe image URLs whenever the focused asset changes.
    effect(() => {
      const id = this.state.focusedAssetId();
      this.unsubThumb?.();
      this.unsubPreview?.();
      this.thumbUrl.set(undefined);
      this.previewUrl.set(undefined);
      if (!id) return;
      // On a direct /view navigation (deep link, protocol handler, imported
      // file) no grid tile has necessarily mounted yet to kick off thumbnail
      // extraction the way `asset-thumb`/`library-cell` do on render — so
      // explicitly ensure it here too, mirroring that same
      // `ensureThumbnailUrl` + `subscribeThumbUrl` pairing. `subscribePreviewUrl`
      // already self-triggers its own load for the self-hosted address path
      // (see LibraryCache.subscribePreviewUrl); this covers the remaining
      // FSA/imported/direct path, which only ever delegates to
      // `subscribeThumbUrl` and never calls `ensureThumbnailUrl` on its own.
      const asset = this.state.focusedAsset();
      if (asset) this.state.ensureThumbnailUrl(asset);
      this.unsubThumb = this.state.subscribeThumbUrl(id, (u) => this.thumbUrl.set(u));
      this.unsubPreview = this.state.subscribePreviewUrl(id, (u) => this.previewUrl.set(u));
    });
    this.applyRouteAddress();
  }

  ngOnInit(): void {
    this.tabBar.hidden.set(true);
  }

  ngOnDestroy(): void {
    this.unsubThumb?.();
    this.unsubPreview?.();
    this.tabBar.hidden.set(false);
  }

  goBack(): void {
    // Phone has no `/browse` route — its equivalent surface is the `/library`
    // tab (see root-shell.component.ts's phone tab bar); navigating to
    // `/browse` there would leave the tab route entirely. Tablet/desktop use
    // `/browse`. Reuses the same `isTabletPlus` breakpoint check the template
    // already uses for the Info pane vs sheet split.
    void this.router.navigate([this.isTabletPlus() ? '/browse' : '/library']);
  }
  edit(): void {
    const id = this.state.focusedAssetId();
    // The canvas-first editor reached feature parity and the S5 editor was
    // retired (epic #1807) — Edit now goes straight to it.
    if (id) void this.router.navigate(editRouteCommands(id));
  }

  // ── Prev/next navigation (swipe + arrow keys) ────────────────────────────

  goNext(): void {
    this.state.focusNext();
    const id = this.state.focusedAssetId();
    if (id) void this.router.navigate(viewRouteCommands(id));
  }

  goPrev(): void {
    this.state.focusPrev();
    const id = this.state.focusedAssetId();
    if (id) void this.router.navigate(viewRouteCommands(id));
  }

  // ── Keyboard shortcuts (nav + rating + flag) ─────────────────────────────

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    // Skip when focus is in a text input or textarea (mirrors browse-shell).
    const target = e.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
    )
      return;

    const action = previewKeyAction(e.key);
    if (!action) return;

    switch (action.kind) {
      case 'next':
        this.goNext();
        break;
      case 'prev':
        this.goPrev();
        break;
      case 'rating': {
        const id = this.state.focusedAssetId();
        if (id) this.state.setRating(id, action.value);
        break;
      }
      case 'flag': {
        const id = this.state.focusedAssetId();
        if (id) this.state.setFlag(id, action.flag);
        break;
      }
    }
    e.preventDefault();
  }

  // ── Touch swipe (prev/next) ──────────────────────────────────────────────

  onImagePointerDown(e: PointerEvent): void {
    this.swipeStart = { x: e.clientX, y: e.clientY };
  }

  onImagePointerUp(e: PointerEvent): void {
    const start = this.swipeStart;
    this.swipeStart = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) <= SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
    if (dx > 0) {
      this.goPrev();
    } else {
      this.goNext();
    }
  }

  // ── Route address resolution (copied verbatim from EditorShellComponent) ──

  private applyRouteAddress(): void {
    const slug = this.route.snapshot.paramMap.get('slug');
    if (slug) {
      if (this.state.backend === 'self-hosted' && slug.startsWith('fs:')) {
        const synth = this.state.hydrateSelfHostedFsAsset(slug as AssetId);
        if (synth?.absPath) {
          this.state.selectAsset(synth.id);
          this.openHydratedFsParent(synth);
          return;
        }
      }
      const segments = this.route.snapshot.url.map((s) => s.path);
      const addr = routeSegmentsToAddress(slug, segments);
      const addrStr = formatAddress(addr);
      const assets = this.state.assets();
      const target = assets.find((a) => a.id === addrStr);
      if (target) {
        this.state.selectAsset(target.id);
        return;
      }
      // Entry points that historically routed a raw (non-address) id straight
      // to `/library/editor/:id` — Search, People, Pano, deep-links — now go
      // through `viewRouteCommands()`, which passes such ids through as a
      // single `:slug` segment (see route-address.ts). `formatAddress({slug:
      // rawId, relPath: ''})` yields `"rawId:"` (trailing colon), which never
      // matches `asset.id === rawId` above — so check the raw slug directly
      // before falling through to the self-hosted-synth / cache-hydration
      // paths below, mirroring what `/library/editor/:id` did.
      const rawMatch = assets.find((a) => a.id === slug);
      if (rawMatch) {
        this.state.selectAsset(rawMatch.id);
        return;
      }
      if (this.state.backend === 'self-hosted') {
        const synth = this.state.hydrateSelfHostedFsAsset(addrStr as AssetId);
        if (synth) {
          this.state.selectAsset(synth.id);
          // Load the parent folder (siblings → filmstrip) via the parent
          // address. synth.folderId is the parent's `slug:relPath` (post-cutover
          // the synth no longer carries an absPath to derive the dir from).
          const parentRelPath = parseAddress(synth.folderId).relPath;
          this.state.openSelfHostedSubfolder(parentRelPath, synth.folderId, synth.id);
          return;
        }
      }
      const filename = addr.relPath.split('/').pop() ?? addrStr;
      void this.hydrateFromCache(filename);
      return;
    }

    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;

    const assets = this.state.assets();
    const target =
      id === 'first' ? this.state.assetsInSelectedFolder()[0] : assets.find((a) => a.id === id);

    if (target) {
      this.state.selectAsset(target.id);
      return;
    }

    // Note: the legacy `fs:<absPath>` scheme is retired (post-M2 cutover).
    // Deep-links that used it fall through to the file-cache path below,
    // which redirects to Browse if the file is not in the session cache.

    if (assets.length > 0) {
      this.state.selectAsset(assets[0].id);
      return;
    }

    void this.hydrateFromCache(id);
  }

  private openHydratedFsParent(synth: Asset): void {
    if (synth.id.startsWith('fs:') || !synth.absPath) return;
    const lastSlash = synth.absPath.lastIndexOf('/');
    if (lastSlash < 0) return;
    const parentDir = lastSlash === 0 ? '/' : synth.absPath.slice(0, lastSlash);
    this.state.openSelfHostedSubfolder(parentDir, synth.folderId, synth.id);
  }

  private async hydrateFromCache(id: string): Promise<void> {
    if (id === 'first') return;
    try {
      const record = await getPersistedFile(id);
      if (!record) {
        void this.router.navigate(['/']);
        return;
      }
      const bytes = new Uint8Array(await record.file.arrayBuffer());
      this.state.addImportedAsset(bytes, record.filename, id);
      this.state.selectedSourceId.set('f-imported');
      this.state.selectAsset(id);
    } catch (err) {
      console.error('PreviewShell: hydrateFromCache failed', err);
      void this.router.navigate(['/']);
    }
  }
}
