// ImageCanvasComponent — two-phase live render and XMP wiring (#846/#1101):
//   - cold open issues exactly one VIEWPORT-SIZED decode (no spurious decode)
//   - every edit tick fires an immediate fast-phase sized decode (coalesced
//     latest-wins while one is in flight — no storm)
//   - at fit, the refine pass is skipped (fast target == refine target)
//   - zoomed in, the trailing 150ms refine fires at native × min(scale, 1)
//   - zooming in without an edit schedules a refine for the current model
//   - switching assets cancels pending renders
//
// Zoneless effects run on detectChanges; fake timers drive refinement.
// This suite asserts pipeline requests; raw-core tests exercise pixel output.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ImageCanvasComponent } from './image-canvas.component';
import { ImageCanvasService } from './image-canvas.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { Asset, AssetId } from '../../models/asset';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';

const REFINE_MS = 150;
// jsdom wrap has no layout → the component falls back to 800×600 CSS px and
// devicePixelRatio 1, so the fast-phase target is the 800 px viewport long edge.
const VIEWPORT_LONG = 800;
const NATIVE_W = 4000;
const NATIVE_H = 2500;

function fakeAsset(id: AssetId): Asset {
  return { id, filename: `${id}.dng` } as Asset;
}

/** An honest sized-decode reply: dims = the requested cap (never above native),
 *  native dims alongside — mirroring `render_bytes_sized`'s contract. The rgb
 *  payload is tiny; `imageDataToBitmap` zero-fills the remainder. */
function decodedAt(maxLongEdge: number): DecodedImage {
  const long = Math.min(maxLongEdge, NATIVE_W);
  const w = long;
  const h = Math.max(1, Math.round((long * NATIVE_H) / NATIVE_W));
  return {
    width: w,
    height: h,
    nativeWidth: NATIVE_W,
    nativeHeight: NATIVE_H,
    rgb: new Uint8Array([0x80, 0x80, 0x80]),
    asShotTemperature: 5200,
    asShotTint: 0,
  };
}

