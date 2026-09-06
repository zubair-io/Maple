// CPU render wiring: film LUTs on redraw and persisted optical selection on open.

import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type { AssetId } from '../../models/asset';
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
      state: { seedLensCorrections: vi.fn() },
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

  it('coldOpen2d never reads filmSync — the cold-open decode carries no film LUT', async () => {
    const filmLut = new TextEncoder().encode('slide_fuji_velvia_50').buffer;
    const { host, decode } = harness(filmLut);
    (host as unknown as { state: unknown }).state = {
      updateAssetDimensions: vi.fn(),
      seedAsShotWhiteBalance: vi.fn(),
      seedLensCorrections: vi.fn(),
      adjustmentFor: () => () => defaultAdjustmentModel(),
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

    // Cold open supplies sizing and preview quality, with no trailing film LUT.
    expect(decode.mock.calls[0]!.length).toBe(5);
    expect(host.imageBitmap()).not.toBeNull();
    expect(decode.mock.calls[0]![2]).toBeUndefined();
    expect(decode.mock.calls[0]![4]).toBe(true); // qualityPreview, not filmLut
    expect(host.nativeDetail?.recordBase).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      generation: 1,
      renderXmp: undefined,
      displayXmp: '<xmp />',
      sizing: SIZING,
    });
  });
  it('reopens the CPU preview with its persisted optical selection', async () => {
    const { host, decode } = harness(undefined);
    const reference = `lcp1:${'a'.repeat(64)}`;
    const model = { ...defaultAdjustmentModel(), lensProfile: reference };
    const seed = vi.fn();
    Object.assign(host, {
      state: {
        updateAssetDimensions: vi.fn(),
        seedAsShotWhiteBalance: vi.fn(),
        seedLensCorrections: seed,
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
    expect(decode.mock.calls[0][2]).toContain(reference);
    expect(host.imageBitmap()).not.toBeNull();
    expect(seed).toHaveBeenCalled();
    expect(host.lastRenderedXmp).toContain(reference);
    expect(host.nativeDetail?.recordBase).toHaveBeenCalledWith({
      assetId: ASSET_ID,
      generation: 1,
      renderXmp: decode.mock.calls[0][2],
      displayXmp: host.lastRenderedXmp,
      sizing: SIZING,
    });
  });
});
