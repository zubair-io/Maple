// ImageCanvasComponent — live-canvas re-render on adjustment change (#846).
//
// Covers the TS-layer wiring that threads the current AdjustmentModel's XMP
// into the WASM decode and re-renders on edits, debounced + cancellable:
//   - cold open issues exactly one decode (no spurious pre-seed/seed decode)
//   - a burst of edits coalesces to a single debounced decode (no storm)
//   - switching assets cancels a pending re-render (timer cleared)
//   - Profile Auto→Neutral and a slider move each trigger a re-render
//
// Zoneless project: effects run on `fixture.detectChanges()`; the debounce
// timer is driven with vitest fake timers. The WASM render itself is exercised
// by raw-core's fixture-gated tests; this spec stubs RawPipelineService.decode
// and asserts on the requests it receives.

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

function fakeAsset(id: AssetId): Asset {
  return { id, filename: `${id}.dng` } as Asset;
}

function decoded(): DecodedImage {
  return {
    width: 1,
    height: 1,
    rgb: new Uint8Array([0x80, 0x80, 0x80]),
    asShotTemperature: 5200,
    asShotTint: 0,
  };
}

describe('ImageCanvasComponent — live re-render on adjustment change (#846)', () => {
  let focused: WritableSignal<Asset | null>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let decodeSpy: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ImageCanvasComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = signal<Asset | null>(null);
    models = new Map();
    decodeSpy = vi.fn(() => Promise.resolve(decoded()));

    // jsdom has neither; the component observes resize + (de)allocates bitmaps.
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
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

    const canvasStub = {
      currentPixels: signal<DecodedImage | null>(null),
      zoom: signal<'fit' | number>('fit'),
      pan: signal({ x: 0, y: 0 }),
      beforeAfterSplitX: signal<number | null>(null),
      showBeforeAfter: signal(false),
      resetView: vi.fn(),
      toggleBeforeAfter: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      setSplit: vi.fn(),
      applyPanDelta: vi.fn(),
    } as unknown as Partial<ImageCanvasService>;

    TestBed.configureTestingModule({
      imports: [ImageCanvasComponent],
      providers: [
        XmpSerializerService,
        { provide: LibraryStateService, useValue: stateStub },
        { provide: ImageCanvasService, useValue: canvasStub },
        { provide: RawPipelineService, useValue: { decode: decodeSpy } },
      ],
    });
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

  it('cold open issues exactly one decode and no spurious pre-seed/seed decode', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    expect(decodeSpy).toHaveBeenCalledTimes(1);
    // Cold open decodes with NO xmp (raw-core substitutes As-Shot WB).
    expect(decodeSpy.mock.calls[0][2]).toBeUndefined();
  });

  it('an edit after cold open re-renders with the serialized XMP', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    setModel('a', { exposure: 1.0 });
    await settle(REFINE_MS + 10);

    expect(decodeSpy).toHaveBeenCalledTimes(2);
    const xmp = decodeSpy.mock.calls[1][2] as string;
    expect(typeof xmp).toBe('string');
    expect(xmp).toContain('crs:Exposure2012="1"');
  });

  it('a Profile Auto→Neutral toggle re-renders', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    setModel('a', { profile: 'Neutral' });
    await settle(REFINE_MS + 10);

    expect(decodeSpy).toHaveBeenCalledTimes(2);
    expect(decodeSpy.mock.calls[1][2] as string).toContain('papp:Profile="Neutral"');
  });

  it('coalesces a burst of edits into a single debounced decode (no storm)', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    // Simulate a slider drag: many model writes inside the debounce window.
    for (let i = 1; i <= 8; i += 1) {
      setModel('a', { exposure: i * 0.1 });
      await settle(20); // < REFINE_MS each → trailing debounce keeps resetting
    }
    // No decode yet beyond cold open — the trailing debounce hasn't elapsed.
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    await settle(REFINE_MS + 10);

    // Exactly one refine decode fires, carrying the LAST edit's XMP.
    expect(decodeSpy).toHaveBeenCalledTimes(2);
    expect(decodeSpy.mock.calls[1][2] as string).toContain('crs:Exposure2012="0.8"');
  });

  it('switching assets cancels a pending re-render', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    setModel('a', { exposure: 1.0 });
    await settle(20); // edit scheduled but debounce not yet elapsed

    // Switch to a new asset before the refine timer fires.
    focused.set(fakeAsset('b'));
    await settle(REFINE_MS + 50); // b's cold-open decode; a's timer was cleared

    // a's pending edit decode must have been cancelled; only the two cold
    // opens (a + b), both no-XMP, should have run.
    const xmps = decodeSpy.mock.calls.map((c) => c[2]);
    expect(decodeSpy).toHaveBeenCalledTimes(2);
    expect(xmps.every((x) => x === undefined)).toBe(true);
  });

  // ── flag-off invariant (epic #925, P4b-web / #1038) ────────────────────────
  // With `gpuLiveRenderEnabled` falsy (the default stub), the GPU live-render path
  // must be completely inert: NO `openLiveSession`/`renderLiveSession` calls and NO
  // `transferControlToOffscreen` — the 2D `decode()` path is byte-for-byte today.
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

    // The 2D path ran (cold open + one edit decode); the GPU path was never touched.
    expect(decodeSpy).toHaveBeenCalledTimes(2);
    expect(openSpy).not.toHaveBeenCalled();
    expect(transferSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });
});

