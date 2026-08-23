import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPagePairingComponent } from './mui-page-pairing.component';

describe('MuiPagePairingComponent', () => {
  it('renders the Pair Device flow open inside App Shell Content', () => {
    const fixture = TestBed.createComponent(MuiPagePairingComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-pair-device-modal')).toBeTruthy();
    expect(fixture.componentInstance.headerTitle()).toBe('Enter pairing code');
  });

  it('updates the Nav title when the pairing step changes', () => {
    const fixture = TestBed.createComponent(MuiPagePairingComponent);
    fixture.detectChanges();

    fixture.componentInstance.onStepChanged(1);
    fixture.detectChanges();

    expect(fixture.componentInstance.step()).toBe(1);
    expect(fixture.componentInstance.headerTitle()).toBe('Scanning for device');
  });

  it('reflects a completed pairing in the Nav title and paired device state', () => {
    const fixture = TestBed.createComponent(MuiPagePairingComponent);
    fixture.detectChanges();

    fixture.componentInstance.onPaired('MPL-7F2Q-9X');
    fixture.detectChanges();

    expect(fixture.componentInstance.pairedDeviceName()).toBe('MPL-7F2Q-9X');
    expect(fixture.componentInstance.headerTitle()).toBe('Connected');
  });
});
