// MuiSuggestionMenu — the Maple UI design-system Suggestion Menu molecule
// (unified-component-catalog.md §2.4; Built from: Popover, Icon, Text). A
// query-driven autocomplete list (e.g. @-mention picker) — the caller
// already filters `entries` by the live query text; this component owns
// only the anchored presentation and keyboard/mouse selection.

import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';
import { MuiPopoverComponent, type MuiPopoverPlacement } from '../popover/mui-popover.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiSuggestionItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: MapleIconName;
  readonly meta?: string;
}

@Component({
  selector: 'mui-suggestion-menu',
  standalone: true,
  imports: [MuiPopoverComponent, MuiIconComponent, MuiTextComponent],
  templateUrl: './mui-suggestion-menu.component.html',
  styleUrl: './mui-suggestion-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSuggestionMenuComponent {
  readonly open = input<boolean>(false);
  readonly placement = input<MuiPopoverPlacement>('bottom');
  readonly items = input.required<readonly MuiSuggestionItem[]>();

  readonly select = output<string>();
  readonly closeRequested = output<void>();

  readonly activeIndex = signal<number>(0);

  constructor() {
    // A freshly (re)opened or re-filtered list always highlights its first
    // row, matching the usual @-mention/autocomplete convention of "Enter
    // picks the top match" without the caller having to manage this state.
    effect(() => {
      this.items();
      if (this.open()) this.activeIndex.set(0);
    });
  }

  onKeydown(event: KeyboardEvent): void {
    const count = this.items().length;
    if (count === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex.set((this.activeIndex() + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex.set((this.activeIndex() - 1 + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = this.items()[this.activeIndex()];
      if (item) this.select.emit(item.id);
    }
  }

  selectItem(item: MuiSuggestionItem): void {
    this.select.emit(item.id);
  }
}
