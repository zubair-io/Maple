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
  host: { class: 'block' },
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

  readonly rootClasses = computed(
    () => `mui-progress flex items-center gap-2 shape-${this.shape()} size-${this.size()}`,
  );

  readonly trackClasses = computed(
    () =>
      `bar-track flex-1 overflow-hidden rounded-full bg-surface ${this.size() === 'sm' ? 'h-1' : 'h-2'}`,
  );

  readonly fillClasses = computed(() =>
    this.isIndeterminate()
      ? 'bar-fill indeterminate h-full w-[40%] rounded-full bg-primary [animation:mui-progress-slide_1.2s_ease-in-out_infinite]'
      : 'bar-fill h-full rounded-full bg-primary transition-[width_200ms_ease]',
  );

  readonly ringClasses = computed(() => {
    const size = this.size() === 'sm' ? 'h-6 w-6' : 'h-9 w-9';
    const spin = this.isIndeterminate()
      ? ' indeterminate [animation:mui-progress-spin_1s_linear_infinite]'
      : '';
    return `ring -rotate-90 ${size}${spin}`;
  });
}
