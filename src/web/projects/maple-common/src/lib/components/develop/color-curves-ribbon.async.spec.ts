import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ColorCurvesRibbonComponent } from './color-curves-ribbon.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { CanvasPickService } from '../image-canvas/canvas-pick.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

class LibraryStub {
  readonly focusedAssetId = signal('first');
  readonly model = signal(defaultAdjustmentModel());
  readonly assets = signal([{ id: 'first', filename: 'first.dng', width: 2000, height: 1000 }]);
  readonly updateAdjustment = vi.fn((_id: string, patch: Partial<AdjustmentModel>) => {
    this.model.update((model) => ({ ...model, ...patch }));
  });
  adjustmentFor() {
    return this.model;
  }
  bytesFor() {
    return new Uint8Array([1]);
  }
}

const sample = { uH: 0.7, uC: 0.4, uL: 0.6, l: 0.65, c: 0.128, hueDeg: 252 };

describe('color-curve asynchronous picks and visible knot drags', () => {
  let library: LibraryStub;
  let fixture: ReturnType<typeof TestBed.createComponent<ColorCurvesRibbonComponent>>;
  let panel: ColorCurvesRibbonComponent;
  let pick: CanvasPickService;
  let result: { promise: Promise<typeof sample>; resolve: (value: typeof sample) => void };
  let sampleColorCurve: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    library = new LibraryStub();
    let resolve!: (value: typeof sample) => void;
    const promise = new Promise<typeof sample>((done) => {
      resolve = done;
    });
    result = { promise, resolve };
    sampleColorCurve = vi.fn(() => result.promise);
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: library },
        { provide: RawPipelineService, useValue: { sampleColorCurve } },
        { provide: EditorStateService, useValue: { commit: vi.fn(), endEdit: vi.fn() } },
      ],
    });
    fixture = TestBed.createComponent(ColorCurvesRibbonComponent);
    panel = fixture.componentInstance;
    pick = TestBed.inject(CanvasPickService);
    fixture.detectChanges();
    panel.setMode(true);
  });

  for (const change of ['curve', 'asset', 'edit'] as const) {
    it(`discards a sample when the ${change} changes while RAW sampling waits`, async () => {
      const sampling = panel.onEyedropperClick();
      pick.resolve({ nx: 0.3, ny: 0.4 });
      await Promise.resolve();
      expect(sampleColorCurve).toHaveBeenCalledOnce();
      if (change === 'curve') panel.selectCurve('satVsSat');
      if (change === 'asset') library.focusedAssetId.set('second');
      if (change === 'edit')
        library.model.update((model) => ({
          ...model,
          colorCurveHueVsHue: { points: [[0.2, 0.6]] },
        }));
      fixture.detectChanges();
      result.resolve(sample);
      await sampling;
      expect(library.updateAdjustment).not.toHaveBeenCalled();
      expect(panel.eyedropperActive()).toBe(false);
      if (change === 'edit')
        expect(panel.sampleMessage()).toBe('The photo changed. Pick the colour again.');
    });
  }

  it('keeps a valid sample when camera hydration only seeds As Shot slider numbers', async () => {
    const sampling = panel.onEyedropperClick();
    pick.resolve({ nx: 0.3, ny: 0.4 });
    await Promise.resolve();
    library.model.update((model) => ({ ...model, temperature: 5800, tint: 14 }));
    result.resolve(sample);
    await sampling;
    expect(library.model().colorCurveHueVsHue.points).toContainEqual([0.7, 0.5]);
    expect(library.model().temperature).toBe(5800);
    expect(library.model().tint).toBe(14);
    expect(panel.sampleMessage()).toBeNull();
  });

  it('inserts an anchor into the captured curve when its request remains current', async () => {
    const sampling = panel.onEyedropperClick();
    pick.resolve({ nx: 0.3, ny: 0.4 });
    await Promise.resolve();
    result.resolve(sample);
    await sampling;
    expect(library.model().colorCurveHueVsHue.points).toHaveLength(3);
    expect(library.model().colorCurveHueVsHue.points).toContainEqual([0.7, 0.5]);
    expect(panel.eyedropperActive()).toBe(false);
  });

  it('maps a cropped and straightened pick to the full-frame sampler coordinates', async () => {
    library.model.update((model) => ({
      ...model,
      crop: { ...model.crop, left: 0.25, right: 0.75, top: 0.2, bottom: 0.8, angle: 30 },
    }));
    const sampling = panel.onEyedropperClick();
    pick.resolve({ nx: 0.2, ny: 0.4 });
    await Promise.resolve();
    // Crop point is (700,440); undo the 30-degree rotation around (1000,500).
    const expectedX = (1000 - 300 * Math.cos(Math.PI / 6) - 60 * Math.sin(Math.PI / 6)) / 2000;
    const expectedY = (500 + 300 * Math.sin(Math.PI / 6) - 60 * Math.cos(Math.PI / 6)) / 1000;
    expect(sampleColorCurve.mock.calls[0][3]).toBeCloseTo(expectedX);
    expect(sampleColorCurve.mock.calls[0][4]).toBeCloseTo(expectedY);
    result.resolve(sample);
    await sampling;
  });

  for (const ending of ['pointerup', 'pointercancel']) {
    it(`keeps knot drag ownership through unrelated pointers until owner ${ending}`, () => {
      panel.selectCurve('hueVsSat');
      library.model.update((model) => ({
        ...model,
        colorCurveHueVsSat: { points: [[0.25, 0.65]] },
      }));
      fixture.detectChanges();
      const svg = fixture.nativeElement.querySelector('svg') as SVGSVGElement;
      vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      } as DOMRect);
      const knot = fixture.nativeElement.querySelector('.knot-handle') as HTMLButtonElement;
      const editor = TestBed.inject(EditorStateService);
      const touch = (type: string, pointerId: number, x = 25, y = 35) =>
        new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          button: 0,
          bubbles: true,
          clientX: x,
          clientY: y,
        });
      knot.dispatchEvent(touch('pointerdown', 7));
      try {
        knot.dispatchEvent(touch('pointerdown', 9, 80, 10));
        window.dispatchEvent(touch('pointermove', 9, 80, 10));
        window.dispatchEvent(touch('pointerup', 9));
        window.dispatchEvent(touch('pointercancel', 9));
        expect(library.model().colorCurveHueVsSat.points).toEqual([[0.25, 0.65]]);
        expect(editor.commit).toHaveBeenCalledOnce();
        expect(editor.endEdit).not.toHaveBeenCalled();
        window.dispatchEvent(touch('pointermove', 7, 50, 30));
        expect(library.model().colorCurveHueVsSat.points).toEqual([[0.5, 0.7]]);
        window.dispatchEvent(touch(ending, 7));
        expect(editor.endEdit).toHaveBeenCalledOnce();
        window.dispatchEvent(touch('pointermove', 7, 80, 10));
        expect(library.model().colorCurveHueVsSat.points).toEqual([[0.5, 0.7]]);
      } finally {
        window.dispatchEvent(touch('pointerup', 7));
        window.dispatchEvent(touch('pointerup', 9));
      }
    });
  }

  it('drags a knot by pressing its visible button', () => {
    panel.selectCurve('hueVsSat');
    library.model.update((model) => ({ ...model, colorCurveHueVsSat: { points: [[0.25, 0.65]] } }));
    fixture.detectChanges();
    const svg = fixture.nativeElement.querySelector('svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    } as DOMRect);
    const knot = fixture.nativeElement.querySelector('.knot-handle') as HTMLButtonElement;
    knot.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 25, clientY: 35 }),
    );
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 30 }));
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(library.model().colorCurveHueVsSat.points).toEqual([[0.5, 0.7]]);
  });
});
