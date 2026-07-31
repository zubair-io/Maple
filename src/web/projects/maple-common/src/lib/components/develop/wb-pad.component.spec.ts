// wb-pad.component.spec.ts — WbPadComponent keyboard-stepping clamp (#2412).
//
// A production audit saw Tint reach +180 while the slider declares max
// +150 (aria-valuenow > aria-valuemax). The eyedropper path (rgbToWb) and
// the pointer-drag path (_applyPointerPos, via tempToX/tintToY which are
// themselves clamped) already stay in range — the unclamped write site was
// the ArrowLeft/Right/Up/Down keyboard stepper in onPadKeyDown, which
// applied a fixed increment to the current value with no ceiling/floor
// against ADJUSTMENT_RANGES. This mounts the real component over a
// LibraryStateService stand-in (same pattern as color-grading-panel.spec.ts)
// and drives onPadKeyDown directly, the way a real ArrowUp/ArrowDown/
// ArrowLeft/ArrowRight keydown on the pad would.

import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { WbPadComponent } from './wb-pad.component';
import { LibraryStateService } from '../../state/library-state.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import { ADJUSTMENT_RANGES } from '../../generated/adjustment-model.generated';

const ID = 'asset-wb-1';
const [TEMP_MIN, TEMP_MAX] = ADJUSTMENT_RANGES.temperature;
const [TINT_MIN, TINT_MAX] = ADJUSTMENT_RANGES.tint;

class LibraryStub {
  readonly model = signal<AdjustmentModel>(defaultAdjustmentModel());

  focusedAssetId(): string {
    return ID;
  }

  adjustmentFor(): Signal<AdjustmentModel> {
    return this.model.asReadonly();
  }

  updateAdjustment(_id: string, patch: Partial<AdjustmentModel>): void {
    this.model.update((m) => ({ ...m, ...patch }));
  }
}

function key(k: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, cancelable: true });
}

describe('WbPadComponent.onPadKeyDown clamping (#2412)', () => {
  let pad: WbPadComponent;
  let lib: LibraryStub;

  beforeEach(() => {
    lib = new LibraryStub();
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryStateService, useValue: lib }],
    });
    const fixture = TestBed.createComponent(WbPadComponent);
    pad = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('clamps tint at the +150 rail under repeated ArrowUp presses', () => {
    lib.model.update((m) => ({ ...m, tint: TINT_MAX - 1 }));
    for (let i = 0; i < 10; i++) pad.onPadKeyDown(key('ArrowUp'));
    expect(lib.model().tint).toBe(TINT_MAX);
  });

  it('a value already parked at the +150 rail stays there on further ArrowUp', () => {
    lib.model.update((m) => ({ ...m, tint: TINT_MAX }));
    pad.onPadKeyDown(key('ArrowUp'));
    expect(lib.model().tint).toBe(TINT_MAX);
  });

  it('clamps tint at the -150 rail under repeated ArrowDown presses', () => {
    lib.model.update((m) => ({ ...m, tint: TINT_MIN + 1 }));
    for (let i = 0; i < 10; i++) pad.onPadKeyDown(key('ArrowDown'));
    expect(lib.model().tint).toBe(TINT_MIN);
  });

  it('a value already parked at the -150 rail stays there on further ArrowDown', () => {
    lib.model.update((m) => ({ ...m, tint: TINT_MIN }));
    pad.onPadKeyDown(key('ArrowDown'));
    expect(lib.model().tint).toBe(TINT_MIN);
  });

  it('clamps temperature at the 12000 K rail under repeated ArrowRight presses', () => {
    lib.model.update((m) => ({ ...m, temperature: TEMP_MAX - 50 }));
    for (let i = 0; i < 10; i++) pad.onPadKeyDown(key('ArrowRight'));
    expect(lib.model().temperature).toBe(TEMP_MAX);
  });

  it('a value already parked at the 12000 K rail stays there on further ArrowRight', () => {
    lib.model.update((m) => ({ ...m, temperature: TEMP_MAX }));
    pad.onPadKeyDown(key('ArrowRight'));
    expect(lib.model().temperature).toBe(TEMP_MAX);
  });

  it('clamps temperature at the 2000 K rail under repeated ArrowLeft presses', () => {
    lib.model.update((m) => ({ ...m, temperature: TEMP_MIN + 50 }));
    for (let i = 0; i < 10; i++) pad.onPadKeyDown(key('ArrowLeft'));
    expect(lib.model().temperature).toBe(TEMP_MIN);
  });

  it('a value already parked at the 2000 K rail stays there on further ArrowLeft', () => {
    lib.model.update((m) => ({ ...m, temperature: TEMP_MIN }));
    pad.onPadKeyDown(key('ArrowLeft'));
    expect(lib.model().temperature).toBe(TEMP_MIN);
  });

  it('normal in-range stepping is unaffected by the clamp', () => {
    lib.model.update((m) => ({ ...m, temperature: 6500, tint: 0 }));
    pad.onPadKeyDown(key('ArrowRight'));
    expect(lib.model().temperature).toBe(6600);
    pad.onPadKeyDown(key('ArrowUp'));
    expect(lib.model().tint).toBe(1);
    pad.onPadKeyDown(key('ArrowLeft'));
    expect(lib.model().temperature).toBe(6500);
    pad.onPadKeyDown(key('ArrowDown'));
    expect(lib.model().tint).toBe(0);
  });

  // Regression: a value already persisted out of range (e.g. an XMP written
  // before this fix, with tint=180) must not render a raw, out-of-range
  // readout — the read-side clamp on tempLabel/tintLabel keeps the numeric
  // display consistent with the puck (which was already implicitly clamped
  // by tempToX/tintToY) and with the declared ADJUSTMENT_RANGES.
  it('clamps the readout labels for an already out-of-range stored value', () => {
    lib.model.update((m) => ({ ...m, temperature: TEMP_MAX + 3000, tint: TINT_MAX + 30 }));
    expect(pad.tempLabel()).toBe(`${TEMP_MAX} K`);
    expect(pad.tintLabel()).toBe(`+${TINT_MAX}`);

    lib.model.update((m) => ({ ...m, temperature: TEMP_MIN - 500, tint: TINT_MIN - 30 }));
    expect(pad.tempLabel()).toBe(`${TEMP_MIN} K`);
    expect(pad.tintLabel()).toBe(`${TINT_MIN}`);
  });
});
