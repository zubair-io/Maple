// MuiScopesPanel — the Maple UI design-system Scopes Panel organism
// (unified-component-catalog.md §4.3; Built from: Histogram, Waveform,
// Parade, Vectorscope). A pinned four-up stack of the live-frame scope
// plots, always rendered in that fixed order. There's no loading/empty
// state of its own — a caller with no live frame simply doesn't mount this
// panel; once mounted with a sample (even an all-zero one, a flat
// histogram) it's always in its one populated state.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiHistogramComponent } from '../histogram/mui-histogram.component';
import { MuiParadeComponent } from '../parade/mui-parade.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiVectorscopeComponent } from '../vectorscope/mui-vectorscope.component';
import type { MuiVectorscopeSample } from '../vectorscope/mui-vectorscope.component';
import { MuiWaveformComponent } from '../waveform/mui-waveform.component';

export interface MuiScopeSample {
  readonly histogram: {
    readonly r: readonly number[];
    readonly g: readonly number[];
    readonly b: readonly number[];
  };
  readonly waveformLuma: readonly number[];
  readonly parade: {
    readonly r: readonly number[];
    readonly g: readonly number[];
    readonly b: readonly number[];
  };
  readonly vectorscope: readonly MuiVectorscopeSample[];
}

@Component({
  selector: 'mui-scopes-panel',
  standalone: true,
  imports: [
    MuiHistogramComponent,
    MuiParadeComponent,
    MuiTextComponent,
    MuiVectorscopeComponent,
    MuiWaveformComponent,
  ],
  templateUrl: './mui-scopes-panel.component.html',
  styleUrl: './mui-scopes-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiScopesPanelComponent {
  readonly sample = input.required<MuiScopeSample>();
  readonly width = input<number>(200);
  readonly height = input<number>(56);
}
