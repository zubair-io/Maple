// MuiFacesRow — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Count, person chips, re-detect — built from Chip Row, Button, Text.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-faces-row',
  standalone: true,
  imports: [MuiButtonComponent, MuiChipRowComponent, MuiTextComponent],
  templateUrl: './mui-faces-row.component.html',
  styleUrl: './mui-faces-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiFacesRowComponent {
  readonly people = input.required<readonly MuiChip[]>();
  readonly selectedId = model<string | null>(null);
  readonly redetecting = input<boolean>(false);
  /** Total detected faces, tagged + untagged. `null` (default) falls back
   * to a "N people" label derived from `people().length` (tagged only). */
  readonly totalCount = input<number | null>(null);
  /** Detected-but-unnamed face count — rendered as a trailing dashed "+N
   * unnamed" pill when positive. 0 (default) hides it. */
  readonly untaggedCount = input<number>(0);

  readonly redetect = output<void>();
  /** Click on the "+N unnamed" pill. */
  readonly untaggedClicked = output<void>();

  readonly countLabel = computed(() => {
    const total = this.totalCount();
    if (total !== null) {
      return total === 1 ? '1 face detected' : `${total} faces detected`;
    }
    const count = this.people().length;
    return count === 1 ? '1 person' : `${count} people`;
  });
}
