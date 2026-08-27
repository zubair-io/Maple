// MuiHslPanel — Maple UI Organisms (unified-component-catalog.md §4.3).
// Per-band hue / sat / luminance, built from Chip Row, Living Slider. Chip
// Row runs in `select` mode so exactly one band is active at a time; the
// panel then renders the three Living Sliders for whichever band is
// active, wired to a flat `values` map keyed by band id (mirroring
// Adjustments Panel's flat `sliderId`-keyed map).
//
// Chip Row's `selectedId` model is nullable (`string | null`) because a
// generic select-mode chip row can start with nothing chosen, but this
// panel's `activeBandId` is always a real band (defaults to `'red'`) — so
// the chip row is driven one-way plus an explicit change handler rather
// than `[(selectedId)]`, which would require `activeBandId` itself to
// accept `null`.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiLivingSliderComponent } from '../living-slider/mui-living-slider.component';

export interface MuiHslBandValue {
  readonly hue: number;
  readonly saturation: number;
  readonly luminance: number;
}

const DEFAULT_BANDS: readonly MuiChip[] = [
  { id: 'red', label: 'Red' },
  { id: 'orange', label: 'Orange' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'aqua', label: 'Aqua' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'magenta', label: 'Magenta' },
];

const ZERO_BAND: MuiHslBandValue = { hue: 0, saturation: 0, luminance: 0 };

export type MuiHslField = 'hue' | 'saturation' | 'luminance';

@Component({
  selector: 'mui-hsl-panel',
  standalone: true,
  imports: [MuiChipRowComponent, MuiLivingSliderComponent],
  templateUrl: './mui-hsl-panel.component.html',
  styleUrl: './mui-hsl-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiHslPanelComponent {
  readonly bands = input<readonly MuiChip[]>(DEFAULT_BANDS);
  readonly values = input.required<Readonly<Record<string, MuiHslBandValue>>>();

  readonly activeBandId = model<string>('red');

  readonly valueChanged = output<{ bandId: string; field: MuiHslField; value: number }>();

  readonly activeValue = computed(() => this.values()[this.activeBandId()] ?? ZERO_BAND);

  selectBand(id: string | null): void {
    if (id !== null) this.activeBandId.set(id);
  }

  emitChange(field: MuiHslField, value: number): void {
    this.valueChanged.emit({ bandId: this.activeBandId(), field, value });
  }

  /** Every HSL field's default is 0, unlike most Living Slider hosts — a
   *  double-click reset can resolve locally instead of round-tripping
   *  through the consumer. */
  resetField(field: MuiHslField): void {
    this.emitChange(field, 0);
  }
}
