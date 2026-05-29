// RatingFlagsRowComponent — S6 Info content section 1 (web).
//
// 3 flag pill-circles (Pick / Unflagged / Reject) + 5-star tap row.
// Mutations go through LibraryStateService.setFlag / setRating which
// already handles the asset-row write + SidecarStore debounced flush
// (parity with the keyboard handlers in EditorShell — keys 1-5/P/X/U
// hit the same service methods).

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import type { Asset, Flag } from '../models/asset';

@Component({
  selector: 'app-rating-flags-row',
  standalone: true,
  templateUrl: './rating-flags-row.component.html',
  styleUrl: './rating-flags-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-rating-flags',
  },
})
export class RatingFlagsRowComponent {
  private readonly state = inject(LibraryStateService);

  readonly asset = input<Asset | null>(null);

  /** Star indices for the template's @for. */
  protected readonly STARS = [1, 2, 3, 4, 5];

  protected readonly currentFlag = computed<Flag>(() => this.asset()?.flag ?? 'unflagged');

  protected readonly currentStars = computed<number>(() => this.asset()?.rating ?? 0);

  protected readonly disabled = computed<boolean>(() => this.asset() === null);

  protected setFlag(flag: Flag): void {
    const a = this.asset();
    if (!a || a.flag === flag) return;
    this.state.setFlag(a.id, flag);
  }

  /** Lightroom-style toggle: tap same star → clear; tap a different star
   * → set. Matches the existing `0 to clear, 1-5 to set` keyboard shortcut
   * in EditorShell.onKeydown. */
  protected setStar(star: number): void {
    const a = this.asset();
    if (!a) return;
    this.state.setRating(a.id, a.rating === star ? 0 : star);
  }
}
