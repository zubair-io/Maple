// MuiTreeRow — Maple UI Molecules-L1 (unified-component-catalog.md §2.2).
// One row of a hierarchical tree, built from Icon, Text, Badge, Spinner.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-tree-row',
  standalone: true,
  imports: [MuiBadgeComponent, MuiIconComponent, MuiSpinnerComponent, MuiTextComponent],
  templateUrl: './mui-tree-row.component.html',
  styleUrl: './mui-tree-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTreeRowComponent {
  readonly label = input.required<string>();
  readonly icon = input<MapleIconName>('folder');
  /** Shows a leading chevron and toggles `expanded` when there are children. */
  readonly expandable = input<boolean>(false);
  readonly expanded = model<boolean>(false);
  /** Indentation level — each level adds one indent unit. */
  readonly depth = input<number>(0);
  readonly count = input<number | null>(null);
  readonly loading = input<boolean>(false);
  readonly active = input<boolean>(false);
  readonly disabled = input<boolean>(false);

  readonly pressed = output<void>();

  readonly indentPx = computed(() => this.depth() * 16);

  toggle(event: Event): void {
    event.stopPropagation();
    if (this.disabled()) return;
    this.expanded.set(!this.expanded());
  }

  onRowClick(): void {
    if (this.disabled()) return;
    this.pressed.emit();
  }
}
