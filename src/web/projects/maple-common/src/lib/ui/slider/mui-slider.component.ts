// MuiSlider — Maple UI Molecules-L1 (unified-component-catalog.md §2.1).
// Labeled range slider with a numeric readout, built on a native
// `input[type=range]` (styled with tokens) so keyboard operation (arrow
// keys, Home/End, Page Up/Down) and screen-reader semantics come for free.

import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MuiTextComponent } from '../text/mui-text.component';
import { formatSignedValue, percentInRange } from '../internal/pointer-drag';

@Component({
  selector: 'mui-slider',
  standalone: true,
  imports: [MuiTextComponent],
  templateUrl: './mui-slider.component.html',
  styleUrl: './mui-slider.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSliderComponent {
  readonly label = input.required<string>();
  readonly value = model<number>(0);
  readonly min = input<number>(0);
  readonly max = input<number>(100);
  readonly step = input<number>(1);
  readonly unit = input<string>('');
  readonly disabled = input<boolean>(false);

  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view (`trackPct()`); fallow's member-usage scan doesn't follow external Angular templates.
  readonly trackPct = computed(() => percentInRange(this.value(), this.min(), this.max(), 0));

  readonly valueLabel = computed(() => formatSignedValue(this.value(), this.step(), this.unit()));

  onInput(raw: string): void {
    this.value.set(Number.parseFloat(raw));
  }
}
