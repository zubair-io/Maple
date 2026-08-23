// MuiNotificationFeed — Maple UI Organisms (Wave W6 Lane B). Filterable
// activity list — built from Chip Row, List Row, Empty State.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';

export interface MuiNotificationItem {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly timestamp: Date | number | string;
  readonly read: boolean;
}

const ALL_FILTER_ID = 'all';

const DEFAULT_FILTERS: readonly MuiChip[] = [
  { id: ALL_FILTER_ID, label: 'All' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'shares', label: 'Shares' },
];

@Component({
  selector: 'mui-notification-feed',
  standalone: true,
  imports: [MuiChipRowComponent, MuiEmptyStateComponent, MuiListRowComponent],
  templateUrl: './mui-notification-feed.component.html',
  styleUrl: './mui-notification-feed.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiNotificationFeedComponent {
  readonly notifications = input.required<readonly MuiNotificationItem[]>();
  readonly filters = input<readonly MuiChip[]>(DEFAULT_FILTERS);
  readonly activeFilter = model<string>(ALL_FILTER_ID);

  readonly filterChanged = output<string>();
  readonly notificationOpened = output<string>();
  readonly markedRead = output<string>();

  readonly filteredNotifications = computed(() => {
    const filter = this.activeFilter();
    if (filter === ALL_FILTER_ID) return this.notifications();
    return this.notifications().filter((notification) => notification.category === filter);
  });

  readonly activeFilterLabel = computed(
    () =>
      this.filters().find((filter) => filter.id === this.activeFilter())?.label ?? 'this filter',
  );

  onFilterChange(id: string | null): void {
    const next = id ?? ALL_FILTER_ID;
    this.activeFilter.set(next);
    this.filterChanged.emit(next);
  }

  open(notification: MuiNotificationItem): void {
    this.notificationOpened.emit(notification.id);
  }

  markRead(notification: MuiNotificationItem, event: Event): void {
    event.stopPropagation();
    this.markedRead.emit(notification.id);
  }
}
