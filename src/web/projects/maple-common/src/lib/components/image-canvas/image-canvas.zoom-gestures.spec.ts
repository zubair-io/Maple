// Gesture recognition over the shared Rust zoom model (#1100, #5714; spec
// §5.0/§5.2, docs/zoom.md). The model's own rules are pinned by the Rust
// tests in raw-core `canvas`; these specs run the real `raw_wasm_canvas` module and
// check that each DOM gesture reaches the right transition with the right
// coordinates, and that what the model returns is committed.
//
// Layer 1 — the CanvasZoomGestures controller against a fake host.
// Layer 2 — component wiring: Cmd/Ctrl+0/1 (bare digits stay with the S5
// tool/rating handlers), ctrl-wheel zoom consumed via preventDefault, plain
// wheel at fit left alone, double-click through the template.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

import * as rawWasm from '../../raw-pipeline/pkg/canvas/raw_wasm_canvas';
import { ImageCanvasComponent } from './image-canvas.component';
import { ImageCanvasService } from './image-canvas.service';
import { CanvasZoomGestures, type ZoomGestureHost } from './image-canvas.zoom-gestures';
import { installCanvasZoomWasm } from './image-canvas.zoom-wasm';
import { LibraryStateService } from '../../state/library-state.service';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';

beforeAll(() => {
  const output = rawWasm.initSync({
    module: readFileSync(
      resolve(
        process.cwd(),
        'projects/maple-common/src/lib/raw-pipeline/pkg/canvas/raw_wasm_canvas_bg.wasm',
      ),
    ),
  });
  installCanvasZoomWasm(rawWasm, output.memory);
});

