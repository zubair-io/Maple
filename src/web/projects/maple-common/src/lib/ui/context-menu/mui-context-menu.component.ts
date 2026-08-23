// MuiContextMenu — the Maple UI design-system Context Menu molecule
// (unified-component-catalog.md §2.4; Built from: Popover, Icon, Text,
// Divider). A keyboard-navigable action list anchored via MuiPopover; the
// caller supplies the trigger element and owns `open` state, same contract
// as the underlying Popover.

import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';
import { MuiPopoverComponent, type MuiPopoverPlacement } from '../popover/mui-popover.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiDividerComponent } from '../divider/mui-divider.component';

export interface MuiContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: MapleIconName;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly divider?: false;
}

export interface MuiContextMenuDivider {
  readonly divider: true;
}

export type MuiContextMenuEntry = MuiContextMenuItem | MuiContextMenuDivider;

@Component({
  selector: 'mui-context-menu',
  standalone: true,
  imports: [MuiPopoverComponent, MuiIconComponent, MuiTextComponent, MuiDividerComponent],
  templateUrl: './mui-context-menu.component.html',
  styleUrl: './mui-context-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiContextMenuComponent {
  readonly open = input<boolean>(false);
  readonly placement = input<MuiPopoverPlacement>('bottom');
  readonly entries = input.required<readonly MuiContextMenuEntry[]>();

  readonly select = output<string>();
  readonly closeRequested = output<void>();

  readonly activeIndex = signal<number>(-1);

  constructor() {
    // A freshly (re)opened menu starts with no keyboard-active row — the
    // previous session's highlight must not leak into the next open.
    effect(() => {
      if (this.open()) this.activeIndex.set(-1);
    });
  }

  asItem(entry: MuiContextMenuEntry): MuiContextMenuItem | null {
    return 'divider' in entry && entry.divider ? null : (entry as MuiContextMenuItem);
  }

  private selectableIndexes(): readonly number[] {
    return this.entries()
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => this.asItem(entry) !== null && !this.asItem(entry)!.disabled)
      .map(({ index }) => index);
  }

  onKeydown(event: KeyboardEvent): void {
    const selectable = this.selectableIndexes();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (selectable.length > 0) this.moveActive(1, selectable);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (selectable.length > 0) this.moveActive(-1, selectable);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const idx = this.activeIndex();
      const item = idx >= 0 ? this.asItem(this.entries()[idx]) : null;
      if (item) this.selectItem(item);
    }
  }

  private moveActive(direction: 1 | -1, selectable: readonly number[]): void {
    const current = this.activeIndex();
    const currentPos = selectable.indexOf(current);
    const nextPos =
      currentPos === -1
        ? direction === 1
          ? 0
          : selectable.length - 1
        : (currentPos + direction + selectable.length) % selectable.length;
    this.activeIndex.set(selectable[nextPos]);
  }

  selectItem(item: MuiContextMenuItem): void {
    if (item.disabled) return;
    this.select.emit(item.id);
  }
}
