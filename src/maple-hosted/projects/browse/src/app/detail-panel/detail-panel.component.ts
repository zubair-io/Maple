// Right panel — TabBar + Info tab.
// Ported from _design-reference/lib/detail.jsx (TabBar / InfoTab).
// Develop tab is P3 scope; shell is wired here but renders a placeholder.

import { Component, inject } from '@angular/core';
import { BrowseStateService } from '../state/browse-state.service';
import { MapleIconComponent } from '@maple-common';
import { InfoTabComponent } from './info-tab.component';

@Component({
  selector: 'app-detail-panel',
  standalone: true,
  imports: [MapleIconComponent, InfoTabComponent],
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 280px;
      min-width: 280px;
      background: var(--maple-surface);
      overflow: hidden;
    }

    .content {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Tab bar at bottom (matches reference: borderTop, surfaceAlt bg) */
    .tab-bar {
      display: flex;
      height: 40px;
      flex-shrink: 0;
      border-top: 0.5px solid var(--maple-border);
      background: var(--maple-surface-alt);
    }

    .tab {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      cursor: pointer;
      font-family: var(--maple-font);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      color: var(--maple-text-muted);
      border-top: 2px solid transparent;
      background: transparent;
      transition: background 120ms;
    }
    .tab.active {
      color: var(--maple-primary);
      background: var(--maple-surface);
      border-top-color: var(--maple-primary);
    }
    .tab:not(.active):hover { background: var(--maple-bg-hover); }

    /* Develop tab placeholder */
    .develop-placeholder {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: var(--maple-text-muted);
      font-family: var(--maple-font);
      font-size: 11px;
      text-align: center;
    }
  `],
  template: `
    <div class="content">
      @if (state.activeTab() === 'info') {
        <app-info-tab/>
      } @else {
        <div class="develop-placeholder">
          Develop tab — coming in P3
        </div>
      }
    </div>

    <!-- Tab bar -->
    <div class="tab-bar">
      <div class="tab" [class.active]="state.activeTab() === 'info'"
        (click)="state.activeTab.set('info')">
        <maple-icon name="info" [size]="12"
          [color]="state.activeTab() === 'info' ? 'var(--maple-primary)' : 'var(--maple-text-muted)'"/>
        <span>Info</span>
      </div>
      <div class="tab" [class.active]="state.activeTab() === 'develop'"
        (click)="state.activeTab.set('develop')">
        <maple-icon name="droplet" [size]="12"
          [color]="state.activeTab() === 'develop' ? 'var(--maple-primary)' : 'var(--maple-text-muted)'"/>
        <span>Develop</span>
      </div>
    </div>
  `,
})
export class DetailPanelComponent {
  state = inject(BrowseStateService);
}
