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
  styleUrl: './scopes-container.component.scss',
  host: { class: 'block bg-bg p-2' },
  templateUrl: './scopes-container.component.html',
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
