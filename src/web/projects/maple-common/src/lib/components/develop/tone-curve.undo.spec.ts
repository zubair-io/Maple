import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorStateService } from '../../editor/editor-state.service';
import { makeLibraryStub } from '../../editor/editor-state.test-helpers';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
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
    for (const x of [30, 40]) window.dispatchEvent(new PointerEvent('pointermove', { clientX: x }));
    window.dispatchEvent(new PointerEvent('pointercancel'));
    window.dispatchEvent(new PointerEvent('pointerup'));
    expect(editor.undoHistory()).toHaveLength(1);
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(20);
    editor.undo();
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(25);
    panel.onSplitPointerDown('shadow', new PointerEvent('pointerdown', { button: 0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 30 }));
    fixture.destroy();
    expect(editor.undoHistory()).toHaveLength(1);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40 }));
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(15);
    editor.undo();
    expect(library.adjustmentFor(ID)().parametricShadowSplit).toBe(25);
  });
});
