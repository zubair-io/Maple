// ScopesContainer — four scopes pinned to the top of the Develop tab.
// Updated via effect() when the focused asset's adjustment model changes.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
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
  styles: [
    `
      :host {
        border-bottom: 0.5px solid var(--color-border);
      }
    `,
  ],
  host: { class: 'block bg-bg p-2' },
  template: `
    <div class="flex items-end gap-1">
      <div class="flex-1 min-w-0 rounded-[3px] overflow-hidden bg-black/30">
        <div class="text-[9px] uppercase tracking-[0.08em] text-text-muted px-1 pt-[3px] pb-px">Histogram</div>
        <editor-histogram [adjustment]="adj()" />
      </div>
      <div class="flex-1 min-w-0 rounded-[3px] overflow-hidden bg-black/30">
        <div class="text-[9px] uppercase tracking-[0.08em] text-text-muted px-1 pt-[3px] pb-px">Waveform</div>
        <editor-waveform [adjustment]="adj()" />
      </div>
      <div class="flex-1 min-w-0 rounded-[3px] overflow-hidden bg-black/30">
        <div class="text-[9px] uppercase tracking-[0.08em] text-text-muted px-1 pt-[3px] pb-px">Parade</div>
        <editor-parade [adjustment]="adj()" />
      </div>
      <div class="basis-20 grow-0 shrink-0 w-20 rounded-[3px] overflow-hidden bg-black/30">
        <div class="text-[9px] uppercase tracking-[0.08em] text-text-muted px-1 pt-[3px] pb-px">Vector</div>
        <editor-vectorscope [adjustment]="adj()" />
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScopesContainerComponent {
  private state = inject(LibraryStateService);

  adj = computed<AdjustmentModel>(() => {
    const fid = this.state.focusedAssetId();
    if (!fid) return defaultAdjustmentModel();
    return this.state.adjustmentFor(fid)();
  });
}
