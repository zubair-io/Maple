// EditorShell — 3-column layout with window chrome, keyboard handling, and
// 180ms ease-out layout transition between panel states.
// Ported from _design-reference/app.jsx (full-image mode).
// P7: window.location.href navigation replaced by Router.

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import type { AssetId } from '../../models/asset';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { FilmstripComponent } from '../../components/filmstrip/filmstrip.component';
import { ImageCanvasComponent } from '../../components/image-canvas/image-canvas.component';
import { ImageCanvasService } from '../../components/image-canvas/image-canvas.service';
import { EditorDetailPanelComponent } from '../../components/editor-detail-panel/editor-detail-panel.component';
import { getPersistedFile } from '../../folder-access/file-cache';

@Component({
  selector: 'editor-shell',
  standalone: true,
  imports: [
    MapleIconComponent,
    FilmstripComponent,
    ImageCanvasComponent,
    EditorDetailPanelComponent,
  ],
  styles: [
    `
      // Tailwind utilities cover the layout, typography, and hover states.
      // What's left here:
      //   - :host viewport sizing — Angular host selector.
      //   - .chrome-btn.is-active background — bound via [class.is-active] on
      //     the element, can't be expressed as a containment-style variant.
      //   - .export-btn.has-selection / .no-selection — same reason.
      //   - .panel-right.is-hidden border removal.
      :host {
        display: flex;
        width: 100vw;
        height: 100vh;
        background: var(--color-bg);
        box-sizing: border-box;
      }

      .chrome-btn.is-active {
        background: rgba(255, 255, 255, 0.04);
        border-color: var(--color-border);
      }

      .export-btn.has-selection {
        background: var(--color-primary-dim);
        color: var(--color-primary);
        border: 0.5px solid var(--color-primary);
      }
      .export-btn.no-selection {
        background: var(--color-input-bg);
        color: var(--color-text-muted);
        border: 0.5px solid var(--color-border);
        opacity: 0.5;
        cursor: default;
      }

      .panel-right.is-hidden {
        border-left: none;
      }
    `,
  ],
  template: `
    <div class="w-full h-full bg-bg overflow-hidden flex flex-col font-sans">
      <!-- Toolbar -->
      <div
        class="flex items-center h-10 bg-surface border-b-[0.5px] border-border px-3 flex-shrink-0 gap-2.5"
      >
        <!-- Back to Browse -->
        <div
          class="flex items-center gap-1 h-6 px-2 rounded-[5px] bg-surface-alt border-[0.5px] border-border font-sans text-[11px] text-text-muted cursor-pointer transition-colors duration-100 hover:bg-surface-hover hover:text-text-main"
          (click)="goBack()"
          title="Back to Browse (Esc)"
        >
          <maple-icon name="back" [size]="11" color="var(--color-text-muted)" />
          <span>Library</span>
        </div>

        <!-- Filmstrip toggle — hidden when there's only one photo to navigate. -->
        @if (hasMultiplePhotos()) {
          <div
            class="chrome-btn w-7 h-6 rounded-[5px] flex items-center justify-center cursor-pointer transition-colors duration-[120ms] border-[0.5px] border-transparent hover:bg-surface-hover hover:border-border"
            [class.is-active]="state.sidebarVisible()"
            [title]="filmstripToggleTitle()"
            (click)="state.toggleSidebar()"
          >
            <maple-icon
              name="sidebar"
              [size]="13"
              [color]="
                state.sidebarVisible() ? 'var(--color-text-main)' : 'var(--color-text-muted)'
              "
            />
          </div>
        }

        <div class="flex-1"></div>

        <!-- Export -->
        <div
          class="export-btn flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-[11px] cursor-pointer"
          [class.has-selection]="state.focusedAssetId() !== null"
          [class.no-selection]="state.focusedAssetId() === null"
        >
          <maple-icon name="export" [size]="11" />
          <span>Export</span>
        </div>

        <!-- Inspector toggle -->
        <div
          class="chrome-btn w-7 h-6 rounded-[5px] flex items-center justify-center cursor-pointer transition-colors duration-[120ms] border-[0.5px] border-transparent hover:bg-surface-hover hover:border-border"
          [class.is-active]="state.inspectorVisible()"
          [title]="(state.inspectorVisible() ? 'Hide' : 'Show') + ' inspector  ⌥⌘D'"
          (click)="state.toggleInspector()"
        >
          <maple-icon
            name="inspector"
            [size]="13"
            [color]="
              state.inspectorVisible() ? 'var(--color-text-main)' : 'var(--color-text-muted)'
            "
          />
        </div>
      </div>

      <!-- Body -->
      <div class="flex-1 flex min-h-0 min-w-0 bg-bg">
        <!-- Left: filmstrip (only when multiple photos are in the folder) -->
        @if (hasMultiplePhotos()) {
          <div
            class="flex-shrink-0 overflow-hidden transition-[width] duration-[180ms] ease-out"
            [style.width]="state.sidebarVisible() ? '110px' : '0px'"
          >
            <editor-filmstrip />
          </div>
        }

        <!-- Center: image canvas (crossfade on asset change) -->
        <div class="flex-1 flex flex-col min-w-0 relative transition-opacity duration-[180ms] ease-out">
          <editor-image-canvas />
        </div>

        <!-- Right: detail panel -->
        <div
          class="panel-right flex-shrink-0 overflow-hidden transition-[width] duration-[180ms] ease-out border-l-[0.5px] border-border"
          [class.is-hidden]="!state.inspectorVisible()"
          [style.width]="state.inspectorVisible() ? '280px' : '0px'"
        >
          <editor-detail-panel />
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorShellComponent implements OnInit {
  state = inject(LibraryStateService);
  canvasSvc = inject(ImageCanvasService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  // ── Page unload — flush pending XMP writes ────────────────────────────────
  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    void this.state.flushPendingXmpWrites();
  }

  filmstripToggleTitle = computed(
    () => (this.state.sidebarVisible() ? 'Hide' : 'Show') + ' filmstrip  (\\)',
  );

  /** Filmstrip + its toggle are hidden in the single-photo case (landing →
   * "Open a photo") so the editor becomes a clean full-image view. */
  hasMultiplePhotos = computed(() => this.state.assetsInSelectedFolder().length > 1);

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;

    const assets = this.state.assets();
    const target =
      id === 'first' ? this.state.assetsInSelectedFolder()[0] : assets.find((a) => a.id === id);

    if (target) {
      this.state.selectAsset(target.id);
      return;
    }

    // Self-Hosted FS-walk cold-load: deep-link to /edit/fs:<absPath>
    // (browser refresh, shared link, etc.) without first navigating via
    // Browse. Synthesize a placeholder asset so the editor mounts and
    // starts fetching bytes from /api/fs/raw immediately, then fire the
    // parent-dir listing in the background to populate the filmstrip with
    // siblings. The third arg keeps OUR asset selected after the listing
    // arrives instead of the listing's first entry.
    if (this.state.backend === 'self-hosted' && id.startsWith('fs:')) {
      const synth = this.state.hydrateSelfHostedFsAsset(id as AssetId);
      if (synth?.absPath) {
        this.state.selectAsset(synth.id);
        const lastSlash = synth.absPath.lastIndexOf('/');
        if (lastSlash > 0) {
          const parentDir = synth.absPath.slice(0, lastSlash);
          this.state.openSelfHostedSubfolder(parentDir, synth.folderId, synth.id);
        }
        return;
      }
    }

    if (assets.length > 0) {
      this.state.selectAsset(assets[0].id);
      return;
    }

    // Cold load — nothing in memory, but the URL carries an asset id that
    // may have been persisted on a previous session. Try the file cache.
    void this.hydrateFromCache(id);
  }

  private async hydrateFromCache(id: string): Promise<void> {
    if (id === 'first') return;
    try {
      const record = await getPersistedFile(id);
      if (!record) {
        // Nothing in cache — fall back to Browse so the user can reopen.
        void this.router.navigate(['/']);
        return;
      }
      const bytes = new Uint8Array(await record.file.arrayBuffer());
      this.state.addImportedAsset(bytes, record.filename, id);
      this.state.selectedSourceId.set('f-imported');
      this.state.selectAsset(id);
    } catch (err) {
      console.error('EditorShell: hydrateFromCache failed', err);
      void this.router.navigate(['/']);
    }
  }

  goBack(): void {
    // P7: Router.navigate replaces window.location.href cross-app hack.
    void this.router.navigate(['/browse']);
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    // Don't steal from text inputs
    const target = e.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
    )
      return;

    const fid = this.state.focusedAssetId();

    // Esc — back to browse
    if (e.key === 'Escape') {
      this.goBack();
      e.preventDefault();
      return;
    }

    // Arrow left/right — prev/next asset in filmstrip
    if (e.key === 'ArrowLeft') {
      if (fid) {
        const prev = this.state.peekPrev(fid);
        if (prev) {
          this.state.selectAsset(prev);
          void this.router.navigate(['/edit', prev]);
        }
      }
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowRight') {
      if (fid) {
        const next = this.state.peekNext(fid);
        if (next) {
          this.state.selectAsset(next);
          void this.router.navigate(['/edit', next]);
        }
      }
      e.preventDefault();
      return;
    }

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
      if (asset) this.state.setFlag(fid, asset.flag === 'pick' ? 'unflagged' : 'pick');
      e.preventDefault();
      return;
    }

    // X: reject
    if ((e.key === 'x' || e.key === 'X') && fid) {
      const asset = this.state.focusedAsset();
      if (asset) this.state.setFlag(fid, asset.flag === 'reject' ? 'unflagged' : 'reject');
      e.preventDefault();
      return;
    }

    // U: clear flag
    if ((e.key === 'u' || e.key === 'U') && fid) {
      this.state.setFlag(fid, 'unflagged');
      e.preventDefault();
      return;
    }

    // b: toggle before/after
    if (e.key === 'b' || e.key === 'B') {
      this.canvasSvc.toggleBeforeAfter();
      e.preventDefault();
      return;
    }

    // \ : toggle filmstrip (sidebar)
    if (e.key === '\\') {
      this.state.toggleSidebar();
      e.preventDefault();
      return;
    }

    // ⌘⌥S / Ctrl+Alt+S — toggle sidebar/filmstrip
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
      this.state.toggleSidebar();
      e.preventDefault();
      return;
    }

    // ⌘⌥D / Ctrl+Alt+D — toggle inspector
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
      this.state.toggleInspector();
      e.preventDefault();
      return;
    }
  }
}
