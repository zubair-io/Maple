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
import { parseAddress } from '../../addressing/maple-address';
import { routeSegmentsToAddress } from '../../addressing/route-address';

@Component({
  selector: 'editor-shell',
  standalone: true,
  imports: [
    MapleIconComponent,
    FilmstripComponent,
    ImageCanvasComponent,
    EditorDetailPanelComponent,
  ],
  styleUrl: './editor-shell.component.scss',
  templateUrl: './editor-shell.component.html',
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

    // M2: deep-link via MapleAddress (slug:relPath). The :slug param carries
    // the slug; the ** wildcard is the image relPath (joined by Router).
    // If id contains ':' it's a MapleAddress string; try to parse it.
    if (id.includes(':') && !id.startsWith('fs:')) {
      try {
        const addr = parseAddress(id);
        // Reconstruct from route URL if id was passed as ':slug' (the full
        // relPath is in the ** segments, not the :id param).
        const slug = this.route.snapshot.paramMap.get('slug') ?? addr.slug;
        const segments = this.route.snapshot.url.slice(1).map((s) => s.path);
        const fullAddr = routeSegmentsToAddress(slug, segments);
        // Synthesize a placeholder asset and load the parent folder.
        if (this.state.backend === 'self-hosted') {
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
        void this.hydrateFromCache(fullAddr.relPath.split('/').pop() ?? id);
        return;
      } catch {
        // Not a MapleAddress — fall through to legacy paths.
      }
    }
    // Legacy Self-Hosted FS-walk cold-load (fs:<absPath>).
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
    // Navigate back to browse (M2: path-based /browse).
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

    // Bare digits only — Cmd/Ctrl+0/1 are the canvas's fit/100% zoom (#1100).
    const meta = e.metaKey || e.ctrlKey;

    // 1–5: star rating
    if (!meta && ['1', '2', '3', '4', '5'].includes(e.key) && fid) {
      this.state.setRating(fid, Number(e.key));
      e.preventDefault();
      return;
    }

    // 0: clear rating
    if (!meta && e.key === '0' && fid) {
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
