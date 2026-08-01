// Continuous pixelScale zoom + gestures (#1100, spec §5.0/§5.2).
//
// Layer 1 — pure math: fit scale, settle/pinch clamps (snap-to-fit at
// fit×1.02, cap 8, mid-pinch undershoot to fit×0.5), anchored-zoom pan,
// pan clamping.
// Layer 2 — the CanvasZoomGestures controller against a fake host: pinch
// with a start-captured scale (no frame-over-frame compounding), centroid
// anchoring, snap on release, wheel routing per the §5.0 table, double-click
// fit ↔ 100%.
// Layer 3 — component wiring: Cmd/Ctrl+0/1 (bare digits stay with the S5
// tool/rating handlers), ctrl-wheel zoom consumed via preventDefault, plain
// wheel pans only when zoomed.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ImageCanvasComponent } from './image-canvas.component';
import { ImageCanvasService } from './image-canvas.service';
import {
  CanvasZoomGestures,
  clampPan,
  fitPixelScale,
  panForAnchoredZoom,
  pinchPixelScale,
  settlePixelScale,
  type ZoomGestureHost,
} from './image-canvas.zoom-gestures';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';

describe('zoom math (#1100)', () => {
  it('fitPixelScale is real px per image px at fit', () => {
    // 4000×2500 image in a 1000×726 CSS wrap at dpr 2 → min(2000/4000, 1452/2500).
    expect(fitPixelScale(4000, 2500, 1000, 726, 2)).toBeCloseTo(0.5, 5);
    // Degenerate inputs fall back to 1 (never 0/NaN).
    expect(fitPixelScale(0, 0, 1000, 726, 2)).toBe(1);
  });

  it('settlePixelScale snaps to fit below fit×1.02 and caps at 8', () => {
    const fit = 0.5;
    expect(settlePixelScale(0.509, fit)).toBe(0); // ≤ fit×1.02 → fit
    expect(settlePixelScale(0.52, fit)).toBeCloseTo(0.52, 5);
    expect(settlePixelScale(11, fit)).toBe(8); // cap
  });

  it('pinchPixelScale allows the mid-gesture undershoot to fit×0.5', () => {
    const fit = 0.5;
    expect(pinchPixelScale(0.1, fit)).toBeCloseTo(0.25, 5); // floor fit×0.5
    expect(pinchPixelScale(0.4, fit)).toBeCloseTo(0.4, 5); // below fit but above floor
    expect(pinchPixelScale(11, fit)).toBe(8);
  });

  it('panForAnchoredZoom keeps the image point under the anchor stationary', () => {
    // Image point under anchor a: p = (a − pan)/s. After the new pan, the
    // same p must project back onto a.
    const pan = { x: 10, y: -20 };
    const anchor = { x: 100, y: 50 };
    const s = 0.5;
    const s2 = 1.25;
    const p = { x: (anchor.x - pan.x) / s, y: (anchor.y - pan.y) / s };
    const pan2 = panForAnchoredZoom(pan, anchor, s, s2);
    expect(pan2.x + p.x * s2).toBeCloseTo(anchor.x, 5);
    expect(pan2.y + p.y * s2).toBeCloseTo(anchor.y, 5);
  });

  it('clampPan stops the image edges at the viewport and centers fitting axes', () => {
    // Image 3000×500 CSS in a 1000×700 wrap: x range ±1000, y centered.
    expect(clampPan({ x: 5000, y: 40 }, 3000, 500, 1000, 700)).toEqual({ x: 1000, y: 0 });
    expect(clampPan({ x: -5000, y: -40 }, 3000, 500, 1000, 700)).toEqual({ x: -1000, y: 0 });
    expect(clampPan({ x: 250, y: 0 }, 3000, 500, 1000, 700)).toEqual({ x: 250, y: 0 });
  });
});

