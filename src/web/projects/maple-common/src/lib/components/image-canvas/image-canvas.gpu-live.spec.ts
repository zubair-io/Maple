// ImageCanvasComponent — flag-ON GPU live-render path (epic #925, P4b-web /
// #1038). With `gpuLiveRenderEnabled` true and a session-capable pipeline
// stub, a RAW asset routes cold-open through `openLiveSession` (transferring
// a fresh OffscreenCanvas) and #846 edits through `renderLiveSession` — NOT
// the sized `decode()`. The session is the 16ms live path: edits render
// IMMEDIATELY (coalesced latest-wins), with no trailing debounce and no
// refine pass (the session presents full-res).
//
// Split out of `image-canvas.component.spec.ts` to stay under the file-size
// budget, same precedent as `image-canvas.gpu-kill-switch.spec.ts`.

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
import { patchSecureGpuContext, type SecureGpuContextPatch } from './gpu-context-test-helpers';

const REFINE_MS = 150;
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

describe('ImageCanvasComponent — GPU live-render path (#1038)', () => {
  let focused: WritableSignal<Asset | null>;
  let models: Map<AssetId, WritableSignal<AdjustmentModel>>;
  let decodeSpy: ReturnType<typeof vi.fn>;
  let openSessionSpy: ReturnType<typeof vi.fn>;
  let renderSessionSpy: ReturnType<typeof vi.fn>;
  // #3397: the worker's out-of-band scope broadcast, as the component sees it.
  let scopeSample: WritableSignal<DecodedImage | null>;
  let closeSessionSpy: ReturnType<typeof vi.fn>;
  let transferSpy: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ImageCanvasComponent>;
  let gpuContext: SecureGpuContextPatch;

  beforeEach(() => {
    vi.useFakeTimers();
    // This suite exercises a secure, GPU-capable browser (the happy path) —
    // the #2415 insecure-context short-circuit is covered in
    // `image-canvas.gpu-present.spec.ts`'s "GPU fallback notice" suite.
    gpuContext = patchSecureGpuContext();
    focused = signal<Asset | null>(null);
    models = new Map();
    decodeSpy = vi.fn((_b: Uint8Array, _e: string, _x: string | undefined, mle: number) =>
      Promise.resolve(decodedAt(mle)),
    );
    // A tiny 1×1 RGB readback snapshot, mirroring what the worker folds into the
    // session reply (#1045) so the component can feed the scopes' `currentPixels`.
    const scopeSnap = (): DecodedImage => ({
      width: 1,
      height: 1,
      rgb: new Uint8Array([12, 34, 56]),
      asShotTemperature: 6500,
      asShotTint: 0,
    });
    openSessionSpy = vi.fn(() =>
      Promise.resolve({
        width: 4000,
        height: 3000,
        asShotTemperature: 5200,
        asShotTint: 0,
        colorSpace: 'display-p3',
        scopePixels: scopeSnap(),
      }),
    );
    renderSessionSpy = vi.fn(() => Promise.resolve({ colorSpace: 'display-p3' }));
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
      seedLensCorrections: vi.fn(),
      seedLensProfile: vi.fn(),
      updateAssetDimensions: vi.fn(),
      openDownloadProgress: signal(null),
    } as unknown as Partial<LibraryStateService>;

    scopeSample = signal<DecodedImage | null>(null);
    const pipelineStub = {
      decode: decodeSpy,
      // #1153: the canvas template reads the deep-denoise progress signal.
      closeNativeDetail: vi.fn(),
      deepDenoiseProgress: signal(null),
      // #3397: scope samples arrive out-of-band on this signal, not on the
      // render reply; tests drive it directly to simulate the broadcast.
      scopeSample,
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
    gpuContext.restore();
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

  it('an edit re-renders via the session IMMEDIATELY (the 16ms live path)', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(openSessionSpy).toHaveBeenCalledTimes(1);

    setModel('a', { exposure: 1.0 });
    await settle(0); // no debounce wait — session ticks are per-edit

    expect(renderSessionSpy).toHaveBeenCalledTimes(1);
    const xmp = renderSessionSpy.mock.calls[0][0] as string;
    expect(xmp).toContain('crs:Exposure2012="1"');
    expect(decodeSpy).not.toHaveBeenCalled();

    // No additional (refine) render after the debounce — the session is full-res.
    await settle(REFINE_MS + 50);
    expect(renderSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('a burst of edits coalesces latest-wins behind the in-flight render (no storm)', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    // Hold the first edit's render open so the burst piles up behind it.
    let release!: (r: { colorSpace: string }) => void;
    renderSessionSpy.mockImplementationOnce(
      () => new Promise<{ colorSpace: string }>((resolve) => (release = resolve)),
    );

    for (let i = 1; i <= 6; i += 1) {
      setModel('a', { exposure: i * 0.1 });
      await settle(0);
    }
    expect(renderSessionSpy).toHaveBeenCalledTimes(1); // in flight, rest queued

    release({ colorSpace: 'display-p3' });
    await settle(0);
    // Exactly one more render fires, carrying the LAST edit's XMP.
    expect(renderSessionSpy).toHaveBeenCalledTimes(2);
    expect(renderSessionSpy.mock.calls[1][0] as string).toContain('crs:Exposure2012="0.6"');
  });

  it('falls back to the 2D sized-decode path when openLiveSession fails (gpu-off bundle)', async () => {
    openSessionSpy.mockRejectedValueOnce(new Error('WebLiveSession unavailable'));
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    // GPU open was attempted, failed, then the 2D sized decode took over.
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

  // ── Scope feed on the GPU path (#1045) ─────────────────────────────────────
  // The zero-readback present produces no `currentPixels`; the worker folds a small
  // readback snapshot into the session reply, which the component publishes so the
  // scopes update instead of going stale.
  it('cold-open publishes the readback snapshot to currentPixels for the scopes', async () => {
    const canvasSvc = TestBed.inject(ImageCanvasService);
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    expect(openSessionSpy).toHaveBeenCalledTimes(1);
    const px = canvasSvc.currentPixels();
    expect(px).not.toBeNull();
    expect(Array.from(px!.rgb)).toEqual([12, 34, 56]);
  });

  // #3610: `draw()` — the only thing touching the 2D canvas — is skipped once
  // GPU is active, so a stale pre-GPU frame stayed visible beside it unless
  // explicitly cleared.
  it('clears the 2D canvas whenever the draw effect re-fires while GPU owns presentation', async () => {
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);
    expect(openSessionSpy).toHaveBeenCalledTimes(1); // GPU path is active

    // Installed only now — draw()'s gradient-placeholder path never runs again.
    const canvas = fixture.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    const clearRectSpy = vi.fn();
    vi.spyOn(canvas, 'getContext').mockReturnValue({
      clearRect: clearRectSpy,
    } as unknown as CanvasRenderingContext2D);

    TestBed.inject(ImageCanvasService).pan.set({ x: 5, y: 0 }); // re-fires the draw effect
    await settle(0);
    expect(clearRectSpy).toHaveBeenCalled();
  });

  it('a missing readback snapshot leaves currentPixels null on open (scopes fall back)', async () => {
    // Worker couldn't snapshot the surface → no `scopePixels`.
    openSessionSpy.mockResolvedValueOnce({
      width: 4000,
      height: 3000,
      asShotTemperature: 5200,
      asShotTint: 0,
      colorSpace: 'display-p3',
    });
    const canvasSvc = TestBed.inject(ImageCanvasService);
    focused.set(fakeAsset('a'));
    await settle(REFINE_MS + 50);

    expect(openSessionSpy).toHaveBeenCalledTimes(1);
    // Null → scopes render their pseudo fallback (no regression vs today).
    expect(canvasSvc.currentPixels()).toBeNull();
  });
});
