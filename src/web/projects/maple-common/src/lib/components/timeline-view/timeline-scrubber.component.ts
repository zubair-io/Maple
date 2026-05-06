// TimelineScrubber — vertical right-rail strip showing month buckets,
// each cell sized proportionally to its photo count.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { TimelineBucket } from '../../api/search.service';

interface ScrubberCell {
  year: number;
  month: number;
  count: number;
  size: number;
  newYearStart: boolean;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

@Component({
  selector: 'app-timeline-scrubber',
  standalone: true,
  imports: [],
  templateUrl: './timeline-scrubber.component.html',
  styleUrl: './timeline-scrubber.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineScrubberComponent {
  buckets = input<TimelineBucket[]>([]);

  jumpTo = output<{ year: number; month: number }>();

  /** Computed cells with proportional heights, clamped 8–80 px. */
  readonly cells = computed<ScrubberCell[]>(() => {
    const list = this.buckets();
    if (list.length === 0) return [];
    const counts = list.map((b) => b.count);
    const max = Math.max(...counts, 1);
    const min = Math.min(...counts);
    const range = Math.max(max - min, 1);
    let lastYear: number | null = null;
    return list.map((b) => {
      const norm = (b.count - min) / range;
      const size = 8 + norm * (80 - 8);
      const newYearStart = lastYear !== null && lastYear !== b.year;
      lastYear = b.year;
      return {
        year: b.year,
        month: b.month,
        count: b.count,
        size,
        newYearStart,
      };
    });
  });

  monthLabel(m: number): string {
    return MONTH_NAMES[m - 1] ?? String(m);
  }

  onClick(c: ScrubberCell): void {
    this.jumpTo.emit({ year: c.year, month: c.month });
  }

  trackCell = (_: number, c: ScrubberCell): string => `${c.year}-${c.month}`;
}
