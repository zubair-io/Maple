// MuiFrameTimeHud — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.3). Performance readout overlay, built from Text only. Color-codes
// against Maple's own perf invariants (docs: 16ms slider-tick target, 50ms
// hard limit) so the HUD itself flags a budget breach rather than just
// reporting a number.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MuiTextComponent } from '../text/mui-text.component';

export type MuiFrameTimeStatus = 'good' | 'warn' | 'bad';

@Component({
  selector: 'mui-frame-time-hud',
  standalone: true,
  imports: [MuiTextComponent],
  templateUrl: './mui-frame-time-hud.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block' },
})
export class MuiFrameTimeHudComponent {
  readonly frameMs = input.required<number>();
  /** Defaults to `1000 / frameMs`, rounded. */
  readonly fps = input<number | null>(null);
  /** Target frame budget in ms — at/under this is `good`. */
  readonly budgetMs = input<number>(16);
  /** Hard limit in ms — over this is `bad`; between budget and this is `warn`. */
  readonly hardLimitMs = input<number>(50);

  readonly displayFps = computed(() => {
    const explicit = this.fps();
    if (explicit !== null) return explicit;
    const ms = this.frameMs();
    return ms > 0 ? Math.round(1000 / ms) : 0;
  });

  readonly status = computed<MuiFrameTimeStatus>(() => {
    const ms = this.frameMs();
    if (ms > this.hardLimitMs()) return 'bad';
    if (ms > this.budgetMs()) return 'warn';
    return 'good';
  });

  /** Readout text color, keyed off the same mutually-exclusive `status`. */
  readonly readoutColorClass = computed(() => {
    switch (this.status()) {
      case 'bad':
        return 'text-error-text';
      case 'warn':
        return 'text-warn';
      default:
        return 'text-success-text';
    }
  });
}
