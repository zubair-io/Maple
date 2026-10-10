import { renderModelForCrop } from './image-canvas.crop';
// ImageCanvasGpuPresent — per-session present-failure detection (#1572).
//
// Tests three behaviours introduced in #1572:
//   (a) A successful GPU present test keeps `active` true and returns `true` from `open()`.
//   (b) A failed GPU present test makes `open()` return `false` immediately.
//   (c) After a failed probe, every subsequent call to `open()` returns `false` immediately
//       without attempting another GPU session — the session-level static `presentBroken`
//       flag prevents re-detection on every image.

import { Injector, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ImageCanvasGpuPresent } from './image-canvas.gpu-present';
import { wireScopeSampleEffect } from './image-canvas.gpu-effects';
import type { GpuPresentHost } from './image-canvas.gpu-present';
import type {
  RenderedLiveSession,
  OpenedLiveSession,
} from '../../raw-pipeline/raw-pipeline.service';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import { type AdjustmentModel, defaultAdjustmentModel } from '../../models/adjustment-model';
import { GpuFallbackNoticeService } from '../gpu-fallback-notice/gpu-fallback-notice.service';
import { patchSecureGpuContext, type SecureGpuContextPatch } from './gpu-context-test-helpers';

// ── DOM stubs ────────────────────────────────────────────────────────────────
// jsdom omits OffscreenCanvas / transferControlToOffscreen entirely. This
// suite exercises a browser that DOES support WebGPU (the #2415
// insecure-context short-circuit has its own suite below), so also patch in
// a secure, GPU-capable `isSecureContext`/`navigator.gpu` via the shared helper.

class OffscreenCanvasStub {
  width = 0;
  height = 0;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
}

let originalOffscreenCanvas: any;
let originalTransferControl: any;
let gpuContext: SecureGpuContextPatch;

function patchDom(): void {
  originalOffscreenCanvas = (globalThis as any).OffscreenCanvas;
  originalTransferControl = HTMLCanvasElement.prototype.transferControlToOffscreen;

  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    value: OffscreenCanvasStub,
    writable: true,
    configurable: true,
  });
  HTMLCanvasElement.prototype.transferControlToOffscreen = function () {
    return new OffscreenCanvasStub(0, 0) as unknown as OffscreenCanvas;
  };
  gpuContext = patchSecureGpuContext();
}

function unpatchDom(): void {
  HTMLCanvasElement.prototype.transferControlToOffscreen = originalTransferControl;
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    value: originalOffscreenCanvas,
    writable: true,
    configurable: true,
  });
  gpuContext.restore();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOpenedSession(): OpenedLiveSession {
  return {
    width: 800,
    height: 600,
    nativeWidth: 4000,
    nativeHeight: 3000,
    asShotTemperature: 5500,
    asShotTint: 0,
    colorSpace: 'display-p3',
    scopePixels: undefined,
  };
}

// ── Minimal GpuPresentHost stub ───────────────────────────────────────────────

