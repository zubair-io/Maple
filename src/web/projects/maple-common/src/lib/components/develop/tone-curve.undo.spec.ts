import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorStateService } from '../../editor/editor-state.service';
import { makeLibraryStub } from '../../editor/editor-state.test-helpers';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { ColorCurvesRibbonComponent } from './color-curves-ribbon.component';
import { axisToAuthoringX } from './tone-curve-splits';
import { ToneCurveComponent } from './tone-curve.component';

const ID = 'asset-1';

describe('tone controls use the real undo ring', () => {
  let panel: ToneCurveComponent;
  let editor: EditorStateService;
  let library: ReturnType<typeof makeLibraryStub>;
  let fixture: ReturnType<typeof TestBed.createComponent<ToneCurveComponent>>;

  beforeEach(() => {
    library = makeLibraryStub();
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: { ...library, focusedAssetId: () => ID } },
        { provide: RawPipelineService, useValue: {} },
        { provide: ImageCanvasService, useValue: { currentPixels: signal(null) } },
      ],
    });
    editor = TestBed.inject(EditorStateService);
    editor.bind(ID);
    fixture = TestBed.createComponent(ToneCurveComponent);
    panel = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('places the split diamonds on the scene-linear plot and moves curve knots with keyboard undo', () => {
    const middle = fixture.nativeElement.querySelector(
      '[data-testid="tone-curve-split-midtone"]',
    ) as SVGPolygonElement;
    const plot = fixture.nativeElement.querySelector('svg') as SVGSVGElement;
    const plotWidth = Number(plot.getAttribute('viewBox')!.split(/\s+/)[2]);
    const cx = Number(middle.getAttribute('points')!.split(',')[0]);
    expect(cx / plotWidth).toBeCloseTo(0.045);
    library.updateAdjustment(ID, {
      colorCurveHueVsSat: {
        points: [
          [0.2, 0.5],
          [0.5, 0.6],
          [0.8, 0.5],
        ],
      },
    });
    const ribbonFixture = TestBed.createComponent(ColorCurvesRibbonComponent);
    const ribbon = ribbonFixture.componentInstance;
    ribbon.setMode(true);
    ribbon.selectCurve('hueVsSat');
    ribbonFixture.detectChanges();
    const knot = ribbonFixture.nativeElement.querySelector(
      '[data-testid="color-curve-knot-1"]',
    ) as HTMLButtonElement;
    expect(knot.getAttribute('role')).toBe('slider');
    knot.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }),
    );
    expect(library.adjustmentFor(ID)().colorCurveHueVsSat.points[1][1]).toBeCloseTo(0.65);
    editor.undo();
    expect(library.adjustmentFor(ID)().colorCurveHueVsSat.points[1][1]).toBeCloseTo(0.6);
    knot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(library.adjustmentFor(ID)().colorCurveHueVsSat.points[1][0]).toBeCloseTo(0.51);
    editor.undo();
    for (const [key, endpoint] of [
      ['Home', 0],
      ['End', 1],
    ] as const) {
      knot.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      expect(library.adjustmentFor(ID)().colorCurveHueVsSat.points[1][1]).toBe(endpoint);
      editor.undo();
    }
    knot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(library.adjustmentFor(ID)().colorCurveHueVsSat.points).toHaveLength(2);
    editor.undo();
    expect(library.adjustmentFor(ID)().colorCurveHueVsSat.points).toHaveLength(3);
    ribbonFixture.destroy();
  });

  it('undoes mode selection, split nudging and reset as discrete actions', () => {
    panel.selectMode({ id: 'RatioPreserving', label: 'Ratio-Preserving' });
    expect(library.adjustmentFor(ID)().toneCurveMode).toBe('RatioPreserving');
    editor.undo();
    expect(library.adjustmentFor(ID)().toneCurveMode).toBe('PerChannel');
    panel.onSplitKeyDown('shadow', new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(26);
    editor.undo();
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(25);
    library.updateAdjustment(ID, { parametricShadowSplit: 15, parametricHighlightSplit: 85 });
    panel.resetSplits();
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(25);
    editor.undo();
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(15);
    expect(library.adjustmentFor(ID)().parametricHighlightSplit).toBe(85);
    panel.onSplitDoubleClick('shadow', new MouseEvent('dblclick'));
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(25);
    editor.undo();
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(15);
  });

  it('keeps split movement in one gesture and closes it on cancellation or destruction', () => {
    const plot = fixture.nativeElement.querySelector(
      '[data-testid="tone-curve-plot"]',
    ) as SVGSVGElement;
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;
    panel.onSplitPointerDown('shadow', new PointerEvent('pointerdown', { button: 0 }));
    for (const axis of [30, 20])
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: axisToAuthoringX(axis) * 200 }),
      );
    window.dispatchEvent(new PointerEvent('pointercancel'));
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(editor.undoHistory()).toHaveLength(1);
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(20);
    editor.undo();
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(25);
    panel.onSplitPointerDown('shadow', new PointerEvent('pointerdown', { button: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: axisToAuthoringX(15) * 200 }));
    fixture.destroy();
    expect(editor.undoHistory()).toHaveLength(1);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: axisToAuthoringX(20) * 200 }));
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(15);
    editor.undo();
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(25);
  });
});
