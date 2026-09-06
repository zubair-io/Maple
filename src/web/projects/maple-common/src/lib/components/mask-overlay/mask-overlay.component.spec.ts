// mask-overlay.component.spec.ts — the overlay's weight-tint gate (#1541).
//
// The overlay is always mounted (the host is merely `hidden` while the Mask
// tool is disarmed) and the selected layer survives disarming, so the tint
// redraw has to be gated on `session.active()` or unrelated state changes —
// a canvas resize, a crop edit, an undo — would rasterise a tint nobody can
// see. This pins that: no `putImageData` while disarmed, one on re-arm.
//
// jsdom has neither Canvas 2D (`getContext('2d')` is null) nor
// `ResizeObserver`, so both are stubbed the way the other canvas specs in
// this library do it.

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';

import { MaskOverlayComponent } from './mask-overlay.component';
import { maskToScreen, type MaskCanvasMap } from './mask-geometry';
import { MaskSessionService } from './mask-session.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { makeLibraryStub, type LibraryStub } from '../../editor/editor-state.test-helpers';

interface Globals {
  ResizeObserver?: unknown;
}

describe('MaskOverlayComponent tint gate (#1541)', () => {
  let lib: LibraryStub & { focusedAsset: ReturnType<typeof signal> };
  let editor: EditorStateService;
  let session: MaskSessionService;
  let putImageData: ReturnType<typeof vi.fn>;
  let originalResizeObserver: unknown;

  beforeEach(() => {
    const globals = globalThis as unknown as Globals;
    originalResizeObserver = globals.ResizeObserver;
    globals.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    putImageData = vi.fn();
    const ctx = {
      clearRect: vi.fn(),
      putImageData,
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);

    const stub = makeLibraryStub();
    lib = Object.assign(stub, {
      focusedAsset: signal({ id: 'asset-1', width: 6000, height: 4000 }),
      focusedAssetId: signal('asset-1'),
    }) as typeof lib;

    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: lib },
        { provide: RawPipelineService, useValue: {} },
        {
          provide: ImageCanvasService,
          useValue: { zoomToFit: vi.fn(), nativeDimensions: signal(null) },
        },
      ],
    });
    editor = TestBed.inject(EditorStateService);
    editor.imageId.set('asset-1');
    session = TestBed.inject(MaskSessionService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as unknown as Globals).ResizeObserver = originalResizeObserver;
  });

  it('uses the current renderer orientation and rejects metadata for the previous asset', () => {
    const canvas = TestBed.inject(ImageCanvasService);
    const fixture = TestBed.createComponent(MaskOverlayComponent);
    const state = fixture.componentInstance as unknown as {
      map: () => MaskCanvasMap;
      wrapW: ReturnType<typeof signal<number>>;
      wrapH: ReturnType<typeof signal<number>>;
    };
    state.wrapW.set(600);
    state.wrapH.set(400);
    canvas.nativeDimensions.set({ w: 4000, h: 6000, sourceOrientation: 6, assetId: 'asset-1' });
    let map = state.map();
    expect(map.footprint.width / map.footprint.height).toBeCloseTo(2 / 3);
    let screen = maskToScreen(map, { x: 0.2, y: 0.3 });
    expect((screen.x - map.footprint.left) / map.footprint.width).toBeCloseTo(0.7);
    expect((screen.y - map.footprint.top) / map.footprint.height).toBeCloseTo(0.2);
    canvas.nativeDimensions.set({ w: 4000, h: 6000, sourceOrientation: 6, assetId: 'previous' });
    map = state.map();
    screen = maskToScreen(map, { x: 0.2, y: 0.3 });
    expect(map.footprint.width / map.footprint.height).toBeCloseTo(1.5);
    expect((screen.x - map.footprint.left) / map.footprint.width).toBeCloseTo(0.2);
    expect((screen.y - map.footprint.top) / map.footprint.height).toBeCloseTo(0.3);
  });

  it('rasterises nothing while the tool is disarmed, and repaints on re-arm', () => {
    // A layer exists and is selected, but the Mask tool is not armed.
    session.addLinear();
    editor.armTool('exposure');
    const fixture = TestBed.createComponent(MaskOverlayComponent);
    fixture.detectChanges();
    expect(session.selected()).not.toBeNull();
    expect(putImageData).not.toHaveBeenCalled();

    // A geometry change unrelated to masking must still rasterise nothing.
    lib.updateAdjustment('asset-1', {
      crop: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9, angle: 0 },
    });
    fixture.detectChanges();
    expect(putImageData).not.toHaveBeenCalled();

    // Arming the tool repaints immediately.
    editor.armTool('mask');
    fixture.detectChanges();
    expect(putImageData).toHaveBeenCalled();
  });
});
