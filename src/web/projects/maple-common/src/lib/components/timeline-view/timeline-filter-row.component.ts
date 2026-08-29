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
import { COLOR_LABEL_OPTIONS } from '../../models/color-label';

const COLOR_OPTIONS: ReadonlyArray<{ value: TimelineColor; label: string; swatch: string }> = [
  { value: '', label: 'Any color', swatch: 'transparent' },
  ...COLOR_LABEL_OPTIONS,
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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineFilterRowComponent {
  readonly state = inject(TimelineStateService);

  readonly STAR_INDICES = [1, 2, 3, 4, 5];
  readonly COLOR_OPTIONS = COLOR_OPTIONS;
  readonly FLAG_OPTIONS = FLAG_OPTIONS;
  readonly HIDDEN_OPTIONS = HIDDEN_OPTIONS;

  /** Mutually-exclusive color/border/background triplet for a filter
   * pill's active state (Tailwind port #3071) — folded into one computed
   * string rather than a base class plus a conditional add-on. */
  protected filterPillClass(active: boolean): string {
    const base =
      'filter-pill h-6 cursor-pointer rounded border-[0.5px] px-2 text-[11px] transition-colors duration-[120ms]';
    return active
      ? `${base} is-active bg-white/4 border-border text-text-main`
      : `${base} border-transparent bg-transparent text-text-muted hover:border-border hover:bg-surface-hover hover:text-text-main`;
  }

  /** Same as {@link filterPillClass} for the star-rating pill (no text). */
  protected ratingPillClass(active: boolean): string {
    const base =
      'filter-pill flex h-6 w-6 items-center justify-center rounded border-[0.5px] transition-colors duration-[120ms]';
    return active
      ? `${base} is-active bg-white/4 border-border text-text-main`
      : `${base} border-transparent bg-transparent hover:border-border hover:bg-surface-hover`;
  }

  /** Mutually-exclusive border/shadow pair for a color swatch's active
   * state. */
  protected colorSwatchClass(active: boolean): string {
    const base =
      'color-swatch flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border-[0.5px] transition-[transform,border-color] duration-[120ms] hover:scale-110';
    return active
      ? `${base} is-active border-primary shadow-[0_0_0_1.5px_var(--color-primary)]`
      : `${base} border-border`;
  }

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