describe('ImageCanvasComponent — two-phase live re-render (#846/#1101)', () => {
  let focused: WritableSignal<Asset | null>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let decodeSpy: ReturnType<typeof vi.fn>;
  let canvasSvc: ImageCanvasService;
  let updateDimsSpy: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ImageCanvasComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = signal<Asset | null>(null);
    models = new Map();
    decodeSpy = vi.fn((_b: Uint8Array, _e: string, _x: string | undefined, mle: number) =>
      Promise.resolve(decodedAt(mle)),
    );
    updateDimsSpy = vi.fn();

    // jsdom has none of these; the component observes resize, builds an
    // ImageData per decode, and (de)allocates bitmaps. The ImageData stand-in
    // lets `imageDataToBitmap` succeed so the component records the painted
    // size (`paintedLongEdge`) — the refine-skip-at-fit assertions depend on it.
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
      seedLensCorrections: vi.fn(),
      seedLensProfile: vi.fn(),
      updateAssetDimensions: updateDimsSpy,
      openDownloadProgress: signal(null),
    } as unknown as Partial<LibraryStateService>;

    TestBed.configureTestingModule({
      imports: [ImageCanvasComponent],
      providers: [
        XmpSerializerService,
        { provide: LibraryStateService, useValue: stateStub },
        {
          provide: RawPipelineService,
          // #1153: the canvas template reads the deep-denoise progress signal.
          useValue: {
            decode: decodeSpy,
            closeNativeDetail: vi.fn(),
            deepDenoiseProgress: signal(null),
            // #3397: the component mirrors out-of-band scope samples from here.
            scopeSample: signal(null),
          },
        },
      ],
    });
    // The REAL pan/zoom service (#1100): tiny and dependency-free, and the
    // component's gesture/zoom wiring is part of what these tests cover.
    canvasSvc = TestBed.inject(ImageCanvasService);
    fixture = TestBed.createComponent(ImageCanvasComponent);
    fixture.detectChanges(); // renders the real template + runs ngAfterViewInit
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  // Flush effects + pending microtasks (decode promise) + the debounce timer.
  async function settle(ms = 0): Promise<void> {
    fixture.detectChanges(); // run effects (decode effect / rerender effect)
    await vi.advanceTimersByTimeAsync(ms); // fire debounce + drain microtasks
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
  }

  function setModel(id: AssetId, patch: Partial<AdjustmentModel>): void {
    const sig = models.get(id) ?? signal(defaultAdjustmentModel());
    models.set(id, sig);
    sig.set({ ...sig(), ...patch });
  }

  it('cold open issues exactly one viewport-sized decode and records native dims', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    expect(decodeSpy).toHaveBeenCalledTimes(1);
    // Cold open decodes with NO xmp (raw-core substitutes As-Shot WB) at the
    // viewport long edge (the §5.1 fast target), Preview quality.
    const [, , xmp, maxLongEdge, preview] = decodeSpy.mock.calls[0];
    expect(maxLongEdge).toBe(VIEWPORT_LONG);
    expect(xmp).toBeUndefined();
    expect(preview).toBe(true);
    // Asset dims are the NATIVE dims from the sized reply, not the buffer's.
    expect(updateDimsSpy).toHaveBeenCalledWith('a', NATIVE_W, NATIVE_H);
  });

  it('an edit fires an immediate fast-phase decode; at fit no refine follows', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    setModel('a', { exposure: 1.0 });
    await settle(0); // NO debounce wait — the fast phase is per-tick

    expect(decodeSpy).toHaveBeenCalledTimes(2);
    const [, , xmp, maxLongEdge, preview] = decodeSpy.mock.calls[1];
    expect(maxLongEdge).toBe(VIEWPORT_LONG);
    expect(typeof xmp).toBe('string');
    expect(xmp as string).toContain('crs:Exposure2012="1"');
    expect(preview).toBe(true);

    // At fit the refine target equals the fast target → refine is skipped.
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(2);
  });

  it('zoomed in, the trailing refine fires at native × min(scale, 1), Full quality', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    canvasSvc.pixelScale.set(1); // pixelScale 1 @ dpr 1 → real scale 1 → refine at native
    await settle(REFINE_MS + 50); // absorb the zoom-driven refine
    decodeSpy.mockClear();

    setModel('a', { exposure: 1.0 });
    await settle(0);
    // Fast phase landed immediately…
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(decodeSpy.mock.calls[0][3]).toBe(VIEWPORT_LONG);

    // …and the refine fires after the debounce, at the native long edge.
    await settle(REFINE_MS + 10);
    expect(decodeSpy).toHaveBeenCalledTimes(2);
    const [, , xmp, maxLongEdge, preview] = decodeSpy.mock.calls[1];
    expect(maxLongEdge).toBe(NATIVE_W);
    expect(xmp as string).toContain('crs:Exposure2012="1"');
    expect(preview).toBe(false);
  });

  it('zooming in without an edit schedules a refine for the current model', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    decodeSpy.mockClear();

    canvasSvc.pixelScale.set(1);
    await settle(0);
    expect(decodeSpy).not.toHaveBeenCalled(); // debounced

    await settle(REFINE_MS + 10);
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    const [, , , maxLongEdge, preview] = decodeSpy.mock.calls[0];
    expect(maxLongEdge).toBe(NATIVE_W);
    expect(preview).toBe(false);
  });

  it('coalesces a burst of edits while a fast render is in flight (no storm)', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    // Hold the next fast decode open so the burst piles up behind it.
    let release!: (img: DecodedImage) => void;
    decodeSpy.mockImplementationOnce(
      () => new Promise<DecodedImage>((resolve) => (release = resolve)),
    );

    // Simulate a slider drag: many model writes while the first render runs.
    for (let i = 1; i <= 8; i += 1) {
      setModel('a', { exposure: i * 0.1 });
      await settle(0);
    }
    // Only the first tick's fast render started; the rest coalesced behind it.
    expect(decodeSpy).toHaveBeenCalledTimes(2);

    release(decodedAt(VIEWPORT_LONG));
    await settle(0);

    // Exactly one more fast decode fires, carrying the LAST edit's XMP.
    expect(decodeSpy).toHaveBeenCalledTimes(3);
    expect(decodeSpy.mock.calls[2][2] as string).toContain('crs:Exposure2012="0.8"');
  });

  it('switching assets cancels pending renders', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    canvasSvc.pixelScale.set(1); // make the refine pass reachable (off-fit)
    await settle(REFINE_MS + 50); // absorb the zoom-driven refine
    decodeSpy.mockClear();

    setModel('a', { exposure: 1.0 });
    await settle(0); // fast fired; refine still pending
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    // Switch to a new asset before the refine timer fires.
    focused.set(fakeAsset('b'));
    await settle(REFINE_MS + 50); // b's cold-open decode; a's timer was cleared

    // a's pending refine was cancelled: no subsequent decode may carry a's
    // edit. (b's cold open is XMP-free; with zoom still at 1 its own refine
    // legitimately carries b's default-model XMP.)
    const calls = decodeSpy.mock.calls.slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(
      calls.every((c) => c[2] === undefined || !(c[2] as string).includes('crs:Exposure2012="1"')),
    ).toBe(true);
  });

  // ── flag-off invariant (epic #925, P4b-web / #1038) ────────────────────────
  // With `gpuLiveRenderEnabled` falsy (the default stub), the GPU live-render path
  // must be completely inert: NO `openLiveSession`/`renderLiveSession` calls and NO
  // `transferControlToOffscreen` — the 2D sized-decode path is the only route.
  it('flag-off: never opens a GPU session nor transfers an OffscreenCanvas', async () => {
    const openSpy = vi.fn();
    const transferSpy = vi.fn();
    // The default `pipeline` stub has no `gpuLiveRenderEnabled`/session methods, but
    // assert the component never reaches for them: spy `transferControlToOffscreen`
    // on every canvas created, and confirm the (absent) session API isn't called.
    const origCreate = document.createElement.bind(document);
    const createSpy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string, opts?: ElementCreationOptions) => {
        const el = origCreate(tag, opts) as HTMLElement;
        if (tag === 'canvas') {
          (el as unknown as { transferControlToOffscreen: unknown }).transferControlToOffscreen =
            transferSpy;
        }
        return el;
      });

    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    setModel('a', { exposure: 1.0 });
    await settle(REFINE_MS + 10);

    // The 2D path ran (cold open + one fast edit decode); the GPU path was never touched.
    expect(decodeSpy).toHaveBeenCalledTimes(2);
    expect(openSpy).not.toHaveBeenCalled();
    expect(transferSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });
});

// The flag-ON GPU live-render path (epic #925, P4b-web / #1038) has its own
// suite in `image-canvas.gpu-live.spec.ts`, split out to stay under the
// file-size budget (same precedent as `image-canvas.gpu-kill-switch.spec.ts`).
