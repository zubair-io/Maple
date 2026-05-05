// Develop tab — scopes pinned at top, then all 5 slider sections.

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ScopesContainerComponent } from '../scopes/scopes-container.component';
import { ToneSectionComponent } from '../develop/tone-section.component';
import { WhiteBalanceSectionComponent } from '../develop/white-balance-section.component';
import { PresenceSectionComponent } from '../develop/presence-section.component';
import { SharpeningSectionComponent } from '../develop/sharpening-section.component';
import { NoiseSectionComponent } from '../develop/noise-section.component';

@Component({
  selector: 'editor-develop-tab',
  standalone: true,
  imports: [
    ScopesContainerComponent,
    ToneSectionComponent,
    WhiteBalanceSectionComponent,
    PresenceSectionComponent,
    SharpeningSectionComponent,
    NoiseSectionComponent,
  ],
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
      }
      :host::-webkit-scrollbar {
        width: 6px;
      }
      :host::-webkit-scrollbar-track {
        background: transparent;
      }
      :host::-webkit-scrollbar-thumb {
        background: var(--color-border);
        border-radius: 3px;
      }

      .scopes-sticky {
        position: sticky;
        top: 0;
        z-index: 2;
      }

      .sliders-body {
        flex: 1;
      }
    `,
  ],
  template: `
    <div class="scopes-sticky">
      <editor-scopes-container />
    </div>
    <div class="sliders-body">
      <editor-tone-section />
      <editor-white-balance-section />
      <editor-presence-section />
      <editor-sharpening-section />
      <editor-noise-section />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DevelopTabComponent {}
