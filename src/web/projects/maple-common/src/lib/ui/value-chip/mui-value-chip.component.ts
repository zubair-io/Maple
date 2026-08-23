// MuiValueChip — Maple UI Molecules-L1 (unified-component-catalog.md §2.3).
// Floating value readout shown during a drag (e.g. above a slider thumb),
// built from Badge + Text. Purely presentational — positioning against the
// dragged control is the caller's concern.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-value-chip',
  standalone: true,
  imports: [MuiBadgeComponent, MuiTextComponent],
  templateUrl: './mui-value-chip.component.html',
  styleUrl: './mui-value-chip.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiValueChipComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string | number>();
}
