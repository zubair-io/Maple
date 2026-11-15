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
        {
          provide: RawPipelineService,
          useValue: {
            currentWorkerEpoch: () => 0,
            registerBrushRaster: vi.fn().mockResolvedValue(1),
            releaseMaskRaster: vi.fn(),
          },
        },
        { provide: ImageCanvasService, useValue: { zoomToFit: vi.fn() } },
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

  it.each([
    { perspectiveX: 50, axis: 'x', outside: 0.125, inside: 0.375 },
    { perspectiveX: -50, axis: 'x', outside: 0.875, inside: 0.625 },
    { perspectiveY: 50, axis: 'y', outside: 0.125, inside: 0.375 },
    { perspectiveY: -50, axis: 'y', outside: 0.875, inside: 0.625 },
  ])('keeps the projected surround clear for $perspectiveX/$perspectiveY', (geometry) => {
    session.addRadial();
    session.setShape({
      kind: 'radial',
      center: { x: 0.5, y: 0.5 },
      radii: { x: 0.01, y: 0.01 },
      angle: 0,
      feather: 0,
      invert: true,
    });
    lib.updateAdjustment('asset-1', {
      perspectiveX: geometry.perspectiveX ?? 0,
      perspectiveY: geometry.perspectiveY ?? 0,
    });
    editor.armTool('mask');
    const fixture = TestBed.createComponent(MaskOverlayComponent);
    fixture.detectChanges();
    const image = putImageData.mock.lastCall![0] as ImageData;
    const alphaAt = (position: number): number => {
      const x = Math.floor((geometry.axis === 'x' ? position : 0.5) * image.width);
      const y = Math.floor((geometry.axis === 'y' ? position : 0.5) * image.height);
      return image.data[(y * image.width + x) * 4 + 3];
    };
    expect(alphaAt(geometry.outside)).toBe(0);
    expect(alphaAt(geometry.inside)).toBe(Math.round(0.55 * 255));
  });

  it('keeps straightened crop corners clear when geometry scales the source up', () => {
    session.add({ kind: 'everywhere' });
    lib.focusedAsset.set({ id: 'asset-1', width: 400, height: 400 });
    lib.updateAdjustment('asset-1', {
      crop: { top: 0, left: 0, bottom: 1, right: 1, angle: 10 },
      perspectiveScale: 150,
    });
    editor.armTool('mask');
    const fixture = TestBed.createComponent(MaskOverlayComponent);
    fixture.detectChanges();
    const image = putImageData.mock.lastCall![0] as ImageData;
    expect(image.data[3]).toBe(0);
    const centre = Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2);
    expect(image.data[centre * 4 + 3]).toBe(Math.round(0.55 * 255));
  });

  function mountBrush() {
    lib.focusedAsset.set({ id: 'asset-1', width: 400, height: 400 });
    lib.updateAdjustment('asset-1', {
      crop: { top: 0, left: 0, bottom: 1, right: 1, angle: 10 },
    });
    session.brush.add();
    editor.armTool('mask');
    const fixture = TestBed.createComponent(MaskOverlayComponent);
    Object.defineProperties(fixture.nativeElement, {
      clientWidth: { value: 400 },
      clientHeight: { value: 400 },
    });
    fixture.detectChanges();
    const surface = fixture.nativeElement.querySelector('[data-testid="mask-overlay"]') as Element;
    return {
      send: (type: string, x: number, y: number) =>
        surface.dispatchEvent(
          new MouseEvent(type, { clientX: x * 400, clientY: y * 400, bubbles: true }),
        ),
      dabs: () => {
        const mask = session.selectedMask();
        if (mask?.kind !== 'brush') throw new Error('Expected a selected brush');
        return mask.dabs;
      },
    };
  }

  it('does not start a brush stroke in a rejected straightened crop corner', () => {
    const brush = mountBrush();
    const begin = vi.spyOn(session, 'beginGesture');
    brush.send('pointerdown', 0.01, 0.01);
    brush.send('pointerup', 0.01, 0.01);
    expect(brush.dabs()).toEqual([]);
    expect(begin).not.toHaveBeenCalled();
  });

  it('breaks a brush segment at rejected points and restarts without bridging the gap', () => {
    const brush = mountBrush();
    brush.send('pointerdown', 0.2, 0.2);
    const count = brush.dabs().length;
    brush.send('pointermove', 0.01, 0.01);
    expect(brush.dabs()).toHaveLength(count);
    brush.send('pointermove', 0.8, 0.8);
    expect(brush.dabs()).toHaveLength(count + 1);
    brush.send('pointerup', 0.01, 0.01);
    expect(brush.dabs()).toHaveLength(count + 1);
  });

  it('stamps only the valid release point when a brush re-enters after a gap', () => {
    const brush = mountBrush();
    brush.send('pointerdown', 0.2, 0.2);
    const count = brush.dabs().length;
    brush.send('pointermove', 0.01, 0.01);
    brush.send('pointerup', 0.8, 0.8);
    expect(brush.dabs()).toHaveLength(count + 1);
  });
});
