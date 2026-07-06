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
// Scope for this task: header (back + filename) + fit-to-screen image +
// Flag/Edit/Info bottom bar (#Web Preview Surface Task 4). Swipe/arrows and
// filmstrip land in later tasks.

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
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
import { routeSegmentsToAddress, editRouteCommands } from '../../addressing/route-address';

@Component({
  selector: 'preview-shell',
  standalone: true,
  imports: [MapleIconComponent, RatingFlagsRowComponent, InfoPanelComponent, BottomSheetComponent],
  templateUrl: './preview-shell.component.html',
  styleUrl: './preview-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreviewShellComponent implements OnDestroy {
  state = inject(LibraryStateService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private layoutService = inject(LayoutService);

  readonly thumbUrl = signal<string | undefined>(undefined);
  readonly previewUrl = signal<string | undefined>(undefined);
  private unsubThumb?: () => void;
  private unsubPreview?: () => void;

  /** Flag popover open/closed (Flag button in the bottom action bar). */
  readonly flagOpen = signal(false);
  /** Info sheet/pane open/closed (Info button in the bottom action bar). */
  readonly infoOpen = signal(false);

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
      this.unsubThumb = this.state.subscribeThumbUrl(id, (u) => this.thumbUrl.set(u));
      this.unsubPreview = this.state.subscribePreviewUrl(id, (u) => this.previewUrl.set(u));
    });
    this.applyRouteAddress();
  }

  ngOnDestroy(): void {
    this.unsubThumb?.();
    this.unsubPreview?.();
  }

  goBack(): void {
    void this.router.navigate(['/browse']);
  }
  edit(): void {
    const id = this.state.focusedAssetId();
    if (id) void this.router.navigate(editRouteCommands(id));
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