function makeHost(
  openLiveSessionImpl: () => Promise<OpenedLiveSession>,
  model: AdjustmentModel = defaultAdjustmentModel(),
): GpuPresentHost {
  const wrapEl = document.createElement('div');
  const loading = signal(false);
  const imageBitmap = signal<ImageBitmap | null>(null);

  const pipeline = {
    get gpuLiveRenderEnabled() {
      return true;
    },
    openLiveSession: vi.fn(openLiveSessionImpl),
    closeLiveSession: vi.fn(),
    renderLiveSession: vi.fn(),
    scopeSample: signal<DecodedImage | null>(null),
  } as unknown as GpuPresentHost['pipeline'];

  const state = {
    autoFitRevisionFor: () => 0,
    updateAssetDimensions: vi.fn(),
    seedAsShotWhiteBalance: vi.fn(),
    seedLensCorrections: vi.fn(),
    seedLensProfile: vi.fn(),
    lensCorrectionsFor: vi.fn(() => ({ hasLensCorrections: true, lensCorrectionCaInert: false })),
    adjustmentFor: vi.fn(() => signal(model)),
  } as unknown as GpuPresentHost['state'];

  const canvasSvc = {
    currentPixels: signal<DecodedImage | null>(null),
    cropInputDimensions: signal<{ w: number; h: number } | null>(null),
    pan: signal({ x: 0, y: 0 }),
  } as unknown as GpuPresentHost['canvasSvc'];

  const xmpSerializer = {
    serialize: vi.fn(() => '<x/>'),
  } as unknown as GpuPresentHost['xmpSerializer'];

  const gpuFallback = new GpuFallbackNoticeService();

  return {
    wrapRef: { nativeElement: wrapEl },
    pipeline,
    state,
    canvasSvc,
    xmpSerializer,
    savedRemovals: {
      load: vi.fn(async () => null),
    } as unknown as GpuPresentHost['savedRemovals'],
    gpuFallback,
    serializeForRender: () => '<x/>',
    captureRenderSerializer() {
      return this.serializeForRender.bind(this);
    },
    loading,
    imageBitmap,
    currentAssetId: 'asset-1',
    renderGeneration: 1,
    lastRenderedXmp: null,
    markColdOpenDone: vi.fn(),
    currentLayout: () => ({ canvasW: 800, canvasH: 600, pan: { x: 0, y: 0 } }),
    viewportTargetLongEdge: () => 1440,
    recordNativeDims: vi.fn(),
    recordPaintedDims: vi.fn(),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ImageCanvasGpuPresent — present-failure detection (#1572)', () => {
  beforeEach(() => {
    patchDom();
    ImageCanvasGpuPresent.resetSessionForTests();
  });

  afterEach(() => {
    unpatchDom();
    vi.restoreAllMocks();
  });

  it('reestablishes Auto through full XMP after Neutral before resuming scalar renders', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const present = new ImageCanvasGpuPresent(host);
    const render = vi.mocked(host.pipeline.renderLiveSession).mockResolvedValue({
      colorSpace: 'srgb',
      width: 31,
      height: 19,
    });
    const params = new Float32Array(19);
    const auto = '<rdf:Description papp:Profile="Auto"/>';
    const neutral = '<rdf:Description papp:Profile="Neutral"/>';

    await present.render(auto, 1, params);
    expect(render).toHaveBeenLastCalledWith(auto, undefined, {
      manifest: '[]',
      bytes: new Uint8Array(),
    });
    await present.render(auto, 1, params);
    expect(render).toHaveBeenLastCalledWith(auto, params, undefined);
    expect(host.savedRemovals.load).toHaveBeenCalledTimes(1);
    await present.render(neutral, 1);
    expect(render).toHaveBeenLastCalledWith(neutral, undefined, {
      manifest: '[]',
      bytes: new Uint8Array(),
    });
    await present.render(auto, 1, params);
    expect(render).toHaveBeenLastCalledWith(auto, undefined, {
      manifest: '[]',
      bytes: new Uint8Array(),
    });
    await present.render(auto, 1, params);
    expect(render).toHaveBeenLastCalledWith(auto, params, undefined);
    present.teardown();
    await present.render(auto, 1, params);
    expect(render).toHaveBeenLastCalledWith(auto, undefined, {
      manifest: '[]',
      bytes: new Uint8Array(),
    });
  });

  it('uses full XMP when Auto is chosen while a Neutral render is pending', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const present = new ImageCanvasGpuPresent(host);
    const render = vi.mocked(host.pipeline.renderLiveSession).mockResolvedValue({
      colorSpace: 'srgb',
      width: 31,
      height: 19,
    });
    const params = new Float32Array(19);
    await present.render('Auto', 1, params);
    let resolveNeutral!: (value: RenderedLiveSession) => void;
    render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNeutral = resolve;
        }),
    );
    const pendingNeutral = present.render('Neutral', 1);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    Object.assign(host, { renderGeneration: 2 });
    await present.render('Auto', 2, params);
    expect(render).toHaveBeenLastCalledWith('Auto', undefined, {
      manifest: '[]',
      bytes: new Uint8Array(),
    });
    resolveNeutral({ colorSpace: 'srgb', width: 31, height: 19 });
    expect(await pendingNeutral).toBe(false);
    await present.render('Auto', 2, params);
    expect(render).toHaveBeenLastCalledWith('Auto', params, undefined);
  });

  it('transfers verified companions on a cold render and performs no companion read on scalar ticks', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const present = new ImageCanvasGpuPresent(host);
    const bundle = { manifest: '[{"name":"saved","length":1}]', bytes: new Uint8Array([7]) };
    vi.mocked(host.savedRemovals.load).mockResolvedValue(bundle);
    const render = vi
      .mocked(host.pipeline.renderLiveSession)
      .mockResolvedValue({ colorSpace: 'srgb', width: 31, height: 19 });
    const params = new Float32Array(19);
    await present.render('accepted recipe', 1, params);
    expect(render).toHaveBeenLastCalledWith('accepted recipe', undefined, bundle);
    await present.render('next exposure', 1, params);
    expect(render).toHaveBeenLastCalledWith('next exposure', params, undefined);
    expect(host.savedRemovals.load).toHaveBeenCalledTimes(1);
  });

  it('publishes actual Auto provenance only for current XMP replies', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const present = new ImageCanvasGpuPresent(host);
    const render = vi.mocked(host.pipeline.renderLiveSession).mockResolvedValue({
      colorSpace: 'srgb',
      width: 31,
      height: 19,
      autoFit: true,
    });
    const params = new Float32Array(19);
    await present.render('Auto', 1, params);
    expect(host.state.seedLensProfile).toHaveBeenLastCalledWith('asset-1', null, true, 0);
    const count = vi.mocked(host.state.seedLensProfile).mock.calls.length;
    await present.render('Auto', 1, params);
    expect(vi.mocked(host.state.seedLensProfile).mock.calls).toHaveLength(count);
    render.mockResolvedValue({ colorSpace: 'srgb', width: 31, height: 19, autoFit: false });
    await present.render('Auto', 0);
    expect(vi.mocked(host.state.seedLensProfile).mock.calls).toHaveLength(count);
    await present.render('Auto', 1);
    expect(host.state.seedLensProfile).toHaveBeenLastCalledWith('asset-1', null, false, 0);
  });

  it('(a) successful GPU present test -> open() returns true and active stays set', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const gpuPresent = new ImageCanvasGpuPresent(host);
    const spy = vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(true);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(true);
    expect(gpuPresent.active()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((host.pipeline.openLiveSession as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('records the actual post-crop canvas dimensions after open and render', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const present = new ImageCanvasGpuPresent(host);
    vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(true);
    await present.open('asset-1', new Uint8Array([0x44]), 'dng');
    expect(host.recordPaintedDims).toHaveBeenLastCalledWith(800, 600);
    vi.mocked(host.pipeline.renderLiveSession).mockResolvedValue({
      colorSpace: 'srgb',
      width: 19,
      height: 31,
    });
    await present.render('<cropped/>', 1);
    expect(host.recordPaintedDims).toHaveBeenLastCalledWith(19, 31);
    expect(host.recordNativeDims).toHaveBeenLastCalledWith(4000, 3000);
  });

  it('(b) failed GPU present test -> open() returns false and active stays false', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const gpuPresent = new ImageCanvasGpuPresent(host);
    const spy = vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(false);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(false);
    expect(gpuPresent.active()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    // The session open must not have been requested.
    expect(host.pipeline.openLiveSession).not.toHaveBeenCalled();
  });

  it('(c) after a failed probe, subsequent open() returns false immediately without calling testGpuPresent again', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const gpuPresent = new ImageCanvasGpuPresent(host);
    const spy = vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(false);

    // First open: fails -> marks presentBroken.
    const first = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');
    expect(first).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    // Second open: must return false immediately, without testing again.
    const second = await gpuPresent.open('asset-2', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');
    expect(second).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ImageCanvasGpuPresent — cold-open sidecar (#1915)', () => {
  beforeEach(() => {
    patchDom();
    ImageCanvasGpuPresent.resetSessionForTests();
  });

  afterEach(() => {
    unpatchDom();
    vi.restoreAllMocks();
  });

  it('opens the live session with the real serialized sidecar for a non-default model', async () => {
    // An asset that already has edits must present them on the FIRST frame — before
    // the fix this passed `undefined`, so the canvas showed the no-edit default and
    // the #846 dedup then masked the mismatch (canvas stuck on default).
    const edited: AdjustmentModel = { ...defaultAdjustmentModel(), exposure: 1.5 };
    const host = makeHost(() => Promise.resolve(makeOpenedSession()), edited);
    const gpuPresent = new ImageCanvasGpuPresent(host);
    vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(true);

    await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    const calls = (host.pipeline.openLiveSession as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    // 4th arg (index 3) is the xmp — the serialized model, not undefined.
    expect(calls[0][3]).toBe('<x/>');
  });

  it('records the opened Neutral intent before releasing an Auto edit (#4101)', async () => {
    const model = signal<AdjustmentModel>({ ...defaultAdjustmentModel(), profile: 'Neutral' });
    let finish!: (info: OpenedLiveSession) => void;
    const host = makeHost(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      model(),
    );
    vi.mocked(host.state.adjustmentFor).mockReturnValue(model);
    Object.assign(host, {
      serializeForRender: (value: AdjustmentModel) => value.profile,
      markColdOpenDone: vi.fn(() => expect(host.lastRenderedXmp).toBe('Neutral')),
    });
    const present = new ImageCanvasGpuPresent(host);
    vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(true);
    const opening = present.open('asset-1', new Uint8Array([1]), 'dng');
    await vi.waitFor(() => expect(host.pipeline.openLiveSession).toHaveBeenCalledTimes(1));
    model.set({ ...model(), profile: 'Auto' });
    finish(makeOpenedSession());
    expect(await opening).toBe(true);
    expect(vi.mocked(host.pipeline.openLiveSession).mock.calls[0][3]).toBe('Neutral');
    expect(host.lastRenderedXmp).toBe('Neutral');
    expect(host.lastRenderedXmp).not.toBe(host.serializeForRender(model()));
    expect(host.markColdOpenDone).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'retains dispatched crop posture when active=%s toggles during GPU open',
    async (active) => {
      const cropActive = signal(active);
      const opened = {
        ...defaultAdjustmentModel(),
        profile: 'Neutral' as const,
        whiteBalancePreset: 'Custom' as const,
        temperature: 4800,
        tint: 12,
        crop: { ...defaultAdjustmentModel().crop, left: 0.2 },
      };
      let finish!: (info: OpenedLiveSession) => void;
      const host = makeHost(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        opened,
      );
      const serialize = (value: AdjustmentModel, crop: boolean) =>
        JSON.stringify(renderModelForCrop(value, crop));
      Object.assign(host, {
        serializeForRender: (value: AdjustmentModel) => serialize(value, cropActive()),
        captureRenderSerializer: () => {
          const snapshot = cropActive();
          return (value: AdjustmentModel) => serialize(value, snapshot);
        },
      });
      const present = new ImageCanvasGpuPresent(host);
      vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(true);
      const opening = present.open('asset-1', new Uint8Array([1]), 'dng');
      await vi.waitFor(() => expect(host.pipeline.openLiveSession).toHaveBeenCalledTimes(1));
      const dispatched = vi.mocked(host.pipeline.openLiveSession).mock.calls[0][3];
      cropActive.set(!active);
      finish(makeOpenedSession());
      expect(await opening).toBe(true);
      expect(host.lastRenderedXmp).toBe(dispatched);
      expect(host.lastRenderedXmp).not.toBe(host.serializeForRender(opened));
    },
  );

  it('opens with undefined xmp for a fresh (default) model — preserves the #1892 As-Shot seeding path', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession())); // default model
    const gpuPresent = new ImageCanvasGpuPresent(host);
    vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(true);

    await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    const calls = (host.pipeline.openLiveSession as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][3]).toBeUndefined();
  });
});

// ── GPU fallback notice reporting (#2415) ────────────────────────────────────
// `open()` distinguishes an insecure context (no HTTPS fix message would help
// with anything else) from any other open failure, and reports into
// `host.gpuFallback` accordingly — see `gpu-fallback-notice.service.ts`.
describe('ImageCanvasGpuPresent — GPU fallback notice reporting (#2415)', () => {
  beforeEach(() => {
    patchDom(); // secure + navigator.gpu present by default
    ImageCanvasGpuPresent.resetSessionForTests();
  });

  afterEach(() => {
    unpatchDom();
    vi.restoreAllMocks();
  });

  it('an insecure origin (isSecureContext === false) reports "insecure-context" with the HTTPS message and never calls openLiveSession', async () => {
    // Downgrade patchDom()'s secure-context stub for this one test. Note
    // `navigator.gpu` stays stubbed present: the origin check ALONE must
    // classify as insecure-context.
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });

    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const gpuPresent = new ImageCanvasGpuPresent(host);
    vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(true);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(false);
    expect(host.pipeline.openLiveSession).not.toHaveBeenCalled();
    expect(host.gpuFallback.visible()).toBe(true);
    expect(host.gpuFallback.message()).toContain('HTTPS');
  });

  it('missing navigator.gpu on a SECURE origin reports the generic fallback — HTTPS would not fix it', async () => {
    // patchDom() left `isSecureContext` true; only WebGPU support is absent.
    delete (navigator as unknown as { gpu?: unknown }).gpu;

    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const gpuPresent = new ImageCanvasGpuPresent(host);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(false);
    expect(host.pipeline.openLiveSession).not.toHaveBeenCalled();
    expect(host.gpuFallback.visible()).toBe(true);
    expect(host.gpuFallback.message()).not.toContain('HTTPS');
  });

  it('a session-open failure on an otherwise secure, GPU-capable browser reports "session-open-failed" (no HTTPS mention)', async () => {
    const host = makeHost(() => Promise.reject(new Error('WebLiveSession unavailable')));
    const gpuPresent = new ImageCanvasGpuPresent(host);
    vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(false);
    expect(host.pipeline.openLiveSession).toHaveBeenCalledTimes(1);
    expect(host.gpuFallback.visible()).toBe(true);
    expect(host.gpuFallback.message()).not.toContain('HTTPS');
  });

  it('a successful open on the GPU path never reports a fallback notice', async () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const gpuPresent = new ImageCanvasGpuPresent(host);
    vi.spyOn(ImageCanvasGpuPresent, 'testGpuPresent').mockResolvedValue(true);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(true);
    expect(host.gpuFallback.visible()).toBe(false);
  });
});

