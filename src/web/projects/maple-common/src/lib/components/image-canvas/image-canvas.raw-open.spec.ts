import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type { AssetId } from '../../models/asset';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import type { Render2dHost } from './image-canvas.render2d';
import { ImageCanvasRawOpen } from './image-canvas.raw-open';

const decoded: DecodedImage = {
  width: 800,
  height: 500,
  nativeWidth: 4000,
  nativeHeight: 2500,
  rgb: new Uint8Array([128, 128, 128]),
  asShotTemperature: 5200,
  asShotTint: 0,
};

describe('ImageCanvasRawOpen', () => {
  beforeEach(() => {
    (globalThis as unknown as { ImageData: unknown }).ImageData = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    };
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(
      (source: Blob | ImageData) =>
        Promise.resolve({
          kind: source instanceof Blob ? 'preview' : 'final',
          close: vi.fn(),
        } as unknown as ImageBitmap),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  function harness(
    decode: () => Promise<DecodedImage>,
    options: {
      gpuOpen?: boolean;
      extractPreview?: () => Promise<{ width: number; height: number; blob: Blob }>;
    } = {},
  ) {
    const imageBitmap = signal<ImageBitmap | null>(null);
    const loading = signal(false);
    const pixels = signal<DecodedImage | null>(null);
    let coldOpenDone = false;
    let rawOpen!: ImageCanvasRawOpen;
    const host = {
      state: {
        updateAssetDimensions: vi.fn(),
        resetAutoFit: vi.fn(),
        autoFitRevisionFor: () => 0,
        seedAsShotWhiteBalance: vi.fn(),
        seedLensCorrections: vi.fn(),
        seedLensProfile: vi.fn(),
        lensCorrectionsFor: vi.fn(() => ({
          hasLensCorrections: true,
          lensCorrectionCaInert: false,
        })),
        adjustmentFor: () => signal(defaultAdjustmentModel()),
      },
      canvasSvc: { currentPixels: pixels, cropInputDimensions: signal(null) },
      pipeline: { decode: vi.fn(decode) },
      imageBitmap,
      loading,
      currentAssetId: 'a' as AssetId,
      renderGeneration: 1,
      lastRenderedXmp: null,
      serializeForRender: () => '<xmp />',
      captureRenderSerializer: () => () => '<xmp />',
      fastTargetPx: () => 800,
      markColdOpenDone: () => (coldOpenDone = true),
      hasProvisionalPreview: (id: AssetId) => rawOpen.hasProvisionalPreview(id),
      clearProvisionalPreview: (id: AssetId) => rawOpen.clearProvisionalPreview(id),
      recordNativeDims: vi.fn(),
      recordPaintedDims: vi.fn(),
      scheduleRefine: vi.fn(),
    } as unknown as Render2dHost;
    const byteLoadError = signal<import('./image-canvas.byteload').ByteLoadError | null>(null);
    rawOpen = new ImageCanvasRawOpen(host, {
      byteLoadError,
      embeddedPreview: {
        extractEmbeddedPreview: vi.fn(
          options.extractPreview ??
            (() =>
              Promise.resolve({
                width: 640,
                height: 400,
                blob: new Blob(['preview'], { type: 'image/jpeg' }),
              })),
        ),
      },
      imageBitmap,
      currentAssetId: () => host.currentAssetId,
      coldOpenDone: () => coldOpenDone,
      gpuEnabled: () => options.gpuOpen === true,
      openGpu: vi.fn(async () => {
        if (options.gpuOpen) host.markColdOpenDone();
        return options.gpuOpen === true;
      }),
      setCurrentInput: vi.fn(),
      recordPaintedDims: vi.fn(),
    });
    return { rawOpen, imageBitmap, loading, pixels, host, byteLoadError };
  }

  function supersedeColdLoad(h: ReturnType<typeof harness>, outcome: string): ImageBitmap {
    if (outcome === 'reset') h.rawOpen.reset();
    if (outcome === 'asset') Object.assign(h.host, { currentAssetId: 'b' });
    if (outcome === 'generation') Object.assign(h.host, { renderGeneration: 2 });
    if (outcome === 'profile revision') h.host.state.autoFitRevisionFor = () => 1;
    const replacement = { close: vi.fn() } as unknown as ImageBitmap;
    if (outcome === 'replacement frame') h.imageBitmap.set(replacement);
    return replacement;
  }

  for (const outcome of [
    'failure',
    'AbortError',
    'reset',
    'asset',
    'generation',
    'profile revision',
    'replacement frame',
    'provisional',
  ])
    it(`records only an owned terminal CPU rejection: ${outcome}`, async () => {
      let reject!: (error: Error) => void;
      const failed = new Promise<DecodedImage>((_done, fail) => {
        reject = fail;
      });
      const h = harness(() => failed, {
        extractPreview:
          outcome === 'provisional' ? undefined : () => Promise.reject(new Error('no preview')),
      });
      const opening = h.rawOpen.load('a', 'a.dng', new Uint8Array([1, 2, 3]));
      await Promise.resolve();
      await Promise.resolve();
      const replacement = supersedeColdLoad(h, outcome);
      const error = new Error('rejected CPU decode');
      if (outcome === 'AbortError') error.name = 'AbortError';
      reject(error);
      await opening;
      expect(h.byteLoadError() !== null).toBe(outcome === 'failure' || outcome === 'provisional');
      if (outcome === 'replacement frame') {
        expect(h.imageBitmap()).toBe(replacement);
        expect(replacement.close).not.toHaveBeenCalled();
      }
      if (outcome === 'provisional') expect(h.imageBitmap()).not.toBeNull();
    });

  it('preserves the pending newer load when the previous same-asset decode rejects', async () => {
    let rejectFirst!: (error: Error) => void;
    let finishSecond!: (value: DecodedImage) => void;
    const first = new Promise<DecodedImage>((_done, fail) => {
      rejectFirst = fail;
    });
    const second = new Promise<DecodedImage>((done) => {
      finishSecond = done;
    });
    const h = harness(vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second), {
      extractPreview: () => Promise.reject(new Error('no preview')),
    });
    const capabilities = new LensCorrectionCapabilities();
    capabilities.resetAutoFit('a');
    Object.assign(h.host.state, {
      autoFitRevisionFor: capabilities.autoFitRevisionFor.bind(capabilities),
      lensCorrectionsFor: capabilities.for.bind(capabilities),
      seedLensProfile: capabilities.seedProfile.bind(capabilities),
      seedLensCorrections: capabilities.seed.bind(capabilities),
    });
    const old = h.rawOpen.load('a', 'a.dng', new Uint8Array([1]));
    await vi.waitFor(() => expect(h.host.pipeline.decode).toHaveBeenCalledTimes(1));
    const current = h.rawOpen.load('a', 'a.dng', new Uint8Array([2]));
    await vi.waitFor(() => expect(h.host.pipeline.decode).toHaveBeenCalledTimes(2));
    rejectFirst(new Error('previous load failed'));
    await old;
    expect(capabilities.for('a').autoFit).toBeUndefined();
    expect(h.loading()).toBe(true);
    expect(h.byteLoadError()).toBeNull();
    finishSecond({ ...decoded, autoFit: true });
    await current;
    expect(capabilities.for('a').autoFit).toBe(true);
    expect(h.pixels()?.autoFit).toBe(true);
  });

  it('shows the embedded JPEG while the full RAW decode is pending', async () => {
    let finishDecode!: (value: DecodedImage) => void;
    const { rawOpen, imageBitmap, loading, pixels } = harness(
      () => new Promise((resolve) => (finishDecode = resolve)),
    );
    pixels.set(decoded);

    const opening = rawOpen.load('a', 'photo.dng', new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    await Promise.resolve();

    expect(loading()).toBe(true);
    expect(imageBitmap()).toMatchObject({ kind: 'preview' });
    expect(pixels()).toBeNull();

    finishDecode(decoded);
    await opening;
    expect(imageBitmap()).toMatchObject({ kind: 'final' });
  });

  it('keeps the embedded JPEG when the full RAW decode fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rawOpen, imageBitmap, loading } = harness(() => Promise.reject(new Error('failed')));

    await rawOpen.load('a', 'photo.dng', new Uint8Array([1, 2, 3]));

    expect(loading()).toBe(false);
    expect(imageBitmap()).toMatchObject({ kind: 'preview' });
  });

  it('closes a stale bitmap when decode fails without an embedded preview', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rawOpen, imageBitmap } = harness(() => Promise.reject(new Error('failed')), {
      extractPreview: () => Promise.reject(new Error('no embedded preview')),
    });
    const close = vi.fn();
    imageBitmap.set({ close } as unknown as ImageBitmap);

    await rawOpen.load('a', 'photo.dng', new Uint8Array([1, 2, 3]));

    expect(close).toHaveBeenCalledOnce();
    expect(imageBitmap()).toBeNull();
  });

  it('does not let a slow embedded preview overwrite a completed GPU open', async () => {
    let finishPreview!: (value: { width: number; height: number; blob: Blob }) => void;
    const { rawOpen, imageBitmap } = harness(() => Promise.resolve(decoded), {
      gpuOpen: true,
      extractPreview: () => new Promise((resolve) => (finishPreview = resolve)),
    });

    await rawOpen.load('a', 'photo.dng', new Uint8Array([1, 2, 3]));
    finishPreview({
      width: 640,
      height: 400,
      blob: new Blob(['preview'], { type: 'image/jpeg' }),
    });
    await Promise.resolve();

    expect(imageBitmap()).toBeNull();
  });
});