describe('CanvasZoomGestures controller (#1100)', () => {
  // Fake host: 1000×726 CSS wrap at (0,0), dpr 2, 4000×2500 native → fit 0.5.
  let pixelScale: number;
  let pan: { x: number; y: number };
  let commits: Array<{ ps: number; pan: { x: number; y: number } }>;
  let g: CanvasZoomGestures;

  beforeEach(() => {
    pixelScale = 0;
    pan = { x: 0, y: 0 };
    commits = [];
    const host: ZoomGestureHost = {
      wrapSize: () => ({ w: 1000, h: 726 }),
      wrapRect: () =>
        ({ left: 0, top: 0, width: 1000, height: 726, right: 1000, bottom: 726 }) as DOMRect,
      nativeSize: () => ({ w: 4000, h: 2500 }),
      devicePixelRatio: () => 2,
      pixelScale: () => pixelScale,
      pan: () => pan,
      commitView: (ps, p) => {
        commits.push({ ps, pan: p });
        pixelScale = ps;
        pan = ps === 0 ? { x: 0, y: 0 } : p;
      },
      moveDivider: () => {},
    };
    g = new CanvasZoomGestures(host);
  });

  it('pinch uses a START-captured scale — no frame-over-frame compounding', () => {
    g.onPointerDown({ pointerId: 1, clientX: 400, clientY: 300 });
    g.onPointerDown({ pointerId: 2, clientX: 600, clientY: 300 }); // dist 200
    // Two moves to the SAME 2× spread: the second must not double again.
    g.onPointerMove({ pointerId: 1, clientX: 300, clientY: 300 });
    g.onPointerMove({ pointerId: 2, clientX: 700, clientY: 300 }); // dist 400 = 2×
    const after = pixelScale;
    expect(after).toBeCloseTo(0.5 * 2, 5); // fit(0.5) × magnification(2)
    g.onPointerMove({ pointerId: 2, clientX: 700, clientY: 300 }); // same spread again
    expect(pixelScale).toBeCloseTo(after, 5);
  });

  it('releasing a pinch below fit×1.02 snaps back to fit and recenters', () => {
    g.onPointerDown({ pointerId: 1, clientX: 400, clientY: 300 });
    g.onPointerDown({ pointerId: 2, clientX: 600, clientY: 300 });
    // Pinch IN slightly (0.98×): mid-gesture stays continuous (undershoot)…
    g.onPointerMove({ pointerId: 1, clientX: 402, clientY: 300 });
    expect(pixelScale).toBeGreaterThan(0);
    expect(pixelScale).toBeLessThan(0.5);
    // …and the release snaps to fit (0) with pan reset.
    g.onPointerUp({ pointerId: 1, clientX: 402, clientY: 300 });
    expect(pixelScale).toBe(0);
    expect(commits[commits.length - 1]).toEqual({ ps: 0, pan: { x: 0, y: 0 } });
  });

  it('ctrlKey wheel zooms at the cursor and is consumed', () => {
    const consumed = g.onWheel({
      ctrlKey: true,
      metaKey: false,
      deltaX: 0,
      deltaY: -100, // zoom in: ×e^1 ≈ 2.718
      clientX: 800,
      clientY: 200,
    });
    expect(consumed).toBe(true);
    expect(pixelScale).toBeCloseTo(0.5 * Math.exp(1), 3);
    // Anchored: the image point under (800, 200) stayed put. Anchor is
    // relative to the wrap center (500, 363).
    const cssBefore = 0.5 / 2;
    const cssAfter = pixelScale / 2;
    const anchor = { x: 300, y: -163 };
    const p = { x: anchor.x / cssBefore, y: anchor.y / cssBefore }; // pan was 0
    expect(pan.x + p.x * cssAfter).toBeCloseTo(anchor.x, 3);
    expect(pan.y + p.y * cssAfter).toBeCloseTo(anchor.y, 3);
  });

  it('plain wheel is NOT consumed at fit (S5 armed-tool nudge keeps it) and pans when zoomed', () => {
    const atFit = g.onWheel({
      ctrlKey: false,
      metaKey: false,
      deltaX: 0,
      deltaY: 50,
      clientX: 0,
      clientY: 0,
    });
    expect(atFit).toBe(false);
    expect(pixelScale).toBe(0);

    pixelScale = 2; // zoomed
    const zoomed = g.onWheel({
      ctrlKey: false,
      metaKey: false,
      deltaX: 30,
      deltaY: 50,
      clientX: 0,
      clientY: 0,
    });
    expect(zoomed).toBe(true);
    expect(commits[commits.length - 1].pan).toEqual({ x: -30, y: -50 });
  });

  it('double-click toggles fit ↔ 100%', () => {
    g.onDoubleClick(500, 363); // center → pan stays 0
    expect(pixelScale).toBe(1);
    g.onDoubleClick(500, 363);
    expect(pixelScale).toBe(0);
  });

  it('stepZoom steps multiplicatively and snaps to fit at the bottom', () => {
    g.stepZoom(1);
    expect(pixelScale).toBeCloseTo(0.7, 5); // fit 0.5 × 1.4
    g.stepZoom(-1);
    expect(pixelScale).toBe(0); // back to ~fit → snap
  });

  it('leaves interactive descendants in control of their pointer stream', () => {
    const wrap = document.createElement('div');
    const button = document.createElement('button');
    wrap.append(button);
    const pointerDown = vi.spyOn(g, 'onPointerDown');
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    const detach = g.attach(wrap);

    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    button.click();

    expect(pointerDown).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledOnce();
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

    const stateStub = {
      focusedAsset: focused,
      adjustmentFor: (id: AssetId) => {
        if (!models.has(id)) models.set(id, signal(defaultAdjustmentModel()));
        return models.get(id)!;
      },
      bytesFor: () => new Uint8Array([0x44, 0x4e, 0x47]),
      seedAsShotWhiteBalance: vi.fn(),
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
            deepDenoiseProgress: signal(null),
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
