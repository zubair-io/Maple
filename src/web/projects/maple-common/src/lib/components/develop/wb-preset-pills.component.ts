// WB Preset pills — horizontal chip row above the temperature slider.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { WhiteBalancePreset } from '../../models/adjustment-model';

interface WbPreset {
  label: WhiteBalancePreset;
  temp: number | null;
  tint: number | null;
}

const PRESETS: WbPreset[] = [
  { label: 'As Shot', temp: null, tint: null },
  { label: 'Auto', temp: null, tint: null },
  { label: 'Daylight', temp: 5500, tint: 10 },
  { label: 'Cloudy', temp: 6500, tint: 10 },
  { label: 'Shade', temp: 7500, tint: 10 },
  { label: 'Tungsten', temp: 2850, tint: 0 },
  { label: 'Fluorescent', temp: 3800, tint: 21 },
  { label: 'Flash', temp: 5500, tint: 0 },
  { label: 'Custom', temp: null, tint: null },
];

export interface WbPresetSelection {
  preset: WhiteBalancePreset;
  temperature: number | null;
  tint: number | null;
}

@Component({
  selector: 'editor-wb-presets',
  standalone: true,
  styleUrl: './wb-preset-pills.component.scss',
  templateUrl: './wb-preset-pills.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WbPresetPillsComponent {
  active = input.required<WhiteBalancePreset>();
  selected = output<WbPresetSelection>();

  readonly PRESETS = PRESETS;

  select(p: WbPreset): void {
    this.selected.emit({ preset: p.label, temperature: p.temp, tint: p.tint });
  }
}
