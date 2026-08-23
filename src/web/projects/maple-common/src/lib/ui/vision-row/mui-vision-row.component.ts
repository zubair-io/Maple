// MuiVisionRow — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Classification result chips, built from Chip Row. A thin, read-oriented
// wrapper: the underlying Chip Row still runs in `select` mode (so a tag can
// be focused/highlighted), but this molecule doesn't surface a two-way
// `selectedId` — vision labels are model output, not a filter the caller
// needs to persist.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';

@Component({
  selector: 'mui-vision-row',
  standalone: true,
  imports: [MuiChipRowComponent],
  templateUrl: './mui-vision-row.component.html',
  styleUrl: './mui-vision-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiVisionRowComponent {
  readonly labels = input.required<readonly MuiChip[]>();
}
