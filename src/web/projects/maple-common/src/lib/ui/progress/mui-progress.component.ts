// MuiProgress — the Maple UI design-system Progress atom
// (unified-component-catalog.md §1.5; contract:
// docs/design/maple-ui/components/progress.md). Determinate (0–100) or
// indeterminate, as a bar or a ring.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type MuiProgressShape = 'bar' | 'ring';
export type MuiProgressSize = 'sm' | 'md';

const RING_RADIUS = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

@Component({
  selector: 'mui-progress',
  standalone: true,
  templateUrl: './mui-progress.component.html',
  styleUrl: './mui-progress.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiProgressComponent {
  readonly shape = input<MuiProgressShape>('bar');
  readonly size = input<MuiProgressSize>('md');
  /** 0–100, or `null` for indeterminate. */
  readonly value = input<number | null>(null);
  readonly label = input<string | null>(null);

  readonly ringRadius = RING_RADIUS;
  readonly ringCircumference = RING_CIRCUMFERENCE;

  readonly clampedValue = computed(() => {
    const value = this.value();
    return value === null ? null : Math.min(100, Math.max(0, value));
  });

  readonly isIndeterminate = computed(() => this.clampedValue() === null);

  readonly ringOffset = computed(() => {
    const value = this.clampedValue();
    if (value === null) return 0;
    return RING_CIRCUMFERENCE * (1 - value / 100);
  });
}
