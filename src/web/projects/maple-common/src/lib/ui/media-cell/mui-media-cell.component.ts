// MuiMediaCell — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Thumbnail with badges, rating, selection — built from Image, Badge,
// Rating & Flags, Inline Rename Field. The core grid-cell primitive that
// Filmstrip Row/Rail compose.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiImageComponent } from '../image/mui-image.component';
import { MuiInlineRenameFieldComponent } from '../inline-rename-field/mui-inline-rename-field.component';
import { MuiRatingFlagsComponent } from '../rating-flags/mui-rating-flags.component';
import type { MuiRatingFlagState } from '../rating-flags/mui-rating-flags.component';
import { handleActivationKeydown } from '../internal/activation-keydown';

export type MuiMediaCellSize = 'sm' | 'md';

@Component({
  selector: 'mui-media-cell',
  standalone: true,
  imports: [
    MuiBadgeComponent,
    MuiImageComponent,
    MuiInlineRenameFieldComponent,
    MuiRatingFlagsComponent,
  ],
  templateUrl: './mui-media-cell.component.html',
  styleUrl: './mui-media-cell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiMediaCellComponent {
  readonly src = input.required<string>();
  readonly alt = input.required<string>();
  readonly filename = model<string>('');
  /** Short text badges (e.g. media type, RAW) rendered top of the thumbnail. */
  readonly badges = input<readonly string[]>([]);
  readonly selected = input<boolean>(false);
  readonly size = input<MuiMediaCellSize>('md');
  readonly rating = model<number>(0);
  readonly flag = model<MuiRatingFlagState>('none');

  /** Fires on a click/tap of the thumbnail itself — not the rename field or
   * rating row, which own their own interactions. The caller decides what
   * a press means (select, open, toggle). */
  readonly pressed = output<void>();
  readonly renamed = output<string>();

  onCellClick(): void {
    this.pressed.emit();
  }

  onKeydown(event: KeyboardEvent): void {
    handleActivationKeydown(event, () => this.pressed.emit());
  }
}
