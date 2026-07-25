// color-grading-panel.spec.ts — the Color Grading panel writes (#275).
//
// The wheels are only useful if they reach the AdjustmentModel, so this
// mounts the real component over a LibraryStateService stand-in and pins
// the write path: a wheel change patches BOTH the hue and the saturation
// field of its zone, the luminance sliders patch their own field, and a
// double-click reset clears the wheel without touching its neighbours.

import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { ColorGradingPanelComponent, GRADE_ZONES } from './color-grading-panel.component';
import { LibraryStateService } from '../../state/library-state.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

const ID = 'asset-grade-1';

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

describe('ColorGradingPanelComponent (#275)', () => {
  let panel: ColorGradingPanelComponent;
  let lib: LibraryStub;

  beforeEach(() => {
    lib = new LibraryStub();
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryStateService, useValue: lib }],
    });
    const fixture = TestBed.createComponent(ColorGradingPanelComponent);
    panel = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('exposes the four zones in tonal order, global last', () => {
    expect(panel.zones.map((z) => z.id)).toEqual(['shadows', 'midtones', 'highlights', 'global']);
  });

  it('writes hue AND saturation for the zone a wheel change came from', () => {
    for (const zone of GRADE_ZONES) {
      panel.onWheelChange(zone, { hue: 123, saturation: 45 });
      const model = lib.model();
      expect(model[zone.hue], `${zone.id} hue`).toBe(123);
      expect(model[zone.saturation], `${zone.id} saturation`).toBe(45);
    }
  });

  it('writes each zone luminance independently and resets only that zone', () => {
    const [shadows, midtones] = GRADE_ZONES;
    panel.onLuminanceChange(shadows, 40);
    panel.onLuminanceChange(midtones, -25);
    expect(lib.model()[shadows.luminance]).toBe(40);
    expect(lib.model()[midtones.luminance]).toBe(-25);

    panel.onLuminanceReset(shadows);
    expect(lib.model()[shadows.luminance]).toBe(0);
    expect(lib.model()[midtones.luminance]).toBe(-25);
  });

  it('drives the balance off the split-toning field ACR shares with this panel', () => {
    panel.onBalanceChange(-40);
    expect(lib.model().splitToneBalance).toBe(-40);
    expect(panel.balance()).toBe(-40);
    panel.onBalanceReset();
    expect(lib.model().splitToneBalance).toBe(0);
  });

  it('reads back the values it wrote, so the pucks follow the model', () => {
    const global = GRADE_ZONES[3];
    panel.onWheelChange(global, { hue: 300, saturation: 18 });
    expect(panel.valueOf(global.hue)).toBe(300);
    expect(panel.valueOf(global.saturation)).toBe(18);
  });
});
