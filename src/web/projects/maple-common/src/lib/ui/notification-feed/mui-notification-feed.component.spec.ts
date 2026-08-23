import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiNotificationFeedComponent } from './mui-notification-feed.component';
import type { MuiNotificationItem } from './mui-notification-feed.component';

const NOTIFICATIONS: MuiNotificationItem[] = [
  {
    id: 'n1',
    label: 'Ada mentioned you',
    category: 'mentions',
    timestamp: Date.now(),
    read: false,
  },
  {
    id: 'n2',
    label: 'Grace shared an album',
    category: 'shares',
    timestamp: Date.now(),
    read: true,
  },
];

@Component({
  standalone: true,
  imports: [MuiNotificationFeedComponent],
  template: `
    <mui-notification-feed
      [notifications]="notifications()"
      [(activeFilter)]="activeFilter"
      (filterChanged)="lastFilter = $event"
      (notificationOpened)="opened = $event"
      (markedRead)="marked = $event"
    />
  `,
})
class HostComponent {
  readonly notifications = signal<readonly MuiNotificationItem[]>(NOTIFICATIONS);
  readonly activeFilter = signal('all');
  lastFilter: string | null = null;
  opened: string | null = null;
  marked: string | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiNotificationFeedComponent', () => {
  it('shows all notifications under the default "All" filter', () => {
    const { fixture } = render();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('mui-list-row').length).toBe(2);
  });

  it('filters the list and emits filterChanged when a chip is selected', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const sharesChip = Array.from(el.querySelectorAll('.chip')).find((chip) =>
      chip.textContent?.includes('Shares'),
    ) as HTMLButtonElement;
    sharesChip.click();
    fixture.detectChanges();

    expect(host.lastFilter).toBe('shares');
    expect(host.activeFilter()).toBe('shares');
    const rows = el.querySelectorAll('mui-list-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('Grace shared an album');
  });

  it('shows the empty state when a filter matches nothing', () => {
    const { fixture, host } = render();
    host.notifications.set([]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('mui-empty-state')).not.toBeNull();
    expect(el.querySelectorAll('mui-list-row').length).toBe(0);
  });

  it('emits notificationOpened when a row is pressed', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('mui-list-row .mui-list-row') as HTMLElement).click();
    expect(host.opened).toBe('n1');
  });

  it('emits markedRead without also triggering notificationOpened', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const markReadBtn = el.querySelector('.mark-read') as HTMLButtonElement;
    markReadBtn.click();
    expect(host.marked).toBe('n1');
    expect(host.opened).toBeNull();
  });
});
