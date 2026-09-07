// wb-pad.component.spec.ts — WB preset display and keyboard clamp (#3307/#2412).
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

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { WbPadComponent } from './wb-pad.component';
import { LibraryStateService } from '../../state/library-state.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import { ADJUSTMENT_RANGES } from '../../generated/adjustment-tables.generated';
import { XmpParserService } from '../../xmp/xmp-parser.service';

const ID = 'asset-wb-1';
const [TEMP_MIN, TEMP_MAX] = ADJUSTMENT_RANGES.temperature;
const [TINT_MIN, TINT_MAX] = ADJUSTMENT_RANGES.tint;

class LibraryStub {
  readonly model = signal<AdjustmentModel>(defaultAdjustmentModel());
  readonly assets = signal([{ id: ID, filename: 'test.dng' }]);
  asShotWbFor() {
    return { temperature: 6500, tint: 0 };
  }

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

describe('WbPadComponent preset display and keyboard stepping', () => {
  let pad: WbPadComponent;
  let lib: LibraryStub;
  let fixture: ComponentFixture<WbPadComponent>;

  beforeEach(() => {
    lib = new LibraryStub();
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryStateService, useValue: lib }],
    });
    fixture = TestBed.createComponent(WbPadComponent);
    pad = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows As Shot for legacy Maple Custom sidecars without changing their stored pair', () => {
    const parsed = TestBed.inject(XmpParserService).parseAdjustmentModel(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:WhiteBalance="Custom" crs:Temperature="5100" crs:Tint="-7"/></rdf:RDF></x:xmpmeta>',
    ).model;
    const model = { ...defaultAdjustmentModel(), ...parsed };
    lib.model.set(model);
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('As Shot');
    expect(pad.provenanceLabel()).toBe('As Shot');
    expect(lib.model()).toEqual(model);
    expect(lib.model()).toMatchObject({
      whiteBalancePreset: 'Custom',
      temperature: 5100,
      tint: -7,
      wbScaleVersion: 1,
    });
  });

  it('keeps authored Manual and named presets distinct from the legacy As Shot display', () => {
    for (const choice of [
      { whiteBalancePreset: 'Custom', wbSource: 'Manual', expected: 'Custom' },
      { whiteBalancePreset: 'Daylight', wbSource: 'Preset', expected: 'Daylight' },
      { whiteBalancePreset: 'Auto', wbSource: 'Auto', expected: 'Auto' },
    ] as const) {
      lib.model.update((model) => ({
        ...model,
        whiteBalancePreset: choice.whiteBalancePreset,
        wbSource: choice.wbSource,
      }));
      fixture.detectChanges();
      const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
      expect(select.value).toBe(choice.expected);
    }
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

  // Regression (review follow-up): every keyboard update writes BOTH fields
  // back, so a pre-existing out-of-range value on the NON-stepped axis must
  // be normalized by the write too — a temperature step must not re-persist
  // a bad stored tint verbatim, and vice versa.
  it('a temperature step normalizes an out-of-range stored tint', () => {
    lib.model.update((m) => ({ ...m, temperature: 6500, tint: TINT_MAX + 30 }));
    pad.onPadKeyDown(key('ArrowRight'));
    expect(lib.model().temperature).toBe(6600);
    expect(lib.model().tint).toBe(TINT_MAX);
  });

  it('a tint step normalizes an out-of-range stored temperature', () => {
    lib.model.update((m) => ({ ...m, temperature: TEMP_MAX + 3000, tint: 0 }));
    pad.onPadKeyDown(key('ArrowUp'));
    expect(lib.model().tint).toBe(1);
    expect(lib.model().temperature).toBe(TEMP_MAX);
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
