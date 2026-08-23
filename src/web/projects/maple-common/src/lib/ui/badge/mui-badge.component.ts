// MuiBadge — the Maple UI design-system Badge atom
// (docs/design/maple-ui/components/badge.md). Contract note: the catalog
// row (unified-component-catalog.md §1.1) lists a five-variant
// neutral/accent/success/warning/error scheme, but the contract only
// defines three — count / signal / rating, matching the existing
// person-detection-chip and star-rating usages that motivated the `warn`
// and `star` tokens. The contract wins per the wave-1 brief; flagged as a
// conflict in the wave-1 report. `size` is a harmless addition — the
// contract's Props section is silent on it, and the catalog explicitly
// calls for sm/md.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';

export type MuiBadgeVariant = 'count' | 'signal' | 'rating';
export type MuiBadgeSize = 'sm' | 'md';

@Component({
  selector: 'mui-badge',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-badge.component.html',
  styleUrl: './mui-badge.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiBadgeComponent {
  readonly variant = input<MuiBadgeVariant>('count');
  readonly value = input.required<string | number>();
  readonly size = input<MuiBadgeSize>('md');
  /** Accessible description when `value` alone isn't self-explanatory
   * (e.g. "3 unread" rather than just "3"), per the contract's
   * Accessibility section. */
  readonly label = input<string | null>(null);
}