describe('wireScopeSampleEffect (#3397)', () => {
  it('publishes an out-of-band sample into currentPixels', () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const injector = TestBed.inject(Injector);
    const stop = wireScopeSampleEffect(host, injector);
    TestBed.flushEffects();
    expect(host.canvasSvc.currentPixels()).toBeNull();

    (host.pipeline.scopeSample as WritableSignal<DecodedImage | null>).set({
      width: 1,
      height: 1,
      rgb: new Uint8Array([99, 88, 77]),
      asShotTemperature: 6500,
      asShotTint: 0,
    });
    TestBed.flushEffects();

    expect(Array.from(host.canvasSvc.currentPixels()!.rgb)).toEqual([99, 88, 77]);
    stop();
  });

  it('a null sample leaves the previous pixels in place', () => {
    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const sample = host.pipeline.scopeSample as WritableSignal<DecodedImage | null>;
    const stop = wireScopeSampleEffect(host, TestBed.inject(Injector));

    sample.set({
      width: 1,
      height: 1,
      rgb: new Uint8Array([1, 2, 3]),
      asShotTemperature: 6500,
      asShotTint: 0,
    });
    TestBed.flushEffects();

    // A readback miss must not blank the scopes to their pseudo fallback.
    sample.set(null);
    TestBed.flushEffects();
    expect(Array.from(host.canvasSvc.currentPixels()!.rgb)).toEqual([1, 2, 3]);
    stop();
  });
});
