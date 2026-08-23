import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPairDeviceModalComponent } from './mui-pair-device-modal.component';

@Component({
  standalone: true,
  imports: [MuiPairDeviceModalComponent],
  template: `
    <mui-pair-device-modal
      [open]="open()"
      [step]="step()"
      [pairingCode]="pairingCode()"
      [scanning]="scanning()"
      [connected]="connected()"
      (stepChanged)="lastStep = $event"
      (paired)="pairedCode = $event"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly step = signal(0);
  readonly pairingCode = signal('ABC-123');
  readonly scanning = signal(false);
  readonly connected = signal(false);
  lastStep: number | null = null;
  pairedCode: string | null = null;
  dismissedCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiPairDeviceModalComponent', () => {
  it('shows the QR code panel and marks step 0 active on the step list', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.panel.show-code')).not.toBeNull();
    const stepEls = el.querySelectorAll('mui-progress-step');
    expect(stepEls[0].className).toContain('');
  });

  it('shows the scan panel on step 1 and the connect panel on step 2', () => {
    const { fixture, host } = render();
    host.step.set(1);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.panel.scan')).not.toBeNull();

    host.step.set(2);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.panel.connect')).not.toBeNull();
  });

  it('advances to step 2 when the scanner reports a scanned code', () => {
    const { fixture, host } = render();
    host.step.set(1);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const pasteInput = el.querySelector('mui-qr-scanner input') as HTMLInputElement;
    pasteInput.value = 'PEER-CODE';
    pasteInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const useCodeBtn = Array.from(el.querySelectorAll('mui-qr-scanner button')).find((b) =>
      b.textContent?.trim().includes('Use code'),
    ) as HTMLButtonElement;
    useCodeBtn.click();
    fixture.detectChanges();
    expect(host.lastStep).toBe(2);
  });

  it('emits paired with the pairing code once connected and Done is pressed', () => {
    const { fixture, host } = render();
    host.step.set(2);
    host.connected.set(true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const doneBtn = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Done',
    ) as HTMLButtonElement;
    doneBtn.click();
    expect(host.pairedCode).toBe('ABC-123');
  });

  it('emits dismissed on the close button', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('.mui-overlay-shell-scrim') as HTMLElement).click();
    expect(host.dismissedCount).toBe(1);
  });
});
