// MuiPageNotifications — Maple UI Pages (unified-component-catalog.md §6).
// App Shell with the Notification Feed filling Content.
//
// Cross-organism wiring: the Notification Feed only reports which item was
// marked read — it doesn't own the "read" flag itself. The page applies
// that flag to its own notification list and reflects the resulting unread
// count on a Badge in the Nav region's Page Header.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiAppShellComponent } from '../../app-shell/mui-app-shell.component';
import { MuiPageHeaderComponent } from '../../page-header/mui-page-header.component';
import { MuiBadgeComponent } from '../../badge/mui-badge.component';
import { MuiNotificationFeedComponent } from '../../notification-feed/mui-notification-feed.component';
import type { MuiNotificationItem } from '../../notification-feed/mui-notification-feed.component';

const BASE_TIME = new Date('2026-03-04T14:00:00Z').getTime();

const INITIAL_NOTIFICATIONS: readonly MuiNotificationItem[] = [
  {
    id: 'n1',
    label: 'Jane commented on Ballet Recital',
    category: 'mentions',
    timestamp: BASE_TIME - 3_600_000,
    read: false,
  },
  {
    id: 'n2',
    label: 'Sam shared Coastal Shoot',
    category: 'shares',
    timestamp: BASE_TIME - 7_200_000,
    read: false,
  },
  {
    id: 'n3',
    label: 'Priya mentioned you in Wedding — Ortiz',
    category: 'mentions',
    timestamp: BASE_TIME - 86_400_000,
    read: true,
  },
];

@Component({
  selector: 'mui-page-notifications',
  standalone: true,
  imports: [
    MuiAppShellComponent,
    MuiPageHeaderComponent,
    MuiBadgeComponent,
    MuiNotificationFeedComponent,
  ],
  templateUrl: './mui-page-notifications.component.html',
  styleUrl: './mui-page-notifications.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageNotificationsComponent {
  readonly notifications = signal<readonly MuiNotificationItem[]>(INITIAL_NOTIFICATIONS);
  readonly activeFilter = signal<string>('all');

  readonly unreadCount = computed<number>(() => this.notifications().filter((n) => !n.read).length);

  onMarkedRead(id: string): void {
    this.notifications.update((items) =>
      items.map((item) => (item.id === id ? { ...item, read: true } : item)),
    );
  }
}
