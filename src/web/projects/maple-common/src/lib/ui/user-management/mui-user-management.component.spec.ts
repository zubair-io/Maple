// The invite panel renders a `mui-qr-code`, which calls the real `qrcode`
// encoder in an `effect()` — jsdom has no working canvas 2D context (see
// qr-code's own spec), so the module is mocked here too, purely to keep
// that side effect quiet while this component's own revoke/invite logic is
// under test.

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { toCanvas } from 'qrcode';

import type { MuiManagedUser } from './mui-user-management.component';
import { MuiUserManagementComponent } from './mui-user-management.component';

vi.mock('qrcode', () => ({ toCanvas: vi.fn().mockResolvedValue(undefined) }));
void toCanvas;

const USERS: readonly MuiManagedUser[] = [
  { id: 'u1', name: 'Zubair Lawrence', email: 'zubair@justmaple.app', role: 'Owner' },
  { id: 'u2', name: 'Priya Nair', email: 'priya@justmaple.app', role: 'Editor' },
];

@Component({
  standalone: true,
  imports: [MuiUserManagementComponent],
  template: `
    <mui-user-management
      [users]="users()"
      inviteLink="https://maple.local/invite/abc123"
      (userInvited)="lastInvited = $event"
      (userRevoked)="lastRevoked = $event"
    />
  `,
})
class HostComponent {
  readonly users = signal(USERS);
  lastInvited: string | null = null;
  lastRevoked: string | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiUserManagementComponent', () => {
  it('renders one row per user and the invite QR code', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('mui-list-row').length).toBe(2);
    expect(el.querySelector('mui-qr-code')).toBeTruthy();
  });

  it('does not revoke on the row button alone — it opens a confirm dialog first', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('mui-list-row mui-button .mui-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(host.lastRevoked).toBeNull();
    const dialog = el.querySelector('.mui-dialog-scrim');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('Zubair Lawrence');
  });

  it('emits userRevoked with the target id only after the dialog is confirmed', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('mui-list-row mui-button .mui-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    const confirmButton = el.querySelector(
      '.mui-dialog .actions .mui-button.variant-destructive',
    ) as HTMLButtonElement;
    confirmButton.click();
    fixture.detectChanges();

    expect(host.lastRevoked).toBe('u1');
    expect(el.querySelector('.mui-dialog-scrim')).toBeNull();
  });

  it('dismisses the dialog without emitting userRevoked on Cancel', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('mui-list-row mui-button .mui-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    const cancelButton = el.querySelector(
      '.mui-dialog .actions .mui-button.variant-ghost',
    ) as HTMLButtonElement;
    cancelButton.click();
    fixture.detectChanges();

    expect(host.lastRevoked).toBeNull();
    expect(el.querySelector('.mui-dialog-scrim')).toBeNull();
  });

  it('emits userInvited with the trimmed email and clears the field model on commit', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('.invite-field input') as HTMLInputElement;
    input.value = '  newuser@justmaple.app  ';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(host.lastInvited).toBe('newuser@justmaple.app');
    const management = fixture.debugElement.children[0]
      .componentInstance as MuiUserManagementComponent;
    expect(management.inviteValue()).toBe('');
  });
});
