// MuiRatingFlags — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.2). Star rating plus a pick/reject flag, built from Icon + Badge.
// Mirrors the classic Lightroom culling pattern: click a star to set the
// rating (click the current top star again to clear it); the flag cycles
// none → pick → reject → none.

import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiIconComponent } from '../icon/mui-icon.component';

export type MuiRatingFlagState = 'none' | 'pick' | 'reject';

/** `cycle` (default) is one flag icon that steps none → pick → reject → none
 * on each click — the compact form for tight spaces. `pills` renders three
 * explicit Pick / Unflag / Reject buttons so a mouse user can jump straight
 * to any state in one click, matching the classic Lightroom culling row
 * (Maple's Info panel uses this variant — see `InfoPanelComponent`). */
export type MuiRatingFlagsVariant = 'cycle' | 'pills';

const FLAG_CYCLE: Record<MuiRatingFlagState, MuiRatingFlagState> = {
  none: 'pick',
  pick: 'reject',
  reject: 'none',
};

@Component({
  selector: 'mui-rating-flags',
  standalone: true,
  imports: [MuiBadgeComponent, MuiIconComponent],
  templateUrl: './mui-rating-flags.component.html',
  styleUrl: './mui-rating-flags.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiRatingFlagsComponent {
  readonly rating = model<number>(0);
  readonly max = input<number>(5);
  readonly flag = model<MuiRatingFlagState>('none');
  readonly disabled = input<boolean>(false);
  readonly variant = input<MuiRatingFlagsVariant>('cycle');

  readonly stars = computed(() => Array.from({ length: this.max() }, (_, i) => i + 1));

  readonly flagIconColor = computed(() => {
    switch (this.flag()) {
      case 'pick':
        return 'var(--color-success-text)';
      case 'reject':
        return 'var(--color-error-text)';
      default:
        return 'var(--color-text-muted)';
    }
  });

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

  cycleFlag(): void {
    if (this.disabled()) return;
    this.flag.set(FLAG_CYCLE[this.flag()]);
  }

  /** Direct-select entry point for the `pills` variant — sets the flag to
   * exactly the pressed pill's state (no cycling). */
  setFlagState(state: MuiRatingFlagState): void {
    if (this.disabled()) return;
    this.flag.set(state);
  }
}
