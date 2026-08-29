// MuiTimeline — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Date-grouped infinite scroll, built
// from Collection Grid, Text, Chip Row.
//
// Selection is global across the whole timeline, not per-group: `selectedIds`
// is forwarded into every nested Collection Grid's own `selectedIds`
// two-way binding, so selecting a photo in March and shift-clicking one in
// April both write into the same flat id list. Each group gets its own grid
// (its own virtualization window) rather than one grid spanning every
// group, so the sticky date header can sit between them in normal document
// flow.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiCollectionGridComponent } from '../collection-grid/mui-collection-grid.component';
import type { MuiCollectionItem } from '../collection-grid/mui-collection-grid.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiTimelineGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly MuiCollectionItem[];
}

/** Matches Collection Grid's own default `cellHeight` — a per-group grid's
 * viewport is sized off this so its rows are (usually) fully visible
 * without an inner scrollbar of their own. */
const GROUP_CELL_HEIGHT = 140;
/** A group's grid is capped at this many visible rows of height; beyond
 * that it scrolls internally rather than growing the page without bound. */
const MAX_VISIBLE_ROWS = 3;

@Component({
  selector: 'mui-timeline',
  standalone: true,
  imports: [
    MuiChipRowComponent,
    MuiCollectionGridComponent,
    MuiEmptyStateComponent,
    MuiSpinnerComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-timeline.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTimelineComponent {
  readonly groups = input.required<readonly MuiTimelineGroup[]>();
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);
  readonly filters = input<readonly MuiChip[]>([]);
  readonly columns = input<number>(6);

  readonly activeFilterId = model<string | null>(null);
  readonly selectedIds = model<readonly string[]>([]);

  readonly opened = output<string>();

  protected readonly allGroupsEmpty = computed(() =>
    this.groups().every((group) => group.items.length === 0),
  );

  /** Row count for a group is clamped to `MAX_VISIBLE_ROWS`, and floored at
   * 1 so an empty group still has room to render its own empty state. */
  groupViewportHeight(group: MuiTimelineGroup): number {
    const rows = Math.max(
      1,
      Math.min(MAX_VISIBLE_ROWS, Math.ceil(group.items.length / this.columns())),
    );
    return rows * GROUP_CELL_HEIGHT;
  }
}
