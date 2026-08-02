import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
        seedAsShotWhiteBalance: vi.fn(),
        adjustmentFor: () => signal(defaultAdjustmentModel()),
      },
      canvasSvc: { currentPixels: pixels },
      pipeline: { decode: vi.fn(decode) },
      imageBitmap,
      loading,
      currentAssetId: 'a' as AssetId,
      renderGeneration: 1,
      lastRenderedXmp: null,
      serializeForRender: () => '<xmp />',
      fastTargetPx: () => 800,
      markColdOpenDone: () => (coldOpenDone = true),
      hasProvisionalPreview: (id: AssetId) => rawOpen.hasProvisionalPreview(id),
      clearProvisionalPreview: (id: AssetId) => rawOpen.clearProvisionalPreview(id),
      recordNativeDims: vi.fn(),
      recordPaintedDims: vi.fn(),
      scheduleRefine: vi.fn(),
    } as unknown as Render2dHost;
    rawOpen = new ImageCanvasRawOpen(host, {
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
      currentAssetId: () => 'a',
      coldOpenDone: () => coldOpenDone,
      gpuEnabled: () => options.gpuOpen === true,
      openGpu: vi.fn(async () => {
        if (options.gpuOpen) host.markColdOpenDone();
        return options.gpuOpen === true;
      }),
      setCurrentInput: vi.fn(),
      recordPaintedDims: vi.fn(),
    });
    return { rawOpen, imageBitmap, loading };
  }

  it('shows the embedded JPEG while the full RAW decode is pending', async () => {
    let finishDecode!: (value: DecodedImage) => void;
    const { rawOpen, imageBitmap, loading } = harness(
      () => new Promise((resolve) => (finishDecode = resolve)),
    );

    const opening = rawOpen.load('a', 'photo.dng', new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    await Promise.resolve();

    expect(loading()).toBe(true);
    expect(imageBitmap()).toMatchObject({ kind: 'preview' });

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
