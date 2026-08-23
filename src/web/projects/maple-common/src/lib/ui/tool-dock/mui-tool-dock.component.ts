// MuiToolDock — the Maple UI design-system Tool Dock organism
// (unified-component-catalog.md §4.2; Built from: Action Button, Divider,
// Icon). A single-select tool group switcher, laid out vertically or
// horizontally. Like Toolbar, this is a thin always-populated control — a
// caller with zero tools passes an empty `entries` array and the dock
// simply renders nothing, no loading/empty chrome of its own.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiActionButtonComponent } from '../action-button/mui-action-button.component';
import type { MuiActionButtonOrientation } from '../action-button/mui-action-button.component';
import { MuiDividerComponent } from '../divider/mui-divider.component';
import type { MuiDividerOrientation } from '../divider/mui-divider.component';
import type { MapleIconName } from '../icon/mui-icon.component';

export interface MuiToolDockItem {
  readonly id: string;
  readonly icon: MapleIconName;
  readonly label: string;
  readonly disabled?: boolean;
  readonly divider?: false;
}

export interface MuiToolDockDivider {
  readonly divider: true;
}

export type MuiToolDockEntry = MuiToolDockItem | MuiToolDockDivider;
export type MuiToolDockOrientation = 'vertical' | 'horizontal';

@Component({
  selector: 'mui-tool-dock',
  standalone: true,
  imports: [MuiActionButtonComponent, MuiDividerComponent],
  templateUrl: './mui-tool-dock.component.html',
  styleUrl: './mui-tool-dock.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiToolDockComponent {
  readonly entries = input.required<readonly MuiToolDockEntry[]>();
  readonly orientation = input<MuiToolDockOrientation>('vertical');

  readonly activeId = model<string | null>(null);

  readonly toolSelected = output<string>();

  asItem(entry: MuiToolDockEntry): MuiToolDockItem | null {
    return 'divider' in entry && entry.divider ? null : (entry as MuiToolDockItem);
  }

  /** A vertical dock stacks icon-over-label per item; a horizontal dock
   * lays icon and label side by side. */
  itemOrientation(): MuiActionButtonOrientation {
    return this.orientation() === 'vertical' ? 'stacked' : 'horizontal';
  }

  /** A divider between stacked (vertical) items is itself a horizontal
   * rule, and vice versa. */
  dividerOrientation(): MuiDividerOrientation {
    return this.orientation() === 'vertical' ? 'horizontal' : 'vertical';
  }

  select(id: string, disabled: boolean | undefined): void {
    if (disabled) return;
    this.activeId.set(id);
    this.toolSelected.emit(id);
  }
}
