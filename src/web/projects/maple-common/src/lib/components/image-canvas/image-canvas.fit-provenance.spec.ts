import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryStore } from '../../state/library-store.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import type { AssetId } from '../../models/asset';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import { coldOpen2d, runRender2d, type Render2dHost } from './image-canvas.render2d';
import { ImageCanvasGpuPresent, type GpuPresentHost } from './image-canvas.gpu-present';
import { canUseLiveFastPath, buildLiveParams } from './image-canvas.live-params';

const ID = 'held-fit' as AssetId;
const frame: DecodedImage = {
  width: 1,
  height: 1,
  rgb: new Uint8Array([12, 34, 56]),
  asShotTemperature: 5500,
  asShotTint: 0,
  autoFit: true,
};
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  TestBed.configureTestingModule({ providers: [{ provide: LIBRARY_BACKEND, useValue: 'hosted' }] });
  const store = TestBed.inject(LibraryStore);
  const caps = store.lensCorrections;
  const state = {
    autoFitRevisionFor: caps.autoFitRevisionFor.bind(caps),
    resetAutoFit: caps.resetAutoFit.bind(caps),
    lensCorrectionsFor: caps.for.bind(caps),
    seedLensCorrections: caps.seed.bind(caps),
    seedLensProfile: caps.seedProfile.bind(caps),
    updateAssetDimensions: vi.fn(),
    seedAsShotWhiteBalance: vi.fn(),
    adjustmentFor: store.adjustmentFor.bind(store),
  };
  const serializer = new XmpSerializerService();
  const host = {
    state,
    currentAssetId: ID,
    renderGeneration: 1,
    canvasSvc: { currentPixels: signal(null) },
    pipeline: { decode: vi.fn(), renderLiveSession: vi.fn() },
    filmSync: { cpuLutBytesForCurrent: () => undefined },
    nativeDetail: { recordBase: vi.fn() },
    imageBitmap: signal(null),
    loading: signal(false),
    lastRenderedXmp: null,
    recordPaintedDims: vi.fn(),
    recordNativeDims: vi.fn(),
    fastTargetPx: () => 512,
    hasProvisionalPreview: () => false,
    clearProvisionalPreview: vi.fn(),
    serializeForRender: serializer.serialize.bind(serializer),
    markColdOpenDone: vi.fn(),
    scheduleRefine: vi.fn(),
  };
  return { host, store, caps, serializer };
}
beforeEach(() => {
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ close: vi.fn() })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const route of ['CPU', 'GPU']) {
  describe(`${route} actual store fit provenance before effect flush`, () => {
    for (const transition of ['Neutral to Auto', 'Auto to Neutral to Auto', 'new open']) {
      it(`rejects held replies after ${transition}, while retaining frame/lens publication`, async () => {
        const { host, store, caps } = harness();
        if (transition === 'Neutral to Auto') store.setAdjustment(ID, { profile: 'Neutral' });
        const reply = pending<DecodedImage>();
        host.pipeline.decode.mockReturnValue(reply.promise);
        host.pipeline.renderLiveSession.mockReturnValue(reply.promise);
        const work =
          route === 'CPU'
            ? runRender2d(
                host as unknown as Render2dHost,
                '<owned-dispatch/>',
                1,
                { maxLongEdge: 512, qualityPreview: true },
                new Uint8Array([1]),
                'dng',
              )
            : new ImageCanvasGpuPresent(host as unknown as GpuPresentHost).render(
                '<owned-dispatch/>',
                1,
              );
        if (transition === 'Auto to Neutral to Auto')
          store.setAdjustment(ID, { profile: 'Neutral' });
        if (transition === 'new open') caps.resetAutoFit(ID);
        else store.setAdjustment(ID, { profile: 'Auto' });
        // No TestBed.tick: this is precisely the window before generation advances.
        reply.resolve(frame);
        await work;
        expect(host.renderGeneration).toBe(1);
        expect(caps.for(ID).autoFit).toBeUndefined();
        expect(caps.for(ID).lensProfile).toBeUndefined();
        if (route === 'CPU') expect(host.canvasSvc.currentPixels()).toEqual(frame);
      });
    }
  });
}

it('keeps cold-open dispatched Neutral intent when Auto is queued, without publishing its stale fit', async () => {
  const { host, store, caps, serializer } = harness();
  store.setAdjustment(ID, { profile: 'Neutral' });
  const opened = store.adjustmentFor(ID)();
  const reply = pending<DecodedImage>();
  host.pipeline.decode.mockReturnValue(reply.promise);
  const work = coldOpen2d(
    host as unknown as Render2dHost,
    ID,
    'owned.dng',
    'dng',
    new Uint8Array([1]),
  );
  store.setAdjustment(ID, { profile: 'Auto' });
  reply.resolve({ ...frame, autoFit: false });
  await work;
  expect(caps.for(ID).autoFit).toBeUndefined();
  expect(host.lastRenderedXmp).toBe(serializer.serialize(opened));
  expect(host.markColdOpenDone).toHaveBeenCalledTimes(1);
});

it('accepts the matching reply and preserves it across a scalar edit', async () => {
  const { host, store, caps } = harness();
  host.pipeline.decode.mockResolvedValue(frame);
  await runRender2d(
    host as unknown as Render2dHost,
    '<owned/>',
    1,
    { maxLongEdge: 512, qualityPreview: true },
    new Uint8Array([1]),
    'dng',
  );
  expect(caps.for(ID).autoFit).toBe(true);
  const revision = caps.autoFitRevisionFor(ID);
  store.setAdjustment(ID, { exposure: 1 });
  expect(caps.autoFitRevisionFor(ID)).toBe(revision);
  expect(caps.for(ID).autoFit).toBe(true);
});

