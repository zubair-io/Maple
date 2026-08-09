// TrashItemRowComponent — one row in `TrashPanelComponent`'s list. Split
// out to keep the panel's own template small (the fallow-audit-web gate has
// flagged 76-line combined templates before; a full list-row markup inline
// in the panel would have pushed well past that).

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import type { TrashItem } from './trash.types';

@Component({
  selector: 'app-trash-item-row',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './trash-item-row.component.html',
  styleUrl: './trash-item-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashItemRowComponent {
  readonly item = input.required<TrashItem>();
  /** True while THIS row's restore or delete call is in flight — disables
   * both of its own buttons without touching the rest of the list. */
  readonly busy = input<boolean>(false);

  readonly restore = output<void>();
  readonly deletePermanently = output<void>();
}
