// MuiRatingFlagsDisplay — the non-interactive presentation half of
// `MuiRatingFlagsComponent`'s `readonly` mode, split into its own
// sub-component to clear a fallow template-complexity finding on the
// parent (same reason `mui-tree-row-chevron` exists — MW4/#3031 — replayed
// here for the same class of problem: a template mixing multiple
// independent rendering branches). Not part of the public API surface;
// `mui-rating-flags` is the component callers use.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import type { MuiRatingFlagState } from './mui-rating-flags.component';

@Component({
  selector: 'mui-rating-flags-display',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './mui-rating-flags-display.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiRatingFlagsDisplayComponent {
  readonly rating = input<number>(0);
  readonly flag = input<MuiRatingFlagState>('none');
  readonly max = input<number>(5);

  readonly stars = computed(() => Array.from({ length: this.max() }, (_, i) => i + 1));
}
