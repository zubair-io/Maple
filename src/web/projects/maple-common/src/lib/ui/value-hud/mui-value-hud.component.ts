// MuiValueHud — Maple UI Molecules-L1 (unified-component-catalog.md §2.3).
// Center-screen scrub overlay, built from Text + Progress. Purely
// presentational — showing/hiding and positioning it over the canvas during
// a gesture is the caller's concern.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-value-hud',
  standalone: true,
  imports: [MuiProgressComponent, MuiTextComponent],
  templateUrl: './mui-value-hud.component.html',
  host: { class: 'inline-block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiValueHudComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  /** `0-100`, or `null` to hide the progress track (e.g. an unbounded tool). */
  readonly progressPct = input<number | null>(null);
}
