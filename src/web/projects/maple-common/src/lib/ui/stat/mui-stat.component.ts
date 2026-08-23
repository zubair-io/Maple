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

@Component({
  selector: 'mui-stat',
  standalone: true,
  templateUrl: './mui-stat.component.html',
  styleUrl: './mui-stat.component.scss',
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
}
