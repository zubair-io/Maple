// image-canvas.render2d.spec.ts — the WASM-CPU render call sites.
//
// #3171: `runRender2d` threads the focused asset's resolved film-look LUT
// bytes (`host.filmSync.cpuLutBytesForCurrent()`) through to
// `RawPipelineService.decode()`'s `filmLut` parameter on every fast/refine
// tick. `coldOpen2d` deliberately does NOT — the film look only starts
// applying once the model-change effect fires its first re-render, like the
// GPU live path's `ImageCanvasFilmSync.syncIfNeeded`. `image-canvas.film.spec.ts`
// covers `ImageCanvasFilmSync` itself; `raw-pipeline.service.spec.ts` covers
// the `DecodeRequest.filmLut` threading below this.
//
// #3479: the cold open passes the asset's actual sidecar (a default model
// stays `undefined`, the #1892 As-Shot contract) so a persisted imported
// lens profile is restored on the first pixels, and every render reply's
// resolver verdict is seeded for the Lens Corrections panel.

import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetId } from '../../models/asset';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { cameraSupportFromJson } from '../../state/camera-support';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
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
const ASSESSED_SUPPORT = cameraSupportFromJson(
  '{"cameraKey":"Unknown camera","resolution":"embedded_cm_only","lens":"no_correction_data"}',
)!;

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
      state: { seedLensProfile: vi.fn() },
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
    { label: 'omitted', reply: decoded, expected: null },
    { label: 'undefined', reply: { ...decoded, cameraSupport: undefined }, expected: null },
    {
      label: 'assessed',
      reply: { ...decoded, cameraSupport: ASSESSED_SUPPORT },
      expected: ASSESSED_SUPPORT,
    },
  ])(
    'coldOpen2d records $label support without applying a film LUT',
    async ({ label, reply, expected }) => {
      expect(ASSESSED_SUPPORT).toBeDefined();
      expect(Object.hasOwn(reply, 'cameraSupport')).toBe(label !== 'omitted');
      const filmLut = new TextEncoder().encode('slide_fuji_velvia_50').buffer;
      const { host, decode } = harness(filmLut);
      decode.mockResolvedValue(reply);
      const capabilities = new LensCorrectionCapabilities();
      capabilities.seed(ASSET_ID, true, false, ASSESSED_SUPPORT);
      const seedLensCorrections = vi.fn(capabilities.seed.bind(capabilities));
      (host as unknown as { state: unknown }).state = {
        updateAssetDimensions: vi.fn(),
        seedAsShotWhiteBalance: vi.fn(),
        seedLensCorrections,
        seedLensProfile: vi.fn(),
        adjustmentFor: () => () => defaultAdjustmentModel(),
      };
      (host as unknown as { serializeForRender: () => string }).serializeForRender = () =>
        '<xmp />';
      (host as unknown as { fastTargetPx: () => number }).fastTargetPx = () => 512;
      (host as unknown as { markColdOpenDone: () => void }).markColdOpenDone = vi.fn();
      (host as unknown as { hasProvisionalPreview: () => boolean }).hasProvisionalPreview = () =>
        false;
      (host as unknown as { clearProvisionalPreview: () => void }).clearProvisionalPreview =
        vi.fn();
      (host as unknown as { recordNativeDims: () => void }).recordNativeDims = vi.fn();
      (host as unknown as { scheduleRefine: () => void }).scheduleRefine = vi.fn();

      await coldOpen2d(host, ASSET_ID, 'photo.dng', 'dng', new Uint8Array([1, 2, 3]));

      expect(host.state.seedLensCorrections).toHaveBeenCalledWith(
        ASSET_ID,
        false,
        true,
        expected,
        null,
      );
      expect(capabilities.for(ASSET_ID).cameraSupport).toEqual(expected ?? undefined);

      // The cold open supplies sizing + preview quality and no trailing film
      // LUT; a default model opens with no XMP at all (#1892).
      expect(decode.mock.calls[0]!.length).toBe(5);
      expect(decode.mock.calls[0]![2]).toBeUndefined();
      expect(decode.mock.calls[0]![4]).toBe(true); // qualityPreview, not filmLut
      expect(host.nativeDetail?.recordBase).toHaveBeenCalledWith({
        assetId: ASSET_ID,
        generation: 1,
        renderXmp: undefined,
        displayXmp: '<xmp />',
        sizing: SIZING,
      });
    },
  );

  it("seeds the render reply's imported-profile verdict on every re-render (#3479)", async () => {
    const reference = `lcp1:${'a'.repeat(64)}`;
    const verdict = {
      source: 'lcp' as const,
      confidence: 'in-range' as const,
      reference,
      approximations: [],
      unsupported: [],
    };
    const { host, decode } = harness(undefined);
    decode.mockResolvedValue({ ...decoded, lensProfile: verdict });
    await runRender2d(host, '<xmp />', 1, SIZING, new Uint8Array([1, 2, 3]), 'dng');
    expect(host.state.seedLensProfile).toHaveBeenCalledWith(ASSET_ID, verdict);

    decode.mockResolvedValue(decoded);
    await runRender2d(host, '<xmp />', 1, SIZING, new Uint8Array([1, 2, 3]), 'dng');
    expect(host.state.seedLensProfile).toHaveBeenLastCalledWith(ASSET_ID, null);
  });

  it('reopens the CPU preview with its persisted sidecar, imported profile included (#3479)', async () => {
    const { host, decode } = harness(undefined);
    const reference = `lcp1:${'a'.repeat(64)}`;
    const verdict = {
      source: 'lcp' as const,
      confidence: 'in-range' as const,
      reference,
      approximations: [],
      unsupported: [],
    };
    decode.mockResolvedValue({ ...decoded, lensProfile: verdict });
    const model = { ...defaultAdjustmentModel(), lensProfile: reference };
    const seedLensCorrections = vi.fn();
    Object.assign(host, {
      state: {
        updateAssetDimensions: vi.fn(),
        seedAsShotWhiteBalance: vi.fn(),
        seedLensCorrections,
        seedLensProfile: vi.fn(),
        adjustmentFor: () => () => model,
      },
      serializeForRender: () => `<rdf:Description papp:LensProfile="${reference}"/>`,
      fastTargetPx: () => 512,
      markColdOpenDone: vi.fn(),
      hasProvisionalPreview: () => false,
      clearProvisionalPreview: vi.fn(),
      recordNativeDims: vi.fn(),
      scheduleRefine: vi.fn(),
    });

    await coldOpen2d(host, ASSET_ID, 'photo.dng', 'dng', new Uint8Array([1, 2, 3]));

    expect(decode.mock.calls[0]![2]).toContain(reference);
    expect(host.imageBitmap()).not.toBeNull();
    expect(seedLensCorrections).toHaveBeenCalledWith(ASSET_ID, false, true, null, verdict);
    expect(host.lastRenderedXmp).toContain(reference);
    expect(host.nativeDetail?.recordBase).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      generation: 1,
      renderXmp: decode.mock.calls[0]![2],
      displayXmp: host.lastRenderedXmp,
      sizing: SIZING,
    });
  });
});
