// TimelineFilterRow — horizontal row above the timeline scroller.
//
// Owns the rating / flag / color / date-range UI. Binds directly to
// TimelineStateService signals — no inputs/outputs, since filter state
// is global to the timeline view and any consumer that wants to react
// to a filter change should listen to the service signals.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  TimelineStateService,
  TimelineColor,
  TimelineFlag,
} from '../../state/timeline-state.service';
import { MapleIconComponent } from '../../icons/maple-icon.component';

const COLOR_OPTIONS: ReadonlyArray<{ value: TimelineColor; label: string; swatch: string }> = [
  { value: '', label: 'Any color', swatch: 'transparent' },
  { value: 'red', label: 'Red', swatch: '#e11d48' },
  { value: 'orange', label: 'Orange', swatch: '#f97316' },
  { value: 'yellow', label: 'Yellow', swatch: '#eab308' },
  { value: 'green', label: 'Green', swatch: '#22c55e' },
  { value: 'blue', label: 'Blue', swatch: '#3b82f6' },
  { value: 'purple', label: 'Purple', swatch: '#a855f7' },
];

const FLAG_OPTIONS: ReadonlyArray<{ value: TimelineFlag; label: string }> = [
  { value: '', label: 'All' },
  { value: 'pick', label: 'Pick' },
  { value: 'reject', label: 'Reject' },
];

const HIDDEN_OPTIONS: ReadonlyArray<{ value: 'none' | 'all' | 'only'; label: string }> = [
  { value: 'none', label: 'Show Normal' },
  { value: 'all', label: 'Show All' },
  { value: 'only', label: 'Show Only Hidden' },
];

@Component({
  selector: 'app-timeline-filter-row',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './timeline-filter-row.component.html',
  styleUrl: './timeline-filter-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineFilterRowComponent {
  readonly state = inject(TimelineStateService);

  readonly STAR_INDICES = [1, 2, 3, 4, 5];
  readonly COLOR_OPTIONS = COLOR_OPTIONS;
  readonly FLAG_OPTIONS = FLAG_OPTIONS;
  readonly HIDDEN_OPTIONS = HIDDEN_OPTIONS;

  onRatingClick(n: number): void {
    const cur = this.state.minRating();
    this.state.setMinRating(cur === n ? 0 : n);
  }

  onFlagClick(v: TimelineFlag): void {
    this.state.setFlag(v);
  }

  onColorClick(v: TimelineColor): void {
    this.state.setColor(v);
  }

  onHiddenClick(v: 'none' | 'all' | 'only'): void {
    this.state.setHiddenFilter(v);
  }

  onFromInput(e: Event): void {
    this.state.setFrom((e.target as HTMLInputElement).value);
  }

  onToInput(e: Event): void {
    this.state.setTo((e.target as HTMLInputElement).value);
  }

  onClear(): void {
    this.state.clearAll();
  }
}
