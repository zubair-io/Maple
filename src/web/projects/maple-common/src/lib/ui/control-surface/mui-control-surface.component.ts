// MuiControlSurface — Maple UI Organisms, Wave W6 Lane B "Editing surfaces"
// (docs/unified-component-catalog.md §4.5). Panel for the armed tool: a tab
// strip switching between tool groups (Exposure / Color / Crop, ...) plus
// the living-slider stack for whichever tool is active, built from Tabs and
// Living Slider.
//
// `sliders` is a plain one-way input, not a model or a full-catalog list:
// it already represents "the sliders visible for the currently active tab".
// The host (a showcase demo, or any real caller) owns the source of truth —
// it is responsible for swapping which slice of its own model it passes in
// when `activeTab` changes, and for re-rendering the array with the updated
// value after receiving `sliderChanged`. This is the same one-way-down /
// events-up flow used by every other organism in this catalog, and it keeps
// this component from needing a tab->slider-id mapping input just to serve
// as a reference shell.
//
// The catalog also suggests Chip Row as a building block. There's no
// genuine role for a chip *row* here — only one tab strip is ever shown,
// and each slider already renders its own inline value readout via Living
// Slider — so it's skipped. A single `mui-value-chip` earns its place once,
// as a summary readout of how many adjustments are visible for the active
// tool.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiLivingSliderComponent } from '../living-slider/mui-living-slider.component';
import { MuiTabsComponent } from '../tabs/mui-tabs.component';
import type { MuiTab } from '../tabs/mui-tabs.component';
import { MuiValueChipComponent } from '../value-chip/mui-value-chip.component';

export interface MuiControlSurfaceSlider {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
}

@Component({
  selector: 'mui-control-surface',
  standalone: true,
  imports: [
    MuiEmptyStateComponent,
    MuiLivingSliderComponent,
    MuiTabsComponent,
    MuiValueChipComponent,
  ],
  templateUrl: './mui-control-surface.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiControlSurfaceComponent {
  readonly tabs = input.required<readonly MuiTab[]>();
  readonly activeTab = model<string>('');
  /** Sliders for the currently active tab only — see file header. */
  readonly sliders = input.required<readonly MuiControlSurfaceSlider[]>();

  readonly tabChanged = output<string>();
  readonly sliderChanged = output<{ id: string; value: number }>();
  /** Fired when a slider's double-click asks to be restored to its default —
   *  `mui-living-slider` only emits the request (#2411: not every tool's
   *  default is zero), so the host — the one place that actually knows each
   *  slider's default — decides what value that reset means. */
  readonly sliderReset = output<string>();

  readonly sliderCount = computed<number>(() => this.sliders().length);

  onSliderChange(id: string, value: number): void {
    this.sliderChanged.emit({ id, value });
  }

  onSliderReset(id: string): void {
    this.sliderReset.emit(id);
  }

  bipolar(slider: MuiControlSurfaceSlider): boolean {
    return slider.min < 0 && slider.max > 0;
  }
}