it('keeps a stale full GPU reply from enabling scalar dispatch for a newly selected profile', async () => {
  const { host, store } = harness();
  const held = pending<DecodedImage>();
  host.pipeline.renderLiveSession.mockReturnValueOnce(held.promise).mockResolvedValueOnce(frame);
  const present = new ImageCanvasGpuPresent(host as unknown as GpuPresentHost);
  const params = new Float32Array(19);
  const work = present.render('<old Auto/>', 1, params);
  store.setAdjustment(ID, { profile: 'Neutral' });
  store.setAdjustment(ID, { profile: 'Auto' });
  held.resolve(frame);
  await work;
  await present.render('<new Auto/>', 1, params);
  expect(host.pipeline.renderLiveSession.mock.calls[1]).toEqual(['<new Auto/>', undefined]);
});

it('invalidates an already ready scalar prefix across rapid profile transitions before effects flush', async () => {
  const { host, store, serializer } = harness();
  store.setAdjustment(ID, { whiteBalancePreset: 'Custom', sharpenAmount: 0, nrColor: 0 });
  const model = store.adjustmentFor(ID)();
  expect(canUseLiveFastPath(model)).toBe(true);
  const params = buildLiveParams(model);
  host.pipeline.renderLiveSession.mockResolvedValue(frame);
  const present = new ImageCanvasGpuPresent(host as unknown as GpuPresentHost);
  await present.render(serializer.serialize(model), 1, params);
  await present.render(serializer.serialize(model), 1, params);
  expect(host.pipeline.renderLiveSession.mock.calls[1][1]).toBe(params);
  store.setAdjustment(ID, { profile: 'Neutral' });
  expect(canUseLiveFastPath(store.adjustmentFor(ID)())).toBe(false);
  store.setAdjustment(ID, { profile: 'Auto' });
  const current = store.adjustmentFor(ID)();
  expect(canUseLiveFastPath(current)).toBe(true);
  await present.render(serializer.serialize(current), 1, buildLiveParams(current));
  expect(host.renderGeneration).toBe(1);
  expect(host.pipeline.renderLiveSession.mock.calls[2][1]).toBeUndefined();
});

async function heldBitmap(route: string) {
  const { host, caps } = harness();
  caps.resetAutoFit(ID);
  const previous = { close: vi.fn() } as unknown as ImageBitmap;
  host.imageBitmap.set(previous as never);
  const converted = pending<ImageBitmap>();
  let reject!: (error: Error) => void;
  const conversion = new Promise<ImageBitmap>((resolve, fail) => {
    reject = fail;
    converted.promise.then(resolve);
  });
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  const convert = vi.fn(() => conversion);
  vi.stubGlobal('createImageBitmap', convert);
  host.pipeline.decode.mockResolvedValue(frame);
  const work =
    route === 'cold open'
      ? coldOpen2d(host as unknown as Render2dHost, ID, 'owned.dng', 'dng', new Uint8Array([1]))
      : runRender2d(
          host as unknown as Render2dHost,
          '<owned/>',
          1,
          { maxLongEdge: 512, qualityPreview: true },
          new Uint8Array([1]),
          'dng',
        );
  await vi.waitFor(() => expect(convert).toHaveBeenCalledOnce());
  expect(caps.for(ID).autoFit).toBeUndefined();
  expect(host.canvasSvc.currentPixels()).toBeNull();
  expect(host.imageBitmap()).toBe(previous);
  return { host, caps, previous, bitmap, work, resolve: converted.resolve, reject };
}

for (const route of ['rerender', 'cold open']) {
  for (const outcome of ['success', 'generation', 'asset', 'revision']) {
    it(`${route} publishes fit only with its accepted bitmap: ${outcome}`, async () => {
      const h = await heldBitmap(route);
      if (outcome === 'generation') h.host.renderGeneration++;
      if (outcome === 'asset') h.host.currentAssetId = 'replacement' as AssetId;
      if (outcome === 'revision') h.caps.resetAutoFit(ID);
      h.resolve(h.bitmap);
      await h.work;
      if (outcome === 'generation' || outcome === 'asset') {
        expect(h.bitmap.close).toHaveBeenCalledOnce();
        expect(h.host.imageBitmap()).toBe(h.previous);
        expect(h.caps.for(ID).autoFit).toBeUndefined();
      } else {
        expect(h.host.imageBitmap()).toBe(h.bitmap);
        expect(h.caps.for(ID).autoFit).toBe(outcome === 'revision' ? undefined : true);
      }
    });
  }
  for (const completed of [false, true]) {
    it(`${route} rejects an unpainted fit and retains independently completed frame ${completed}`, async () => {
      const h = await heldBitmap(route);
      if (completed) {
        h.host.imageBitmap.set(h.bitmap as never);
        h.caps.seedProfile(ID, null, true, h.caps.autoFitRevisionFor(ID));
      }
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      h.reject(new Error('actual bitmap conversion rejected'));
      await h.work;
      expect(h.host.imageBitmap()).toBe(
        completed ? h.bitmap : route === 'cold open' ? null : h.previous,
      );
      expect(h.caps.for(ID).autoFit).toBe(completed);
      expect(h.previous.close).toHaveBeenCalledTimes(route === 'cold open' && !completed ? 1 : 0);
      expect(h.bitmap.close).not.toHaveBeenCalled();
    });
  }
}
