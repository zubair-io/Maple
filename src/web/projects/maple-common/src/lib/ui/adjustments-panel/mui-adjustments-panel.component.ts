// MuiAdjustmentsPanel — Maple UI Organisms (unified-component-catalog.md
// §4.3). All tool-group sliders, built from Living Slider, Collapsible,
// Tabs. Slider values live in one flat `values` map keyed by slider id
// (not nested per tab/group) — the caller's contract is that slider ids
// stay globally unique across every tab so a single map can address them
// all. Collapsible-group open/closed state is owned locally and seeded
// once from each group's `collapsedByDefault`, then left to the user's own
// toggling from there.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { MuiCollapsibleComponent } from '../collapsible/mui-collapsible.component';
import { MuiLivingSliderComponent } from '../living-slider/mui-living-slider.component';
import { MuiTabsComponent } from '../tabs/mui-tabs.component';
import type { MuiTab } from '../tabs/mui-tabs.component';
import { toggleId } from '../internal/id-list';

export interface MuiAdjustmentSlider {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
  readonly bipolar?: boolean;
  readonly gradient?: string;
}

export interface MuiAdjustmentGroup {
  readonly id: string;
  readonly label: string;
  readonly sliders: readonly MuiAdjustmentSlider[];
  readonly collapsedByDefault?: boolean;
}

export interface MuiAdjustmentTab {
  readonly id: string;
  readonly label: string;
  readonly groups: readonly MuiAdjustmentGroup[];
}

// Mirrors mui-living-slider's own default gradient — used when a slider spec
// doesn't carry its own, so a slider with no `gradient` looks identical to
// one instantiated with Living Slider's own default.
const DEFAULT_SLIDER_GRADIENT =
  'linear-gradient(90deg, var(--color-border) 0%, var(--color-primary) 100%)';

@Component({
  selector: 'mui-adjustments-panel',
  standalone: true,
  imports: [MuiCollapsibleComponent, MuiLivingSliderComponent, MuiTabsComponent],
  templateUrl: './mui-adjustments-panel.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiAdjustmentsPanelComponent {
  readonly tabs = input.required<readonly MuiAdjustmentTab[]>();
  readonly values = input.required<Readonly<Record<string, number>>>();

  readonly activeTabId = model<string>('');

  readonly valueChanged = output<{ sliderId: string; value: number }>();
  /** Fired when a slider's double-click asks to be restored to its default —
   *  `mui-living-slider` only emits the request (#2411: not every tool's
   *  default is zero), so the host — the one place that actually knows each
   *  slider's default — decides what value that reset means. */
  readonly sliderReset = output<string>();

  readonly openGroupIds = signal<readonly string[]>([]);

  readonly tabDefs = computed<readonly MuiTab[]>(() =>
    this.tabs().map((tab) => ({ id: tab.id, label: tab.label })),
  );

  readonly activeGroups = computed<readonly MuiAdjustmentGroup[]>(
    () => this.tabs().find((tab) => tab.id === this.activeTabId())?.groups ?? [],
  );

  constructor() {
    effect(() => {
      const tabs = this.tabs();
      if (untracked(() => this.openGroupIds().length) === 0 && tabs.length > 0) {
        this.openGroupIds.set(
          tabs
            .flatMap((tab) => tab.groups)
            .filter((group) => !group.collapsedByDefault)
            .map((group) => group.id),
        );
      }
    });
  }

  toggleGroup(id: string, isOpen: boolean): void {
    this.openGroupIds.update((ids) => toggleId(ids, id, isOpen));
  }

  sliderGradient(slider: MuiAdjustmentSlider): string {
    return slider.gradient ?? DEFAULT_SLIDER_GRADIENT;
  }
}
