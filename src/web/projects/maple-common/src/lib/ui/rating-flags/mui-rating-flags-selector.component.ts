// MuiRatingFlagsSelector — the interactive flag-selection half of
// `MuiRatingFlagsComponent` (its `cycle`/`pills` variants), split into its
// own sub-component to keep the parent template's cyclomatic/cognitive
// complexity down — same reason `mui-tree-row-chevron` (MW4/#3031) and
// `mui-rating-flags-display` (this file's sibling) exist. Not part of the
// public API surface; `mui-rating-flags` is the component callers use.

import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MuiRatingFlagState, MuiRatingFlagsVariant } from './mui-rating-flags.component';

const FLAG_CYCLE: Record<MuiRatingFlagState, MuiRatingFlagState> = {
  none: 'pick',
  pick: 'reject',
  reject: 'none',
};

@Component({
  selector: 'mui-rating-flags-selector',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-rating-flags-selector.component.html',
  styleUrl: './mui-rating-flags-selector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiRatingFlagsSelectorComponent {
  readonly flag = model<MuiRatingFlagState>('none');
  readonly disabled = input<boolean>(false);
  readonly variant = input<MuiRatingFlagsVariant>('cycle');

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
