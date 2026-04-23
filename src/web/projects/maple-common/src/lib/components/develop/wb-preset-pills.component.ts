// WB Preset pills — horizontal chip row above the temperature slider.

import { Component, input, output } from '@angular/core';
import { WhiteBalancePreset } from '../../models/adjustment-model';

interface WbPreset {
  label: WhiteBalancePreset;
  temp: number | null;
  tint: number | null;
}

const PRESETS: WbPreset[] = [
  { label: 'As Shot',    temp: null, tint: null },
  { label: 'Auto',       temp: null, tint: null },
  { label: 'Daylight',   temp: 5500, tint: 10   },
  { label: 'Cloudy',     temp: 6500, tint: 10   },
  { label: 'Shade',      temp: 7500, tint: 10   },
  { label: 'Tungsten',   temp: 2850, tint: 0    },
  { label: 'Fluorescent',temp: 3800, tint: 21   },
  { label: 'Flash',      temp: 5500, tint: 0    },
  { label: 'Custom',     temp: null, tint: null },
];

export interface WbPresetSelection {
  preset: WhiteBalancePreset;
  temperature: number | null;
  tint: number | null;
}

@Component({
  selector: 'editor-wb-presets',
  standalone: true,
  styles: [`
    :host { display: block; padding: 4px 14px 6px; }

    .pills {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
    }

    .pill {
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--maple-surface-alt);
      border: 0.5px solid var(--maple-border);
      font-family: var(--maple-font);
      font-size: 10px;
      color: var(--maple-text-main);
      cursor: pointer;
      transition: background 100ms;
      white-space: nowrap;
    }
    .pill:hover { background: var(--maple-surface-hover); }
    .pill.active {
      background: var(--maple-primary-dim);
      color: var(--maple-primary);
      border-color: var(--maple-primary);
    }
  `],
  template: `
    <div class="pills">
      @for (p of PRESETS; track p.label) {
        <div
          class="pill"
          [class.active]="active() === p.label"
          (click)="select(p)">
          {{ p.label }}
        </div>
      }
    </div>
  `,
})
export class WbPresetPillsComponent {
  active = input.required<WhiteBalancePreset>();
  selected = output<WbPresetSelection>();

  readonly PRESETS = PRESETS;

  select(p: WbPreset): void {
    this.selected.emit({ preset: p.label, temperature: p.temp, tint: p.tint });
  }
}
