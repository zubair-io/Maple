// MuiToolbar — the Maple UI design-system Toolbar molecule
// (unified-component-catalog.md §2.5; Built from: Action Button, Divider,
// Icon). A row of action buttons; once the item entries exceed `maxVisible`
// the rest collapse behind a trailing overflow button that opens an
// `mui-popover` list.

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MuiActionButtonComponent } from '../action-button/mui-action-button.component';
import { MuiDividerComponent } from '../divider/mui-divider.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiPopoverComponent } from '../popover/mui-popover.component';

export interface MuiToolbarActionItem {
  readonly id: string;
  readonly icon: MapleIconName;
  readonly label: string;
  readonly disabled?: boolean;
  readonly divider?: false;
}

export interface MuiToolbarDivider {
  readonly divider: true;
}

export type MuiToolbarEntry = MuiToolbarActionItem | MuiToolbarDivider;

@Component({
  selector: 'mui-toolbar',
  standalone: true,
  imports: [
    MuiActionButtonComponent,
    MuiDividerComponent,
    MuiIconComponent,
    MuiTextComponent,
    MuiPopoverComponent,
  ],
  templateUrl: './mui-toolbar.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiToolbarComponent {
  readonly entries = input.required<readonly MuiToolbarEntry[]>();
  /** Item entries beyond this count move into the overflow popover.
   * Dividers don't count against the budget. */
  readonly maxVisible = input<number>(Number.POSITIVE_INFINITY);

  readonly itemSelected = output<string>();

  readonly overflowOpen = signal(false);

  asItem(entry: MuiToolbarEntry): MuiToolbarActionItem | null {
    return 'divider' in entry && entry.divider ? null : (entry as MuiToolbarActionItem);
  }

  readonly split = computed<{
    visible: readonly MuiToolbarEntry[];
    overflow: readonly MuiToolbarActionItem[];
  }>(() => {
    const max = this.maxVisible();
    const visible: MuiToolbarEntry[] = [];
    const overflow: MuiToolbarActionItem[] = [];
    let itemCount = 0;
    for (const entry of this.entries()) {
      const item = this.asItem(entry);
      if (item === null) {
        // A divider only earns its place while we're still filling the
        // visible row — once overflow has started, trailing dividers add
        // nothing to either list.
        if (overflow.length === 0) visible.push(entry);
        continue;
      }
      if (itemCount < max) {
        visible.push(entry);
        itemCount++;
      } else {
        overflow.push(item);
      }
    }
    return { visible, overflow };
  });

  press(item: MuiToolbarActionItem): void {
    if (item.disabled) return;
    this.itemSelected.emit(item.id);
  }

  selectOverflow(item: MuiToolbarActionItem): void {
    if (item.disabled) return;
    this.itemSelected.emit(item.id);
    this.overflowOpen.set(false);
  }
}
