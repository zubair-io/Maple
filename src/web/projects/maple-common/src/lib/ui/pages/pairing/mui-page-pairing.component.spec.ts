// Renders `mui-pair-device-modal` open at step 0, which in turn renders
// `mui-qr-code` and calls an injected encoder function in an `effect()` —
// override the real `qrcode`-backed default via the `QR_CODE_TO_CANVAS` DI
// token (#3034; see its doc comment in `mui-qr-code.component.ts`) rather
// than `vi.mock('qrcode', ...)`.

import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { MuiPagePairingComponent } from './mui-page-pairing.component';
import { QR_CODE_TO_CANVAS } from '../../qr-code/mui-qr-code.component';

const mockedToCanvas = vi.fn().mockResolvedValue(undefined);

function render() {
  TestBed.configureTestingModule({
    imports: [MuiPagePairingComponent],
    providers: [{ provide: QR_CODE_TO_CANVAS, useValue: mockedToCanvas }],
  });
  const fixture = TestBed.createComponent(MuiPagePairingComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiPagePairingComponent', () => {
  it('renders the Pair Device flow open inside App Shell Content', () => {
    const fixture = render();

    expect(fixture.nativeElement.querySelector('mui-pair-device-modal')).toBeTruthy();
    expect(fixture.componentInstance.headerTitle()).toBe('Enter pairing code');
  });

  it('updates the Nav title when the pairing step changes', () => {
    const fixture = render();

    fixture.componentInstance.onStepChanged(1);
    fixture.detectChanges();

    expect(fixture.componentInstance.step()).toBe(1);
    expect(fixture.componentInstance.headerTitle()).toBe('Scanning for device');
  });

  it('reflects a completed pairing in the Nav title and paired device state', () => {
    const fixture = render();

    fixture.componentInstance.onPaired('MPL-7F2Q-9X');
    fixture.detectChanges();

    expect(fixture.componentInstance.pairedDeviceName()).toBe('MPL-7F2Q-9X');
    expect(fixture.componentInstance.headerTitle()).toBe('Connected');
  });
});
