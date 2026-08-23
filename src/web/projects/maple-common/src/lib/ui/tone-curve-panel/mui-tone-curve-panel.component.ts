// MuiToneCurvePanel — Maple UI Organisms (unified-component-catalog.md
// §4.3 "Inspectors & panels"). Channel curve plus parametrics — built from
// Tabs, Curve Plot, Living Slider. The per-channel curve points route
// through an explicit `pointsChanged` output (rather than a plain two-way
// binding) because they're keyed by channel id — the caller owns the
// `Record<channelId, points>` map and decides where an edit to the active
// channel's curve lands. The four parametric-region sliders (Highlights /
// Lights / Darks / Shadows) are fully controlled `model()`s since they
// aren't keyed by anything.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiCurvePlotComponent } from '../curve-plot/mui-curve-plot.component';
import type { MuiCurvePoint } from '../curve-plot/mui-curve-plot.component';
import { MuiLivingSliderComponent } from '../living-slider/mui-living-slider.component';
import { MuiTabsComponent } from '../tabs/mui-tabs.component';
import type { MuiTab } from '../tabs/mui-tabs.component';

const DEFAULT_CHANNELS: readonly MuiTab[] = [
  { id: 'rgb', label: 'RGB' },
  { id: 'red', label: 'Red' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
];

const DEFAULT_CURVE_POINTS: readonly MuiCurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0.5 },
  { x: 1, y: 1 },
];

@Component({
  selector: 'mui-tone-curve-panel',
  standalone: true,
  imports: [MuiCurvePlotComponent, MuiLivingSliderComponent, MuiTabsComponent],
  templateUrl: './mui-tone-curve-panel.component.html',
  styleUrl: './mui-tone-curve-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiToneCurvePanelComponent {
  readonly channels = input<readonly MuiTab[]>(DEFAULT_CHANNELS);
  readonly points = input.required<Readonly<Record<string, readonly MuiCurvePoint[]>>>();
  readonly highlights = model<number>(0);
  readonly lights = model<number>(0);
  readonly darks = model<number>(0);
  readonly shadows = model<number>(0);
  readonly activeChannelId = model<string>('rgb');

  readonly pointsChanged = output<{ channelId: string; points: readonly MuiCurvePoint[] }>();

  readonly activePoints = computed(
    () => this.points()[this.activeChannelId()] ?? DEFAULT_CURVE_POINTS,
  );

  onCurveChange(next: readonly MuiCurvePoint[]): void {
    this.pointsChanged.emit({ channelId: this.activeChannelId(), points: next });
  }
}
