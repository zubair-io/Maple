// MuiStat — the Maple UI design-system Stat atom
// (docs/design/maple-ui/components/stat.md). A labeled numeric value with
// an optional delta + trend direction (e.g. "128 Photos", "+12 ▲" this
// week).

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type MuiStatSize = 'sm' | 'lg';
export type MuiStatTrend = 'up' | 'down' | 'flat';

// Plain typographic glyphs, not MuiIcon — the registry has no directional
// up/down arrows (only chevron-right/left/down), and inventing new glyphs
// for a text-scale trend marker is out of scope for this atom.
const TREND_GLYPH: Record<MuiStatTrend, string> = {
  up: '▲',
  down: '▼',
  flat: '–',
};

const TREND_CLASS: Record<MuiStatTrend, string> = {
  up: 'trend-up text-success-text',
  down: 'trend-down text-error-text',
  flat: 'trend-flat text-text-muted',
};

@Component({
  selector: 'mui-stat',
  standalone: true,
  templateUrl: './mui-stat.component.html',
  host: { class: 'inline-block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiStatComponent {
  readonly value = input.required<string | number>();
  readonly label = input.required<string>();
  readonly size = input<MuiStatSize>('lg');
  readonly delta = input<string | number | null>(null);
  readonly trend = input<MuiStatTrend | null>(null);

  readonly trendGlyph = computed(() => {
    const trend = this.trend();
    return trend ? TREND_GLYPH[trend] : '';
  });

  readonly rootClass = computed(() => `mui-stat flex flex-col gap-[2px] size-${this.size()}`);

  readonly valueClass = computed(() =>
    this.size() === 'sm'
      ? 'value text-text-main font-semibold leading-[1.1] text-[16px]'
      : 'value text-text-main font-semibold leading-[1.1] text-[26px]',
  );

  readonly deltaClass = computed(
    () =>
      `delta inline-flex items-center gap-1 text-[12px] font-semibold ${TREND_CLASS[this.trend() ?? 'flat']}`,
  );
}