// ── flag-ON GPU live-render path (epic #925, P4b-web / #1038) ───────────────
// With `gpuLiveRenderEnabled` true and a session-capable pipeline stub, a RAW asset
// routes cold-open through `openLiveSession` (transferring a fresh OffscreenCanvas)
// and #846 edits through `renderLiveSession` — NOT `decode()`. Reuses the same
// dedup/generation/debounce machinery; only the render mechanism differs.
describe('ImageCanvasComponent — GPU live-render path (#1038)', () => {
  let focused: WritableSignal<Asset | null>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let decodeSpy: ReturnType<typeof vi.fn>;
  let openSessionSpy: ReturnType<typeof vi.fn>;
  let renderSessionSpy: ReturnType<typeof vi.fn>;
  let closeSessionSpy: ReturnType<typeof vi.fn>;
  let transferSpy: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ImageCanvasComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = signal<Asset | null>(null);
    models = new Map();
    decodeSpy = vi.fn(() => Promise.resolve(decoded()));
    openSessionSpy = vi.fn(() =>
      Promise.resolve({
        width: 4000,
        height: 3000,
        asShotTemperature: 5200,
        asShotTint: 0,
        colorSpace: 'display-p3',
      }),
    );
    renderSessionSpy = vi.fn(() => Promise.resolve('display-p3'));
    closeSessionSpy = vi.fn();

    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {};
    // jsdom canvases lack transferControlToOffscreen — install a spy returning a
    // dummy OffscreenCanvas so the component's GPU cold-open path runs.
    transferSpy = vi.fn(() => ({}) as OffscreenCanvas);
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(
      (tag: string, opts?: ElementCreationOptions) => {
        const el = origCreate(tag, opts) as HTMLElement;
        if (tag === 'canvas') {
          (el as unknown as { transferControlToOffscreen: unknown }).transferControlToOffscreen =
            transferSpy;
        }
        return el;
      },
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

    const canvasStub = {
      currentPixels: signal<DecodedImage | null>(null),
      zoom: signal<'fit' | number>('fit'),
      pan: signal({ x: 0, y: 0 }),
      beforeAfterSplitX: signal<number | null>(null),
      showBeforeAfter: signal(false),
      resetView: vi.fn(),
      toggleBeforeAfter: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      setSplit: vi.fn(),
      applyPanDelta: vi.fn(),
    } as unknown as Partial<ImageCanvasService>;

    const pipelineStub = {
      decode: decodeSpy,
      gpuLiveRenderEnabled: true,
      openLiveSession: openSessionSpy,
      renderLiveSession: renderSessionSpy,
      closeLiveSession: closeSessionSpy,
    };

    TestBed.configureTestingModule({
      imports: [ImageCanvasComponent],
      providers: [
        XmpSerializerService,
        { provide: LibraryStateService, useValue: stateStub },
        { provide: ImageCanvasService, useValue: canvasStub },
        { provide: RawPipelineService, useValue: pipelineStub },
      ],
    });
    fixture = TestBed.createComponent(ImageCanvasComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  async function settle(ms = 0): Promise<void> {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
  }

  function setModel(id: AssetId, patch: Partial<AdjustmentModel>): void {
    const sig = models.get(id) ?? signal(defaultAdjustmentModel());
    models.set(id, sig);
    sig.set({ ...sig(), ...patch });
  }

  it('cold-open opens a GPU session (transfers a canvas) instead of decoding', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    expect(openSessionSpy).toHaveBeenCalledTimes(1);
    expect(transferSpy).toHaveBeenCalledTimes(1);
    // The 2D decode path must NOT run on the GPU cold-open.
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it('an edit re-renders via the session (renderLiveSession), not decode', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(openSessionSpy).toHaveBeenCalledTimes(1);

    setModel('a', { exposure: 1.0 });
    await settle(REFINE_MS + 10);

    expect(renderSessionSpy).toHaveBeenCalledTimes(1);
    const xmp = renderSessionSpy.mock.calls[0][0] as string;
    expect(xmp).toContain('crs:Exposure2012="1"');
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it('a burst of edits coalesces to a single session render (no storm)', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    for (let i = 1; i <= 6; i += 1) {
      setModel('a', { exposure: i * 0.1 });
      await settle(20);
    }
    expect(renderSessionSpy).not.toHaveBeenCalled(); // debounce not elapsed

    await settle(REFINE_MS + 10);
    expect(renderSessionSpy).toHaveBeenCalledTimes(1);
    expect(renderSessionSpy.mock.calls[0][0] as string).toContain('crs:Exposure2012="0.6"');
  });

  it('falls back to the 2D decode path when openLiveSession fails (gpu-off bundle)', async () => {
    openSessionSpy.mockRejectedValueOnce(new Error('WebLiveSession unavailable'));
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    // GPU open was attempted, failed, then the 2D decode path took over.
    expect(openSessionSpy).toHaveBeenCalledTimes(1);
    expect(decodeSpy).toHaveBeenCalledTimes(1);
    expect(decodeSpy.mock.calls[0][2]).toBeUndefined(); // cold-open, no XMP
  });

  it('switching assets closes the GPU session', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(openSessionSpy).toHaveBeenCalledTimes(1);

    focused.set(fakeAsset('b'));
    await settle(REFINE_MS + 50);

    // The previous session was closed; a new one opened for 'b'.
    expect(closeSessionSpy).toHaveBeenCalled();
    expect(openSessionSpy).toHaveBeenCalledTimes(2);
  });
});
