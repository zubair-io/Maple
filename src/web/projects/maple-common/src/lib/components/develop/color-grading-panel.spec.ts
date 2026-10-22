// color-grading-panel.spec.ts — the Color Grading panel writes (#275).
//
// The wheels are only useful if they reach the AdjustmentModel, so this
// mounts the real component over a LibraryStateService stand-in and pins
// the write path: a wheel change patches BOTH the hue and the saturation
// field of its zone, the luminance sliders patch their own field, and a
// double-click reset clears the wheel without touching its neighbours.

import { TestBed } from '@angular/core/testing';
import { signal, type Signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  ColorGradingPanelComponent,
  computeZoneWeights,
  GRADE_ZONES,
} from './color-grading-panel.component';
import { EditorStateService } from '../../editor/editor-state.service';
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
      providers: [
        { provide: LibraryStateService, useValue: lib },
        { provide: EditorStateService, useValue: { commit: vi.fn(), endEdit: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(ColorGradingPanelComponent);
    panel = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('makes both edge handles focusable and supports keyboard adjustment and reset', () => {
    const fixture = TestBed.createComponent(ColorGradingPanelComponent);
    fixture.detectChanges();
    const shadow: SVGElement = fixture.nativeElement.querySelector(
      '[data-testid="color-grade-shadow-edge-handle"]',
    );
    const highlight: SVGElement = fixture.nativeElement.querySelector(
      '[data-testid="color-grade-highlight-edge-handle"]',
    );
    expect(shadow.getAttribute('tabindex')).toBe('0');
    expect(highlight.getAttribute('tabindex')).toBe('0');
    const press = (node: SVGElement, key: string) =>
      node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    press(shadow, 'ArrowLeft');
    expect(lib.model().colorGradeShadowEdge).toBeLessThan(0.564622);
    press(shadow, 'Home');
    expect(lib.model().colorGradeShadowEdge).toBe(0.1);
    press(highlight, 'End');
    expect(lib.model().colorGradeHighlightEdge).toBe(0.9);
    press(shadow, 'Delete');
    expect(lib.model().colorGradeShadowEdge).toBeCloseTo(0.564622);
  });

  it('exposes the four zones in tonal order, global last', () => {
    expect(panel.zones.map((z) => z.id)).toEqual(['shadows', 'midtones', 'highlights', 'global']);
  });

  it('records one blending transaction per drag and separate reset transactions', () => {
    const fixture = TestBed.createComponent(ColorGradingPanelComponent);
    fixture.detectChanges();
    const editor = TestBed.inject(EditorStateService);
    const slider = fixture.debugElement.query(By.css('[data-testid="color-grading-blending"]'))
      .componentInstance as MuiLivingSliderComponent;
    slider.dragStart.emit();
    slider.value.set(30);
    slider.value.set(45);
    expect(editor.commit).toHaveBeenCalledOnce();
    expect(editor.endEdit).not.toHaveBeenCalled();
    slider.dragEnd.emit();
    expect(editor.endEdit).toHaveBeenCalledOnce();
    expect(lib.model().colorGradeBlending).toBe(45);
    slider.resetRequest.emit();
    expect(editor.commit).toHaveBeenCalledTimes(2);
    expect(editor.endEdit).toHaveBeenCalledTimes(2);
    expect(lib.model().colorGradeBlending).toBe(defaultAdjustmentModel().colorGradeBlending);
    panel.onEdgeReset('shadow');
    panel.onEdgeKeyDown('highlight', new KeyboardEvent('keydown', { key: 'End' }));
    expect(editor.commit).toHaveBeenCalledTimes(4);
    expect(editor.endEdit).toHaveBeenCalledTimes(4);
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

  // Goldens shared with raw-core (`color_grade_tests.rs`) and the Windows strip.
  const ZONE_WEIGHT_GOLDENS: [number, number, number, number, number, [number, number, number]][] =
    [
      [0.05, 0, 100, 0.564622, 0.564622, [0.977863, 0.022137, 0.0]],
      [0.3, 0, 100, 0.564622, 0.564622, [0.453068, 0.546932, 0.0]],
      [0.564622, 0, 100, 0.564622, 0.564622, [0.0, 1.0, 0.0]],
      [0.8, 0, 100, 0.564622, 0.564622, [0.0, 0.439191, 0.560809]],
      [0.25, 0, 50, 0.3, 0.7, [0.20863, 0.79137, 0.0]],
      [0.65, 0, 50, 0.3, 0.7, [0.0, 1.0, 0.0]],
      [0.7, 20, 60, 0.35, 0.65, [0.0, 0.693957, 0.306043]],
      [0.15, 0, 25, 0.2, 0.75, [0.683594, 0.316406, 0.0]],
      [0.9, 0, 0, 0.3, 0.7, [0.0, 0.0, 1.0]],
      [0.5, -40, 0, 0.2, 0.8, [0.0, 1.0, 0.0]],
    ];

  it('draws the zone weights the colour-grade stage applies', () => {
    for (const [l, balance, blending, shadowEdge, highlightEdge, want] of ZONE_WEIGHT_GOLDENS) {
      const got = computeZoneWeights(l, balance, blending, shadowEdge, highlightEdge);
      got.forEach((value, i) => expect(value, `l ${l} zone ${i}`).toBeCloseTo(want[i], 4));
    }
  });

  it('writes blending and resets it to 100', () => {
    panel.onBlendingChange(40);
    expect(lib.model().colorGradeBlending).toBe(40);
    expect(panel.blending()).toBe(40);
    panel.onBlendingReset();
    expect(lib.model().colorGradeBlending).toBe(100);
  });

  it('maps a pointer position over the strip to a clamped, rounded edge pivot', () => {
    const strip = { left: 100, width: 200 };
    const svg = { getBoundingClientRect: () => strip };
    const event = (clientX: number) =>
      ({
        clientX,
        pointerId: 1,
        preventDefault: () => undefined,
        currentTarget: { closest: () => svg, setPointerCapture: () => undefined },
      }) as unknown as PointerEvent;

    panel.onEdgePointerDown('shadow', event(100 + 0.3 * 200));
    expect(lib.model().colorGradeShadowEdge).toBe(0.3);
    panel.onEdgePointerMove(event(100 + 0.95 * 200));
    expect(lib.model().colorGradeShadowEdge).toBe(0.564622);
    panel.onEdgePointerMove(event(100));
    expect(lib.model().colorGradeShadowEdge).toBe(0.1);
    panel.onEdgePointerUp();
    panel.onEdgePointerMove(event(100 + 0.4 * 200));
    expect(lib.model().colorGradeShadowEdge, 'released drag no longer moves the edge').toBe(0.1);

    panel.onEdgePointerDown('highlight', event(100 + 0.75 * 200));
    expect(lib.model().colorGradeHighlightEdge).toBe(0.75);
    panel.onEdgePointerMove(event(100 + 200));
    expect(lib.model().colorGradeHighlightEdge).toBe(0.9);
    panel.onEdgePointerMove(event(100 + 0.2 * 200));
    expect(lib.model().colorGradeHighlightEdge).toBe(0.564622);
    panel.onEdgePointerUp();

    panel.onEdgeReset('shadow');
    panel.onEdgeReset('highlight');
    expect(lib.model().colorGradeShadowEdge).toBe(0.564622);
    expect(lib.model().colorGradeHighlightEdge).toBe(0.564622);
  });
});
