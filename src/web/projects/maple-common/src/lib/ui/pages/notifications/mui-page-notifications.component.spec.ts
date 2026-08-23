import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageNotificationsComponent } from './mui-page-notifications.component';

describe('MuiPageNotificationsComponent', () => {
  it('renders the Notification Feed and an unread Badge in Nav', () => {
    const fixture = TestBed.createComponent(MuiPageNotificationsComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-notification-feed')).toBeTruthy();
    expect(fixture.componentInstance.unreadCount()).toBe(2);
    expect(fixture.nativeElement.querySelector('[slot=nav] mui-badge')).toBeTruthy();
  });

  it('decrements the unread Badge count when a notification is marked read', () => {
    const fixture = TestBed.createComponent(MuiPageNotificationsComponent);
    fixture.detectChanges();

    fixture.componentInstance.onMarkedRead('n1');
    fixture.detectChanges();

    expect(fixture.componentInstance.unreadCount()).toBe(1);
    expect(fixture.componentInstance.notifications().find((n) => n.id === 'n1')?.read).toBe(true);
  });

  it('hides the Badge once every notification is read', () => {
    const fixture = TestBed.createComponent(MuiPageNotificationsComponent);
    fixture.detectChanges();

    fixture.componentInstance.onMarkedRead('n1');
    fixture.componentInstance.onMarkedRead('n2');
    fixture.detectChanges();

    expect(fixture.componentInstance.unreadCount()).toBe(0);
    expect(fixture.nativeElement.querySelector('[slot=nav] mui-badge')).toBeNull();
  });
});
