// MuiRatingFlags — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.2). Star rating plus a pick/reject flag, built from Icon + Badge.
// Mirrors the classic Lightroom culling pattern: click a star to set the
// rating (click the current top star again to clear it); the flag cycles
// none → pick → reject → none.
//
// The flag-selection UI (`cycle`/`pills`) and the non-interactive
// `readonly` display each live in their own sub-component
// (`mui-rating-flags-selector`, `mui-rating-flags-display`) — this
// component owns the star row and delegates the rest, keeping its own
// template's branching low. See those files' header comments.

import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiRatingFlagsDisplayComponent } from './mui-rating-flags-display.component';
import { MuiRatingFlagsSelectorComponent } from './mui-rating-flags-selector.component';

export type MuiRatingFlagState = 'none' | 'pick' | 'reject';

/** `cycle` (default) is one flag icon that steps none → pick → reject → none
 * on each click — the compact form for tight spaces. `pills` renders three
 * explicit Pick / Unflag / Reject buttons so a mouse user can jump straight
 * to any state in one click, matching the classic Lightroom culling row
 * (Maple's Info panel uses this variant — see `InfoPanelComponent`). */
export type MuiRatingFlagsVariant = 'cycle' | 'pills';

@Component({
  selector: 'mui-rating-flags',
  standalone: true,
  imports: [
    MuiBadgeComponent,
    MuiIconComponent,
    MuiRatingFlagsDisplayComponent,
    MuiRatingFlagsSelectorComponent,
  ],
  templateUrl: './mui-rating-flags.component.html',
  host: { class: 'inline-block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiRatingFlagsComponent {
  readonly rating = model<number>(0);
  readonly max = input<number>(5);
  readonly flag = model<MuiRatingFlagState>('none');
  readonly disabled = input<boolean>(false);
  readonly variant = input<MuiRatingFlagsVariant>('cycle');

  readonly rootClasses = computed(() =>
    this.disabled()
      ? 'mui-rating-flags is-disabled flex items-center gap-2 opacity-45 pointer-events-none'
      : 'mui-rating-flags flex items-center gap-2',
  );
  /** Display-only presentation (Lightroom-style grid-cell overlay): plain
   * PICK/REJECT text pills (only when a flag is set) plus a static star
   * row (only when rated) — no buttons, no slider, nothing focusable.
   * Takes over rendering entirely; `variant` is ignored when this is set,
   * since neither `cycle` nor `pills` describes a non-interactive display.
   * `disabled` (which still renders the interactive controls, just inert)
   * is a different concept — this is for a caller that never wants
   * click-to-edit at all, e.g. a grid thumbnail overlay where rating
   * changes happen elsewhere (keyboard shortcuts), not by clicking stars
   * on the tile. */
  readonly readonly = input<boolean>(false);

  readonly stars = computed(() => Array.from({ length: this.max() }, (_, i) => i + 1));

  setRating(star: number): void {
    if (this.disabled()) return;
    this.rating.set(star === this.rating() ? star - 1 : star);
  }

  onKeydown(event: KeyboardEvent): void {
    if (this.disabled()) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.rating.set(Math.min(this.max(), this.rating() + 1));
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.rating.set(Math.max(0, this.rating() - 1));
    }
  }
}
