// image-canvas.render2d.spec.ts — #3171: `runRender2d` threads the focused
// asset's resolved film-look LUT bytes (`host.filmSync.cpuLutBytesForCurrent()`)
// through to `RawPipelineService.decode()`'s `filmLut` parameter on every
// WASM-CPU fast/refine render tick. `coldOpen2d` deliberately does NOT — the
// cold open decodes with `xmp: undefined` (no adjustments applied yet at
// all), and the film look only starts applying once the model-change effect
// fires its first real re-render, exactly like the GPU live path's
// `ImageCanvasFilmSync.syncIfNeeded` also only starts after cold open
// completes. `image-canvas.film.spec.ts` covers `ImageCanvasFilmSync`'s own
// resolve/cache/dedup behavior directly; this file covers the wiring at the
// actual `runRender2d` call site. `raw-pipeline.service.spec.ts` covers the
// `DecodeRequest.filmLut` threading below that.

import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetId } from '../../models/asset';
import { cameraSupportFromJson } from '../../state/camera-support';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import type { Render2dHost } from './image-canvas.render2d';
import { runRender2d, coldOpen2d } from './image-canvas.render2d';
import type { RenderSizing } from './image-canvas.two-phase';

const ASSET_ID = 'asset-1' as AssetId;

const decoded: DecodedImage = {
  width: 4,
  height: 4,
  nativeWidth: 4,
  nativeHeight: 4,
  rgb: new Uint8Array(4 * 4 * 3),
  asShotTemperature: 5500,
  asShotTint: 0,
};

const SIZING: RenderSizing = { maxLongEdge: 512, qualityPreview: true };

describe('runRender2d — film-look LUT threading (#3171)', () => {
  beforeEach(() => {
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
  });

  afterEach(() => vi.restoreAllMocks());

  function harness(cpuLutBytes: ArrayBuffer | undefined) {
    const decode = vi.fn<
      (
        bytes: Uint8Array,
        ext: string,
        xmp?: string,
        maxLongEdge?: number,
        qualityPreview?: boolean,
        filmLut?: ArrayBuffer,
      ) => Promise<DecodedImage>
    >(async () => decoded);
    const host = {
      state: {},
      canvasSvc: { currentPixels: signal<DecodedImage | null>(null) },
      pipeline: { decode },
      filmSync: { cpuLutBytesForCurrent: () => cpuLutBytes },
      nativeDetail: { recordBase: vi.fn() },
      imageBitmap: signal<ImageBitmap | null>(null),
      loading: signal(false),
      currentAssetId: ASSET_ID,
      renderGeneration: 1,
      lastRenderedXmp: null,
      recordPaintedDims: vi.fn(),
    } as unknown as Render2dHost;
    return { host, decode };
  }

  it('passes the currently-resolved film-look LUT bytes to decode()', async () => {
    const filmLut = new TextEncoder().encode('slide_fuji_velvia_50').buffer;
    const { host, decode } = harness(filmLut);

    await runRender2d(host, '<xmp />', 1, SIZING, new Uint8Array([1, 2, 3]), 'dng');

    expect(decode).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'dng',
      '<xmp />',
      SIZING.maxLongEdge,
      SIZING.qualityPreview,
      filmLut,
    );
    expect(host.nativeDetail?.recordBase).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      generation: 1,
      renderXmp: '<xmp />',
      displayXmp: '<xmp />',
      sizing: SIZING,
      filmLut,
    });
  });

  it('passes undefined to decode() when no look is loaded / still resolving', async () => {
    const { host, decode } = harness(undefined);

    await runRender2d(host, '<xmp />', 1, SIZING, new Uint8Array([1, 2, 3]), 'dng');

    expect(decode).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'dng',
      '<xmp />',
      SIZING.maxLongEdge,
      SIZING.qualityPreview,
      undefined,
    );
  });

  it.each([
    undefined,
    cameraSupportFromJson(
      '{"cameraKey":"Unknown camera","resolution":"embedded_cm_only","lens":"no_correction_data"}',
    )!,
  ])('coldOpen2d records decoded support %j without applying a film LUT', async (cameraSupport) => {
    const filmLut = new TextEncoder().encode('slide_fuji_velvia_50').buffer;
    const { host, decode } = harness(filmLut);
    decode.mockResolvedValue({ ...decoded, cameraSupport });
    (host as unknown as { state: unknown }).state = {
      updateAssetDimensions: vi.fn(),
      seedAsShotWhiteBalance: vi.fn(),
      seedLensCorrections: vi.fn(),
      adjustmentFor: () => () => ({}),
    };
    (host as unknown as { serializeForRender: () => string }).serializeForRender = () => '<xmp />';
    (host as unknown as { fastTargetPx: () => number }).fastTargetPx = () => 512;
    (host as unknown as { markColdOpenDone: () => void }).markColdOpenDone = vi.fn();
    (host as unknown as { hasProvisionalPreview: () => boolean }).hasProvisionalPreview = () =>
      false;
    (host as unknown as { clearProvisionalPreview: () => void }).clearProvisionalPreview = vi.fn();
    (host as unknown as { recordNativeDims: () => void }).recordNativeDims = vi.fn();
    (host as unknown as { scheduleRefine: () => void }).scheduleRefine = vi.fn();

    await coldOpen2d(host, ASSET_ID, 'photo.dng', 'dng', new Uint8Array([1, 2, 3]));

    expect(host.state.seedLensCorrections).toHaveBeenCalledWith(
      ASSET_ID,
      false,
      true,
      cameraSupport ?? null,
    );

    // `decode()`'s call signature at the cold open has only 4 args (no
    // sizing/filmLut trailing params beyond maxLongEdge/qualityPreview) —
    // asserting the call length rather than a specific arg count guards
    // against a future accidental filmLut leak into the cold-open path.
    expect(decode.mock.calls[0]!.length).toBe(5);
    expect(decode.mock.calls[0]![4]).toBe(true); // qualityPreview, not filmLut
    expect(host.nativeDetail?.recordBase).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      generation: 1,
      displayXmp: '<xmp />',
      sizing: SIZING,
    });
  });
});
