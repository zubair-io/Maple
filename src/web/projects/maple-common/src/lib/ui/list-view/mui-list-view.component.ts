// MuiListView — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Virtualized row list, built from
// List Row, Empty State, Spinner.
//
// Same virtualization-lite technique as Collection Grid, but single-column:
// the visible window is a slice of `items()` derived from `scrollTop` via
// pure `computed()`s, with a spacer div before and after the rendered slice
// to keep the native scrollbar's total scroll height correct.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';

export interface MuiListViewItem {
  readonly id: string;
  readonly icon?: MapleIconName | null;
  readonly label: string;
  readonly subtitle?: string | null;
  readonly timestampValue?: Date | number | string | null;
}

@Component({
  selector: 'mui-list-view',
  standalone: true,
  imports: [MuiEmptyStateComponent, MuiListRowComponent, MuiSpinnerComponent],
  templateUrl: './mui-list-view.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiListViewComponent {
  readonly items = input.required<readonly MuiListViewItem[]>();
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);
  readonly emptyMessage = input<string>('No items to show.');
  readonly rowHeight = input<number>(40);
  readonly viewportHeight = input<number>(360);
  readonly bufferRows = input<number>(4);

  readonly activeId = model<string | null>(null);

  readonly itemPressed = output<string>();

  private readonly scrollTop = signal(0);

  protected readonly startIndex = computed(() =>
    Math.max(0, Math.floor(this.scrollTop() / this.rowHeight()) - this.bufferRows()),
  );

  protected readonly endIndex = computed(() =>
    Math.min(
      this.items().length,
      Math.ceil((this.scrollTop() + this.viewportHeight()) / this.rowHeight()) + this.bufferRows(),
    ),
  );

  protected readonly visibleItems = computed(() =>
    this.items().slice(this.startIndex(), this.endIndex()),
  );

  protected readonly topSpacerPx = computed(() => this.startIndex() * this.rowHeight());

  protected readonly bottomSpacerPx = computed(() =>
    Math.max(0, (this.items().length - this.endIndex()) * this.rowHeight()),
  );

  onScroll(event: Event): void {
    this.scrollTop.set((event.target as HTMLElement).scrollTop);
  }

  select(id: string): void {
    this.activeId.set(id);
    this.itemPressed.emit(id);
  }
}
