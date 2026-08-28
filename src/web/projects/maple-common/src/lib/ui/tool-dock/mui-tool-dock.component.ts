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
  /** Tooltip text — passed straight through to the underlying action
   * button's `title`. */
  readonly title?: string | null;
  /** Explicit active/pressed state, computed by the caller. When omitted,
   * the item falls back to the dock's own single-select `activeId` model —
   * callers that need several independent activation predicates (e.g. a
   * navigation entry active by group membership alongside an unrelated
   * panel-toggle entry active by its own open/closed flag) set this
   * directly instead of relying on one shared selected id. */
  readonly selected?: boolean;
  /** True hides this entry from the accessibility tree and tab order
   * entirely — for a disabled placeholder a caller wants fully out of
   * assistive-tech navigation, not merely dimmed (mirrors a platform's
   * `.accessibilityHidden(true)`), rather than the ordinary "present but
   * disabled" state `disabled` alone gives every other button. */
  readonly ariaHidden?: boolean;
  /** Shows an accent dot at the icon corner — "this entry's underlying
   * state differs from default," independent of `selected`. */
  readonly modified?: boolean;
  /** Marks this entry as a PANEL TOGGLE (e.g. a flyout or floating panel)
   * rather than a navigable group/tool selection. Panel entries still emit
   * `toolSelected` on press, but pressing one does not move the dock's own
   * `activeId` single-select model — a panel opening and a nav entry being
   * "current" are independent facts, and a caller driving `selected`
   * explicitly for both kinds must not have one silently overwritten by
   * the other's click. */
  readonly panel?: boolean;
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
  /** Overrides the derived per-item icon/label layout below. A caller whose
   * items must always stack icon-over-label regardless of the dock's own
   * row axis — a phone bottom bar that scrolls a ROW of buttons, each of
   * which is still icon-on-top / label-below, not two horizontal dock
   * layouts sharing one item shape — sets this explicitly rather than
   * accepting the orientation-derived default. */
  readonly itemOrientationOverride = input<MuiActionButtonOrientation | null>(null);

  readonly activeId = model<string | null>(null);

  readonly toolSelected = output<string>();

  asItem(entry: MuiToolDockEntry): MuiToolDockItem | null {
    return 'divider' in entry && entry.divider ? null : (entry as MuiToolDockItem);
  }

  /** A vertical dock stacks icon-over-label per item; a horizontal dock
   * lays icon and label side by side — unless `itemOrientationOverride`
   * pins one layout regardless of the dock's own row axis. */
  itemOrientation(): MuiActionButtonOrientation {
    return (
      this.itemOrientationOverride() ??
      (this.orientation() === 'vertical' ? 'stacked' : 'horizontal')
    );
  }

  /** A divider between stacked (vertical) items is itself a horizontal
   * rule, and vice versa. */
  dividerOrientation(): MuiDividerOrientation {
    return this.orientation() === 'vertical' ? 'horizontal' : 'vertical';
  }

  /** Whether an item shows as active — the caller's explicit `selected`
   * when given, else a fallback to the dock's own single-select
   * `activeId` model (see `MuiToolDockItem.selected`'s doc comment). */
  isSelected(item: MuiToolDockItem): boolean {
    return item.selected ?? this.activeId() === item.id;
  }

  select(item: MuiToolDockItem): void {
    if (item.disabled) return;
    // Panel-toggle entries (a flyout's own open/closed state) don't
    // participate in the dock's single-select nav model — only group/tool
    // entries move `activeId`.
    if (!item.panel) this.activeId.set(item.id);
    this.toolSelected.emit(item.id);
  }
}