describe('CanvasZoomGestures over the shared model', () => {
  // 1000×726 CSS wrap at (0,0), dpr 2, 4000×2500 native: fit 0.5, fill 0.5808.
  const FIT = 0.5;
  const FILL = 1452 / 2500;
  let wrap: { w: number; h: number };
  let pixelScale: number;
  let pan: { x: number; y: number };
  let commits: Array<{ ps: number; pan: { x: number; y: number } }>;
  let g: CanvasZoomGestures;
  /** Stands in for the host's signals: bumped on every write to the view below. */
  const writes = signal(0);
  const touched = (): void => writes.update((n) => n + 1);

  beforeEach(() => {
    wrap = { w: 1000, h: 726 };
    pixelScale = 0;
    pan = { x: 0, y: 0 };
    commits = [];
    const host: ZoomGestureHost = {
      wrapSize: () => (writes(), wrap),
      wrapRect: () =>
        ({
          left: 0,
          top: 0,
          width: wrap.w,
          height: wrap.h,
          right: wrap.w,
          bottom: wrap.h,
        }) as DOMRect,
      nativeSize: () => ({ w: 4000, h: 2500 }),
      devicePixelRatio: () => 2,
      pixelScale: () => (writes(), pixelScale),
      pan: () => (writes(), pan),
      commitView: (ps, p) => {
        commits.push({ ps, pan: p });
        pixelScale = ps;
        pan = p;
        touched();
      },
      moveDivider: () => {},
    };
    g = new CanvasZoomGestures(host);
  });

  /** A horizontal two-pointer pinch about the viewport centre. */
  function pinch(fromSpread: number, toSpread: number, release = true): void {
    const cx = 500;
    const cy = 363;
    g.onPointerDown({ pointerId: 1, clientX: cx - fromSpread / 2, clientY: cy });
    g.onPointerDown({ pointerId: 2, clientX: cx + fromSpread / 2, clientY: cy });
    g.onPointerMove({ pointerId: 1, clientX: cx - toSpread / 2, clientY: cy });
    g.onPointerMove({ pointerId: 2, clientX: cx + toSpread / 2, clientY: cy });
    if (!release) return;
    g.onPointerUp({ pointerId: 1, clientX: cx - toSpread / 2, clientY: cy });
    g.onPointerUp({ pointerId: 2, clientX: cx + toSpread / 2, clientY: cy });
  }

  it('pinch derives every frame from the start capture — no compounding', () => {
    pinch(200, 400, false);
    expect(pixelScale).toBeCloseTo(FIT * 2, 9);
    g.onPointerMove({ pointerId: 2, clientX: 800, clientY: 363 });
    expect(pixelScale).toBeCloseTo(FIT * 2.5, 9);
  });

  it('a pinch released inside the fit band settles on fit and recentres', () => {
    pinch(200, 197);
    expect(pixelScale).toBe(0);
    expect(pan).toEqual({ x: 0, y: 0 });
  });

  it('a pinch below fit follows the fingers down to the half-fit floor and releases to fit', () => {
    pinch(200, 140, false);
    expect(pixelScale).toBeCloseTo(FIT * 0.7, 9);
    g.onPointerMove({ pointerId: 2, clientX: 510, clientY: 363 });
    expect(pixelScale).toBeCloseTo(FIT * 0.5, 9);
    g.onPointerUp({ pointerId: 1, clientX: 490, clientY: 363 });
    g.onPointerUp({ pointerId: 2, clientX: 510, clientY: 363 });
    expect(pixelScale).toBe(0);
    expect(pan).toEqual({ x: 0, y: 0 });
  });

  it('a pinch released inside the fill band settles on fill, which follows a resize', () => {
    pinch(200, 230);
    expect(pixelScale).toBeCloseTo(FILL, 9);
    wrap = { w: 726, h: 1000 };
    touched();
    g.reclamp();
    expect(pixelScale).toBeCloseTo(2000 / 2500, 9);
  });

  it('the pinch keeps the image point under the start centroid under the live one', () => {
    g.onPointerDown({ pointerId: 1, clientX: 700, clientY: 200 });
    g.onPointerDown({ pointerId: 2, clientX: 900, clientY: 200 });
    g.onPointerMove({ pointerId: 1, clientX: 600, clientY: 200 });
    const start = { x: 800 - 500, y: 200 - 363 };
    const image = { x: start.x / (FIT / 2), y: start.y / (FIT / 2) };
    expect(pixelScale).toBeCloseTo(FIT * 1.5, 9);
    expect(pan.x + image.x * (pixelScale / 2)).toBeCloseTo(750 - 500, 6);
    expect(pan.y + image.y * (pixelScale / 2)).toBeCloseTo(start.y, 6);
  });

  it('one-pointer drag pans while the image overflows and is left alone at fit', () => {
    g.onPointerDown({ pointerId: 1, clientX: 100, clientY: 100 });
    g.onPointerMove({ pointerId: 1, clientX: 140, clientY: 120 });
    g.onPointerUp({ pointerId: 1, clientX: 140, clientY: 120 });
    expect(commits).toEqual([]);

    pixelScale = 2;
    touched();
    g.onPointerDown({ pointerId: 1, clientX: 100, clientY: 100 });
    g.onPointerMove({ pointerId: 1, clientX: 140, clientY: 120 });
    expect(pan).toEqual({ x: 40, y: 20 });
    g.onPointerUp({ pointerId: 1, clientX: 140, clientY: 120 });
    g.onPointerDown({ pointerId: 1, clientX: 0, clientY: 0 });
    g.onPointerMove({ pointerId: 1, clientX: 10, clientY: 0 });
    expect(pan).toEqual({ x: 50, y: 20 });
  });

  it('ctrlKey wheel zooms at the cursor and is consumed', () => {
    const consumed = g.onWheel({
      ctrlKey: true,
      metaKey: false,
      deltaX: 0,
      deltaY: -100,
      clientX: 800,
      clientY: 200,
    });
    expect(consumed).toBe(true);
    expect(pixelScale).toBeCloseTo(FIT * Math.pow(2, 100 * 0.015), 9);
    const anchor = { x: 300, y: -163 };
    const image = { x: anchor.x / (FIT / 2), y: anchor.y / (FIT / 2) };
    expect(pan.x + image.x * (pixelScale / 2)).toBeCloseTo(anchor.x, 6);
    expect(pan.y + image.y * (pixelScale / 2)).toBeCloseTo(anchor.y, 6);
  });

  it('plain wheel pans only while the image overflows; otherwise the tool nudge keeps it', () => {
    const wheel = {
      ctrlKey: false,
      metaKey: false,
      deltaX: 30,
      deltaY: 50,
      clientX: 0,
      clientY: 0,
    };
    expect(g.onWheel(wheel)).toBe(false);
    expect(pixelScale).toBe(0);

    g.stepZoom(-1);
    expect(pixelScale).toBeLessThan(FIT);
    expect(g.onWheel(wheel)).toBe(false);

    pixelScale = 2;
    pan = { x: 0, y: 0 };
    touched();
    expect(g.onWheel(wheel)).toBe(true);
    expect(pan).toEqual({ x: -30, y: -50 });
  });

  it('drag and wheel stay with the editor at fit and below, and pan once the image overflows', () => {
    expect(g.pointerEditsAtZoom()).toBe(true);
    g.stepZoom(-1);
    expect(g.pointerEditsAtZoom()).toBe(true);
    g.stepZoom(1);
    g.stepZoom(1);
    expect(pixelScale).toBeGreaterThan(FIT);
    expect(g.pointerEditsAtZoom()).toBe(false);
  });

  it('a third finger taking over the pinch re-measures from the reached zoom instead of jumping', () => {
    g.onPointerDown({ pointerId: 1, clientX: 400, clientY: 363 });
    g.onPointerDown({ pointerId: 2, clientX: 600, clientY: 363 });
    g.onPointerMove({ pointerId: 2, clientX: 800, clientY: 363 });
    const reached = pixelScale;
    expect(reached).toBeCloseTo(FIT * 2, 9);
    g.onPointerDown({ pointerId: 3, clientX: 900, clientY: 363 });
    g.onPointerUp({ pointerId: 1, clientX: 400, clientY: 363 });
    expect(pixelScale).toBeCloseTo(reached, 9);
    g.onPointerMove({ pointerId: 3, clientX: 1000, clientY: 363 });
    expect(pixelScale).toBeCloseTo(reached * 2, 9);
  });

  it("the badge's next stop follows a pinch that settles on fill", () => {
    expect(g.nextBadgeStop()).toBe(rawWasm.CanvasZoomStop.Fill);
    pinch(200, 230);
    expect(g.nextBadgeStop()).toBe(rawWasm.CanvasZoomStop.ActualSize);
  });

  it('a chord wheel with no vertical delta is consumed without leaving fit', () => {
    const swipe = { ctrlKey: true, metaKey: false, deltaX: 40, deltaY: 0, clientX: 0, clientY: 0 };
    expect(g.onWheel(swipe)).toBe(true);
    expect(commits).toEqual([]);
    expect(pixelScale).toBe(0);
  });

  it('double-click toggles fit ↔ 100%', () => {
    g.onDoubleClick(500, 363);
    expect(pixelScale).toBe(1);
    g.onDoubleClick(500, 363);
    expect(pixelScale).toBe(0);
  });

  it('steps by 1.25×, settles on fit from above, and continues below fit', () => {
    g.stepZoom(1);
    expect(pixelScale).toBeCloseTo(FIT * 1.25, 9);
    g.stepZoom(-1);
    expect(pixelScale).toBe(0);
    g.stepZoom(-1);
    expect(pixelScale).toBeCloseTo(FIT / 1.25, 9);
  });

  it('the badge cycles fit → fill → 100% → fit', () => {
    expect(g.nextBadgeStop()).toBe(rawWasm.CanvasZoomStop.Fill);
    g.advanceStop();
    expect(pixelScale).toBeCloseTo(FILL, 9);
    expect(g.nextBadgeStop()).toBe(rawWasm.CanvasZoomStop.ActualSize);
    g.advanceStop();
    expect(pixelScale).toBe(1);
    g.advanceStop();
    expect(pixelScale).toBe(0);
  });

  it('adopts a zoom written outside the model', () => {
    g.stepZoom(1);
    pixelScale = 0;
    pan = { x: 0, y: 0 };
    touched();
    g.stepZoom(1);
    expect(pixelScale).toBeCloseTo(FIT * 1.25, 9);
  });

  it('reports the effective zoom as a percent', () => {
    expect(g.zoomPercent()).toBe('50%');
    g.onDoubleClick(500, 363);
    expect(g.zoomPercent()).toBe('100%');
  });

  // #5745: an outer layer that took the capture kept the canvas from ever
  // seeing pointer 1's release; a later finger then pinched against it.
  it('a pointer whose capture was lost stops counting, so a later one-finger drag pans', () => {
    g.onPointerDown({ pointerId: 1, clientX: 100, clientY: 100 });
    g.onLostPointerCapture({ pointerId: 1, clientX: 100, clientY: 100 });
    pixelScale = 2;
    touched();
    g.onPointerDown({ pointerId: 2, clientX: 300, clientY: 100 });
    g.onPointerMove({ pointerId: 2, clientX: 500, clientY: 100 });
    expect(pixelScale).toBe(2);
    expect(pan).toEqual({ x: 200, y: 0 });
  });

  it('losing the capture mid-pinch ends the pinch', () => {
    pinch(200, 400, false);
    const reached = pixelScale;
    g.onLostPointerCapture({ pointerId: 1, clientX: 400, clientY: 363 });
    g.onPointerMove({ pointerId: 2, clientX: 900, clientY: 363 });
    expect(pixelScale).toBeCloseTo(reached, 9);
  });

  it('a fresh primary press drops pointers whose release never arrived', () => {
    g.onPointerDown({ pointerId: 1, clientX: 100, clientY: 100, isPrimary: true });
    pixelScale = 2;
    touched();
    g.onPointerDown({ pointerId: 2, clientX: 300, clientY: 100, isPrimary: true });
    g.onPointerMove({ pointerId: 2, clientX: 500, clientY: 100, isPrimary: true });
    expect(pixelScale).toBe(2);
    expect(pan).toEqual({ x: 200, y: 0 });
  });

  it('a fresh primary pen press leaves a live touch pinch alone', () => {
    const touch = { pointerType: 'touch' };
    g.onPointerDown({ pointerId: 1, clientX: 400, clientY: 363, isPrimary: true, ...touch });
    g.onPointerDown({ pointerId: 2, clientX: 600, clientY: 363, isPrimary: false, ...touch });
    g.onPointerDown({
      pointerId: 9,
      clientX: 50,
      clientY: 50,
      isPrimary: true,
      pointerType: 'pen',
    });
    g.onPointerMove({ pointerId: 2, clientX: 800, clientY: 363, ...touch });
    expect(pixelScale).toBeCloseTo(FIT * 2, 9);
  });

  it('a press a descendant already took (a crop or mask handle) stays with it', () => {
    const el = document.createElement('div');
    const handle = document.createElement('div');
    el.append(handle);
    const capture = vi.fn();
    el.setPointerCapture = capture;
    handle.addEventListener('pointerdown', (e) => e.preventDefault());
    const pointerDown = vi.spyOn(g, 'onPointerDown');
    const detach = g.attach(el);

    handle.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
    );

    expect(capture).not.toHaveBeenCalled();
    expect(pointerDown).not.toHaveBeenCalled();
    detach();
  });

  it('a lostpointercapture event on the wrap releases that pointer', () => {
    const el = document.createElement('div');
    const detach = g.attach(el);
    const lost = vi.spyOn(g, 'onLostPointerCapture');
    const event = new MouseEvent('lostpointercapture', { bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: 4 });
    el.dispatchEvent(event);
    expect(lost).toHaveBeenCalledOnce();
    detach();
  });

  it('leaves interactive descendants in control of their pointer stream', () => {
    const el = document.createElement('div');
    const button = document.createElement('button');
    el.append(button);
    const pointerDown = vi.spyOn(g, 'onPointerDown');
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    const detach = g.attach(el);

    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    button.click();

    expect(pointerDown).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledOnce();
    detach();
  });
});

