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

  readonly redetect = output<void>();

  readonly countLabel = computed(() => {
    const count = this.people().length;
    return count === 1 ? '1 person' : `${count} people`;
  });
}
