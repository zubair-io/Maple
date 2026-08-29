// MuiColorGradingPanel — Maple UI Organisms (unified-component-catalog.md
// §4.3). Shadows / mids / highlights, built from Color Wheel, Living
// Slider. Fully controlled: every value is a two-way `model()`, so the
// panel carries no state beyond what the caller hands it. A color-grading
// tool at rest (every wheel centered, blending at 50, balance at 0) is a
// normal starting point, not an "empty" condition worth a separate state.

import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { MuiColorWheelComponent } from '../color-wheel/mui-color-wheel.component';
import type { MuiColorWheelValue } from '../color-wheel/mui-color-wheel.component';
import { MuiLivingSliderComponent } from '../living-slider/mui-living-slider.component';
import { MuiTextComponent } from '../text/mui-text.component';

const ZERO_WHEEL: MuiColorWheelValue = { hue: 0, saturation: 0 };

@Component({
  selector: 'mui-color-grading-panel',
  standalone: true,
  imports: [MuiColorWheelComponent, MuiLivingSliderComponent, MuiTextComponent],
  templateUrl: './mui-color-grading-panel.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiColorGradingPanelComponent {
  readonly shadows = model<MuiColorWheelValue>(ZERO_WHEEL);
  readonly shadowsLuminance = model<number>(0);

  readonly midtones = model<MuiColorWheelValue>(ZERO_WHEEL);
  readonly midtonesLuminance = model<number>(0);

  readonly highlights = model<MuiColorWheelValue>(ZERO_WHEEL);
  readonly highlightsLuminance = model<number>(0);

  readonly blending = model<number>(50);
  readonly balance = model<number>(0);
}
