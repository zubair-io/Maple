// ScopesContainer — four scopes pinned to the top of the Develop tab.
// Updated via effect() when the focused asset's adjustment model changes.

import { Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { HistogramComponent } from './histogram.component';
import { WaveformComponent } from './waveform.component';
import { ParadeComponent } from './parade.component';
import { VectorscopeComponent } from './vectorscope.component';
import { defaultAdjustmentModel, AdjustmentModel } from '../../models/adjustment-model';

@Component({
  selector: 'editor-scopes-container',
  standalone: true,
  imports: [HistogramComponent, WaveformComponent, ParadeComponent, VectorscopeComponent],
  styles: [`
    :host {
      display: block;
      background: var(--maple-bg);
      border-bottom: 0.5px solid var(--maple-border);
      padding: 8px;
    }

    .scopes-row {
      display: flex;
      gap: 4px;
      align-items: flex-end;
    }

    .scope-block {
      flex: 1;
      min-width: 0;
      border-radius: 3px;
      overflow: hidden;
      background: rgba(0,0,0,0.3);
    }

    .scope-label {
      font-family: var(--maple-font);
      font-size: 9px;
      color: var(--maple-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 3px 4px 1px;
    }

    .vectorscope-block {
      flex: 0 0 80px;
      width: 80px;
      border-radius: 3px;
      overflow: hidden;
      background: rgba(0,0,0,0.3);
    }
  `],
  template: `
    <div class="scopes-row">
      <div class="scope-block">
        <div class="scope-label">Histogram</div>
        <editor-histogram [adjustment]="adj()"/>
      </div>
      <div class="scope-block">
        <div class="scope-label">Waveform</div>
        <editor-waveform [adjustment]="adj()"/>
      </div>
      <div class="scope-block">
        <div class="scope-label">Parade</div>
        <editor-parade [adjustment]="adj()"/>
      </div>
      <div class="vectorscope-block">
        <div class="scope-label">Vector</div>
        <editor-vectorscope [adjustment]="adj()"/>
      </div>
    </div>
  `,
})
export class ScopesContainerComponent {
  private state = inject(LibraryStateService);

  adj = computed<AdjustmentModel>(() => {
    const fid = this.state.focusedAssetId();
    if (!fid) return defaultAdjustmentModel();
    return this.state.adjustmentFor(fid)();
  });
}