describe('pointer ownership by marked descendants', () => {
  it('does not capture the pointer for a [data-owns-pointer] descendant, so its click is not retargeted', () => {
    const host = {} as ZoomGestureHost;
    const g = new CanvasZoomGestures(host);
    const wrap = document.createElement('div');
    const overlay = document.createElement('div');
    overlay.setAttribute('data-owns-pointer', '');
    wrap.append(overlay);
    const capture = vi.fn();
    wrap.setPointerCapture = capture;
    const pointerDown = vi.spyOn(g, 'onPointerDown').mockImplementation(() => undefined);
    const detach = g.attach(wrap);

    overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(capture).not.toHaveBeenCalled();
    expect(pointerDown).not.toHaveBeenCalled();

    wrap.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(capture).toHaveBeenCalledOnce();
    detach();
  });
});

describe('ImageCanvasComponent zoom wiring (#1100)', () => {
  let focused: WritableSignal<Asset | null>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let canvasSvc: ImageCanvasService;
  let fixture: ComponentFixture<ImageCanvasComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = signal<Asset | null>(null);
    models = new Map();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as unknown as { ImageData: unknown }).ImageData = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    };
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(() =>
      Promise.resolve({ close: vi.fn() } as unknown as ImageBitmap),
    );

    const capabilities = new LensCorrectionCapabilities();
    const stateStub = {
      focusedAsset: focused,
      adjustmentFor: (id: AssetId) => {
        if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
        return models.get(id)!;
      },
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      seedAsShotWhiteBalance: vi.fn(),
      resetAutoFit: capabilities.resetAutoFit.bind(capabilities),
      seedLensCorrections: capabilities.seed.bind(capabilities),
      autoFitRevisionFor: capabilities.autoFitRevisionFor.bind(capabilities),
      seedLensProfile: capabilities.seedProfile.bind(capabilities),
      lensCorrectionsFor: (id: string) => capabilities.for(id),
      updateAssetDimensions: vi.fn(),
      openDownloadProgress: signal(null),
    } as unknown as Partial<LibraryStateService>;

    TestBed.configureTestingModule({
      imports: [ImageCanvasComponent],
      providers: [
        XmpSerializerService,
        { provide: LibraryStateService, useValue: stateStub },
        {
          provide: RawPipelineService,
          useValue: {
            // #1153: the canvas template reads the deep-denoise progress signal.
            closeNativeDetail: vi.fn(),
            deepDenoiseProgress: signal(null),
            scopeSample: signal(null),
            decode: vi.fn((_b: Uint8Array, _e: string, _x: string | undefined, mle: number) =>
              Promise.resolve({
                width: Math.min(mle, 4000),
                height: Math.round((Math.min(mle, 4000) * 2500) / 4000),
                nativeWidth: 4000,
                nativeHeight: 2500,
                rgb: new Uint8Array([0x80, 0x80, 0x80]),
                asShotTemperature: 5200,
                asShotTint: 0,
              }),
            ),
          },
        },
      ],
    });
    canvasSvc = TestBed.inject(ImageCanvasService);
    fixture = TestBed.createComponent(ImageCanvasComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  async function settle(ms = 0): Promise<void> {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
  }

  it('Cmd/Ctrl+1 → 100%, Cmd/Ctrl+0 → fit; bare digits are left alone', async () => {
    focused.set(fakeAsset('a'));
    await settle(200);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true }));
    expect(canvasSvc.pixelScale()).toBe(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true }));
    expect(canvasSvc.pixelScale()).toBe(0);

    // Bare 1 must NOT zoom (S5/editor-shell rating/tool keys own it).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
    expect(canvasSvc.pixelScale()).toBe(0);
  });

  it('ctrlKey wheel (trackpad pinch) zooms and is preventDefault-ed; plain wheel at fit is not', async () => {
    focused.set(fakeAsset('a'));
    await settle(200);
    const wrap = fixture.nativeElement.querySelector('.canvas-wrap') as HTMLElement;

    const pinch = new WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: -100,
      cancelable: true,
      bubbles: true,
    });
    wrap.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    expect(canvasSvc.pixelScale()).toBeGreaterThan(0);

    canvasSvc.zoomToFit();
    const plain = new WheelEvent('wheel', { deltaY: 50, cancelable: true, bubbles: true });
    wrap.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(canvasSvc.pixelScale()).toBe(0);
  });

  it('double-click toggles fit ↔ 100% through the template binding', async () => {
    focused.set(fakeAsset('a'));
    await settle(200);
    const wrap = fixture.nativeElement.querySelector('.canvas-wrap') as HTMLElement;

    wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 }));
    expect(canvasSvc.pixelScale()).toBe(1);
    wrap.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 }));
    expect(canvasSvc.pixelScale()).toBe(0);
  });

  function fakeAsset(id: AssetId): Asset {
    return { id, filename: `${id}.dng` } as Asset;
  }
});
