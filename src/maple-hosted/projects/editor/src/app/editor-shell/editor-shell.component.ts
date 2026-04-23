// EditorShell — 3-column layout with window chrome, keyboard handling, and
// 180ms ease-out layout transition between panel states.
// Ported from _design-reference/app.jsx (full-image mode).

import { Component, HostListener, OnInit, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { LibraryStateService } from '@maple-common';
import { MapleIconComponent } from '@maple-common';
import { FilmstripComponent } from '../filmstrip/filmstrip.component';
import { ImageCanvasComponent } from '../image-canvas/image-canvas.component';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { DetailPanelComponent } from '../detail-panel/detail-panel.component';

@Component({
  selector: 'editor-shell',
  standalone: true,
  imports: [
    MapleIconComponent,
    FilmstripComponent,
    ImageCanvasComponent,
    DetailPanelComponent,
  ],
  styles: [`
    :host {
      display: flex;
      width: 100vw;
      height: 100vh;
      background: #0d0c0b;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
    }

    /* App window */
    .window {
      width: 100%;
      height: 100%;
      max-width: 1500px;
      max-height: 1000px;
      background: var(--maple-bg);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 80px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.06);
      font-family: var(--maple-font);
    }

    /* Titlebar */
    .titlebar {
      height: 40px;
      display: flex;
      align-items: center;
      background: var(--maple-surface);
      border-bottom: 0.5px solid var(--maple-border);
      padding: 0 12px;
      flex-shrink: 0;
      gap: 10px;
    }

    .traffic-lights { display: flex; gap: 8px; align-items: center; }
    .tl-dot {
      width: 12px; height: 12px; border-radius: 50%;
      border: 0.5px solid rgba(0,0,0,0.18);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 8px; font-weight: 700; color: rgba(0,0,0,0.55);
    }
    .tl-close  { background: #ff5f56; }
    .tl-min    { background: #ffbd2e; }
    .tl-max    { background: #27c93f; }
    .traffic-lights .symbol { display: none; }
    .traffic-lights:hover .symbol { display: inline; }

    /* Back button */
    .back-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      padding: 0 8px;
      border-radius: 5px;
      background: var(--maple-surface-alt);
      border: 0.5px solid var(--maple-border);
      font-family: var(--maple-font);
      font-size: 11px;
      color: var(--maple-text-muted);
      cursor: pointer;
      transition: background 100ms;
    }
    .back-btn:hover { background: var(--maple-surface-hover); color: var(--maple-text-main); }

    /* Chrome buttons */
    .chrome-btn {
      width: 28px; height: 24px; border-radius: 5px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: background 120ms;
      border: 0.5px solid transparent;
    }
    .chrome-btn:hover { background: var(--maple-surface-hover); border-color: var(--maple-border); }
    .chrome-btn.active { background: rgba(255,255,255,0.04); border-color: var(--maple-border); }

    /* Title */
    .title {
      flex: 1; text-align: center; font-size: 12px; font-weight: 500;
      color: var(--maple-text-main); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }

    /* Export button */
    .export-btn {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 10px; border-radius: 5px; font-size: 11px; cursor: pointer;
    }
    .export-btn.has-selection {
      background: var(--maple-primary-dim); color: var(--maple-primary);
      border: 0.5px solid var(--maple-primary);
    }
    .export-btn.no-selection {
      background: var(--maple-input-bg); color: var(--maple-text-muted);
      border: 0.5px solid var(--maple-border); opacity: 0.5; cursor: default;
    }

    /* Body */
    .body {
      flex: 1; display: flex; min-height: 0; min-width: 0;
      background: var(--maple-bg);
    }

    /* Panels */
    .panel-left {
      flex-shrink: 0; overflow: hidden;
      transition: width 180ms ease-out;
    }
    .panel-center {
      flex: 1; display: flex; flex-direction: column;
      min-width: 0; position: relative;
      transition: opacity 180ms ease-out;
    }
    .panel-right {
      flex-shrink: 0; overflow: hidden;
      transition: width 180ms ease-out;
      border-left: 0.5px solid var(--maple-border);
    }
    .panel-right.hidden { border-left: none; }
  `],
  template: `
    <div class="window">
      <!-- Titlebar -->
      <div class="titlebar">
        <!-- Traffic lights -->
        <div class="traffic-lights">
          <div class="tl-dot tl-close" title="Close"><span class="symbol">×</span></div>
          <div class="tl-dot tl-min"   title="Minimize"><span class="symbol">–</span></div>
          <div class="tl-dot tl-max"   title="Full screen"><span class="symbol">⤢</span></div>
        </div>

        <!-- Back to Browse -->
        <div class="back-btn" (click)="goBack()" title="Back to Browse (Esc)">
          <maple-icon name="back" [size]="11" color="var(--maple-text-muted)"/>
          <span>Library</span>
        </div>

        <!-- Filmstrip toggle -->
        <div class="chrome-btn" [class.active]="state.sidebarVisible()"
          [title]="filmstripToggleTitle()"
          (click)="state.toggleSidebar()">
          <maple-icon name="sidebar" [size]="13"
            [color]="state.sidebarVisible() ? 'var(--maple-text-main)' : 'var(--maple-text-muted)'"/>
        </div>

        <!-- Title -->
        <div class="title">{{ titleText() }}</div>

        <!-- Export -->
        <div class="export-btn"
          [class.has-selection]="state.focusedAssetId() !== null"
          [class.no-selection]="state.focusedAssetId() === null">
          <maple-icon name="export" [size]="11"/>
          <span>Export</span>
        </div>

        <!-- Inspector toggle -->
        <div class="chrome-btn" [class.active]="state.inspectorVisible()"
          [title]="(state.inspectorVisible() ? 'Hide' : 'Show') + ' inspector  ⌥⌘D'"
          (click)="state.toggleInspector()">
          <maple-icon name="inspector" [size]="13"
            [color]="state.inspectorVisible() ? 'var(--maple-text-main)' : 'var(--maple-text-muted)'"/>
        </div>
      </div>

      <!-- Body -->
      <div class="body">
        <!-- Left: filmstrip -->
        <div class="panel-left"
          [style.width]="state.sidebarVisible() ? '110px' : '0px'">
          <editor-filmstrip/>
        </div>

        <!-- Center: image canvas (crossfade on asset change) -->
        <div class="panel-center">
          <editor-image-canvas/>
        </div>

        <!-- Right: detail panel -->
        <div class="panel-right"
          [class.hidden]="!state.inspectorVisible()"
          [style.width]="state.inspectorVisible() ? '280px' : '0px'">
          <editor-detail-panel/>
        </div>
      </div>
    </div>
  `,
})
export class EditorShellComponent implements OnInit {
  state     = inject(LibraryStateService);
  canvasSvc = inject(ImageCanvasService);
  private route  = inject(ActivatedRoute);
  private router = inject(Router);

  // ── Page unload — flush pending XMP writes ────────────────────────────────
  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    void this.state.flushPendingXmpWrites();
  }

  titleText = computed(() => {
    const asset = this.state.focusedAsset();
    return asset ? `${asset.filename} — Editor` : 'Maple Editor';
  });

  filmstripToggleTitle = computed(() =>
    (this.state.sidebarVisible() ? 'Hide' : 'Show') + ' filmstrip  (\\)'
  );

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      const assets = this.state.assets();
      // Resolve 'first' sentinel
      const target = id === 'first'
        ? this.state.assetsInSelectedFolder()[0]
        : assets.find(a => a.id === id);
      if (target) {
        this.state.selectAsset(target.id);
      } else if (assets.length > 0) {
        this.state.selectAsset(assets[0].id);
      }
    }
  }

  goBack(): void {
    // Cross-app navigation: browse runs on a separate origin/port in dev.
    const browseBase = window.location.port === '4300'
      ? `http://localhost:4200`
      : `${window.location.origin}/browse`;
    window.location.href = browseBase;
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
    ) return;

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
          this.router.navigate(['edit', prev]);
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
          this.router.navigate(['edit', next]);
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
