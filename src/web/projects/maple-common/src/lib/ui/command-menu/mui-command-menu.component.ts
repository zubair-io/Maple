// MuiCommandMenu — the Maple UI design-system Command Menu molecule
// (unified-component-catalog.md §2.4; Built from: Popover, Input, Icon,
// Text). A searchable command palette: an `mui-input` filter on top of an
// anchored `mui-popover` result list, filtering by substring match against
// each command's label.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { MuiPopoverComponent, type MuiPopoverPlacement } from '../popover/mui-popover.component';
import { MuiInputComponent } from '../input/mui-input.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiCommandItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: MapleIconName;
  readonly shortcut?: string;
}

@Component({
  selector: 'mui-command-menu',
  standalone: true,
  imports: [MuiPopoverComponent, MuiInputComponent, MuiIconComponent, MuiTextComponent],
  templateUrl: './mui-command-menu.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
})
export class MuiCommandMenuComponent {
  readonly open = input<boolean>(false);
  readonly placement = input<MuiPopoverPlacement>('bottom');
  readonly commands = input.required<readonly MuiCommandItem[]>();
  readonly placeholder = input<string>('Type a command');

  readonly select = output<string>();
  readonly closeRequested = output<void>();

  readonly query = signal('');
  readonly activeIndex = signal(0);

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.commands();
    return this.commands().filter((command) => command.label.toLowerCase().includes(q));
  });

  readonly clampedActiveIndex = computed(() => {
    const count = this.filtered().length;
    if (count === 0) return -1;
    return Math.min(this.activeIndex(), count - 1);
  });

  constructor() {
    // Every (re)open starts from a clean search, same as a real command
    // palette — the previous query never survives a close.
    effect(() => {
      if (this.open()) {
        this.query.set('');
        this.activeIndex.set(0);
      }
    });
  }

  setQuery(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
  }

  onKeydown(event: KeyboardEvent): void {
    const count = this.filtered().length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (count > 0) this.activeIndex.set((this.clampedActiveIndex() + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (count > 0) this.activeIndex.set((this.clampedActiveIndex() - 1 + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = this.filtered()[this.clampedActiveIndex()];
      if (command) this.select.emit(command.id);
    }
  }

  selectItem(command: MuiCommandItem): void {
    this.select.emit(command.id);
  }
}
