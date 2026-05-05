// Editor detail panel — Info + Develop tabs.
// Info tab reused from maple-common; Develop tab owns sliders + scopes.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { InfoTabComponent } from '../../detail-panel/info-tab.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { DevelopTabComponent } from './develop-tab.component';

@Component({
  selector: 'editor-detail-panel',
  standalone: true,
  imports: [MapleIconComponent, InfoTabComponent, DevelopTabComponent],
  styles: [
    `
      /* Tab bar uses 0.5px top border which Tailwind can't express. */
      .tab-bar {
        border-top: 0.5px solid var(--color-border);
      }
    `,
  ],
  host: {
    class:
      'flex flex-col h-full w-[280px] min-w-[280px] bg-surface overflow-hidden',
  },
  template: `
    <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
      @if (state.activeTab() === 'info') {
        <maple-info-tab />
      } @else {
        <editor-develop-tab />
      }
    </div>

    <div class="tab-bar flex h-10 shrink-0 bg-surface-alt">
      <div
        class="flex-1 flex items-center justify-center gap-1 cursor-pointer text-[10px] font-medium uppercase tracking-[0.3px] border-t-2 border-transparent bg-transparent transition-[background] duration-[120ms]"
        [class.text-primary]="state.activeTab() === 'info'"
        [class.text-text-muted]="state.activeTab() !== 'info'"
        [class.bg-surface]="state.activeTab() === 'info'"
        [class.border-t-primary]="state.activeTab() === 'info'"
        [class.hover:bg-bg-hover]="state.activeTab() !== 'info'"
        (click)="state.activeTab.set('info')"
      >
        <maple-icon
          name="info"
          [size]="12"
          [color]="
            state.activeTab() === 'info' ? 'var(--color-primary)' : 'var(--color-text-muted)'
          "
        />
        <span>Info</span>
      </div>
      <div
        class="flex-1 flex items-center justify-center gap-1 cursor-pointer text-[10px] font-medium uppercase tracking-[0.3px] border-t-2 border-transparent bg-transparent transition-[background] duration-[120ms]"
        [class.text-primary]="state.activeTab() === 'develop'"
        [class.text-text-muted]="state.activeTab() !== 'develop'"
        [class.bg-surface]="state.activeTab() === 'develop'"
        [class.border-t-primary]="state.activeTab() === 'develop'"
        [class.hover:bg-bg-hover]="state.activeTab() !== 'develop'"
        (click)="state.activeTab.set('develop')"
      >
        <maple-icon
          name="droplet"
          [size]="12"
          [color]="
            state.activeTab() === 'develop' ? 'var(--color-primary)' : 'var(--color-text-muted)'
          "
        />
        <span>Develop</span>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorDetailPanelComponent {
  state = inject(LibraryStateService);
}
