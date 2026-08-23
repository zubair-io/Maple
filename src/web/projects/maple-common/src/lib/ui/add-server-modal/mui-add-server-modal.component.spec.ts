import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiAddServerModalComponent } from './mui-add-server-modal.component';
import type { MuiAddServerRequest } from './mui-add-server-modal.component';

@Component({
  standalone: true,
  imports: [MuiAddServerModalComponent],
  template: `
    <mui-add-server-modal
      [open]="open()"
      [(host)]="host"
      [(username)]="username"
      [(password)]="password"
      [connecting]="connecting()"
      [error]="error()"
      (connectRequested)="lastRequest = $event"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly connecting = signal(false);
  readonly error = signal<string | null>(null);
  readonly host = signal('');
  readonly username = signal('');
  readonly password = signal('');
  lastRequest: MuiAddServerRequest | null = null;
  dismissedCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiAddServerModalComponent', () => {
  it('disables Connect until host and username are filled', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const connectBtn = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.trim().includes('Connect'),
    ) as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(true);

    host.host.set('maple.example.com');
    host.username.set('zubair');
    fixture.detectChanges();
    expect(connectBtn.disabled).toBe(false);
  });

  it('emits connectRequested with the current field values', () => {
    const { fixture, host } = render();
    host.host.set('maple.example.com');
    host.username.set('zubair');
    host.password.set('hunter2');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const connectBtn = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.trim().includes('Connect'),
    ) as HTMLButtonElement;
    connectBtn.click();

    expect(host.lastRequest).toEqual({
      host: 'maple.example.com',
      username: 'zubair',
      password: 'hunter2',
    });
  });

  it('renders an error banner when error is set', () => {
    const { fixture, host } = render();
    host.error.set('Could not reach server');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Could not reach server');
  });

  it('emits dismissed from the close button and scrim', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('.mui-overlay-shell-scrim') as HTMLElement).click();
    expect(host.dismissedCount).toBe(1);
  });
});
