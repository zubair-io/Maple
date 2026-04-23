// BrowseShell — 3-column layout + window chrome + keyboard handling.
// Ported from _design-reference/app.jsx (WindowChrome + App layout).
// P7: window.location.href navigation replaced by Router.

import { Component, HostListener, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LibraryStateService } from '../../state/library-state.service';
import { FolderTreeComponent } from '../../components/folder-tree/folder-tree.component';
import { AssetGridComponent } from '../../components/asset-grid/asset-grid.component';
import { BrowseDetailPanelComponent } from '../../components/browse-detail-panel/browse-detail-panel.component';
import { DropZoneComponent } from '../../components/drop-zone/drop-zone.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';

@Component({
  selector: 'browse-shell',
  standalone: true,
  imports: [
    FolderTreeComponent,
    AssetGridComponent,
    BrowseDetailPanelComponent,
    DropZoneComponent,
    MapleIconComponent,
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

    /* App window chrome */
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

    /* Traffic-light dots */
    .traffic-lights {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .tl-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 0.5px solid rgba(0,0,0,0.18);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-family: var(--maple-font);
      font-size: 8px;
      font-weight: 700;
      color: rgba(0,0,0,0.55);
    }
    .tl-close  { background: #ff5f56; }
    .tl-min    { background: #ffbd2e; }
    .tl-max    { background: #27c93f; }
    .traffic-lights .symbol { display: none; }
    .traffic-lights:hover .symbol { display: inline; }

    /* Chrome buttons (sidebar / inspector toggles) */
    .chrome-btn {
      width: 28px;
      height: 24px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 120ms;
      border: 0.5px solid transparent;
    }
    .chrome-btn:hover {
      background: var(--maple-surface-hover);
      border-color: var(--maple-border);
    }
    .chrome-btn.active {
      background: rgba(255,255,255,0.04);
      border-color: var(--maple-border);
    }

    /* Title */
    .title {
      flex: 1;
      text-align: center;
      font-family: var(--maple-font);
      font-size: 12px;
      font-weight: 500;
      color: var(--maple-text-main);
      letter-spacing: 0.1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Export button */
    .export-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 5px;
      font-family: var(--maple-font);
      font-size: 11px;
      cursor: pointer;
    }
    .export-btn.has-selection {
      background: var(--maple-primary-dim);
      color: var(--maple-primary);
      border: 0.5px solid var(--maple-primary);
    }
    .export-btn.no-selection {
      background: var(--maple-input-bg);
      color: var(--maple-text-muted);
      border: 0.5px solid var(--maple-border);
      opacity: 0.5;
      cursor: default;
    }

    /* Body — 3-column flex */
    .body {
      flex: 1;
      display: flex;
      min-height: 0;
      min-width: 0;
      background: var(--maple-bg);
    }

    /* Left panel (sidebar) */
    .panel-left {
      flex-shrink: 0;
      overflow: hidden;
      transition: width 220ms var(--maple-ease);
      position: relative;
    }

    /* Center panel */
    .panel-center {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    /* Right panel (inspector) */
    .panel-right {
      flex-shrink: 0;
      overflow: hidden;
      transition: width 220ms var(--maple-ease);
      border-left: 0.5px solid var(--maple-border);
    }
    .panel-right.hidden { border-left: none; }
  `],
  template: `
    <div class="window">
      <!-- Titlebar / Window Chrome -->
      <div class="titlebar">
        <!-- Traffic lights -->
        <div class="traffic-lights">
          <div class="tl-dot tl-close" title="Close">
            <span class="symbol">×</span>
          </div>
          <div class="tl-dot tl-min" title="Minimize">
            <span class="symbol">–</span>
          </div>
          <div class="tl-dot tl-max" title="Full screen">
            <span class="symbol">⤢</span>
          </div>
        </div>

        <!-- Sidebar toggle -->
        <div class="chrome-btn" [class.active]="state.sidebarVisible()"
          [title]="(state.sidebarVisible() ? 'Hide' : 'Show') + ' sidebar  ⌥⌘S'"
          (click)="state.toggleSidebar()">
          <maple-icon name="sidebar" [size]="13"
            [color]="state.sidebarVisible() ? 'var(--maple-text-main)' : 'var(--maple-text-muted)'"/>
        </div>

        <!-- Search chrome btn -->
        <div class="chrome-btn">
          <maple-icon name="search" [size]="12" color="var(--maple-text-muted)"/>
        </div>

        <!-- Title -->
        <div class="title">Library — France trip</div>

        <!-- Export -->
        <div class="export-btn"
          [class.has-selection]="state.selectedCount() > 0"
          [class.no-selection]="state.selectedCount() === 0">
          <maple-icon name="export" [size]="11"/>
          <span>Export{{ state.selectedCount() > 1 ? ' (' + state.selectedCount() + ')' : '' }}</span>
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
        <!-- Left: folder tree -->
        <div class="panel-left"
          [style.width]="state.sidebarVisible() ? '220px' : '0px'">
          <app-folder-tree/>
        </div>

        <!-- Center: asset grid + drop-zone import bar -->
        <div class="panel-center">
          <app-drop-zone/>
          <app-asset-grid/>
        </div>

        <!-- Right: detail panel -->
        <div class="panel-right"
          [class.hidden]="!state.inspectorVisible()"
          [style.width]="state.inspectorVisible() ? '280px' : '0px'">
          <app-detail-panel/>
        </div>
      </div>
    </div>
  `,
})
export class BrowseShellComponent {
  state = inject(LibraryStateService);
  private router = inject(Router);

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
    ) return;

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

    // ⌘⌥D / Ctrl+Alt+D — toggle inspector
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
      this.state.toggleInspector();
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
