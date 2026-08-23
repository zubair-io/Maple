import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiPairedDevice } from './mui-device-list.component';
import { MuiDeviceListComponent } from './mui-device-list.component';

const DEVICES: readonly MuiPairedDevice[] = [
  { id: 'd1', name: 'MacBook Pro', platform: 'macOS 15', lastSeen: Date.now() },
  { id: 'd2', name: 'iPhone 15', platform: 'iOS 19', lastSeen: Date.now() },
];

@Component({
  standalone: true,
  imports: [MuiDeviceListComponent],
  template: ` <mui-device-list [devices]="devices()" (deviceRevoked)="lastRevoked = $event" /> `,
})
class HostComponent {
  readonly devices = signal<readonly MuiPairedDevice[]>(DEVICES);
  lastRevoked: string | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiDeviceListComponent', () => {
  it('shows the empty state when there are no paired devices', () => {
    const { fixture, host } = render();
    host.devices.set([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-empty-state')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-list-row')).toBeNull();
  });

  it('renders one row per paired device', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelectorAll('mui-list-row').length).toBe(2);
  });

  it('does not revoke on the row button alone — the dialog gates it', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('mui-list-row mui-button .mui-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(host.lastRevoked).toBeNull();
    expect(el.querySelector('.mui-dialog-scrim')).toBeTruthy();
  });

  it('emits deviceRevoked with the target id only after confirming', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('mui-list-row mui-button .mui-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    const confirmButton = el.querySelector(
      '.mui-dialog .actions .mui-button.variant-destructive',
    ) as HTMLButtonElement;
    confirmButton.click();
    fixture.detectChanges();

    expect(host.lastRevoked).toBe('d1');
    expect(el.querySelector('.mui-dialog-scrim')).toBeNull();
  });

  it('cancelling the dialog does not revoke', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelectorAll('mui-list-row mui-button .mui-button')[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    const cancelButton = el.querySelector(
      '.mui-dialog .actions .mui-button.variant-ghost',
    ) as HTMLButtonElement;
    cancelButton.click();
    fixture.detectChanges();

    expect(host.lastRevoked).toBeNull();
  });
});
