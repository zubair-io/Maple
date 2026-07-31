// ImageCanvasGpuPresent — per-session present-failure detection (#1572).
//
// Tests three behaviours introduced in #1572:
//   (a) A successful GPU present test keeps `active` true and returns `true` from `open()`.
//   (b) A failed GPU present test makes `open()` return `false` immediately.
//   (c) After a failed probe, every subsequent call to `open()` returns `false` immediately
//       without attempting another GPU session — the session-level static `presentBroken`
//       flag prevents re-detection on every image.

import { signal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ImageCanvasGpuPresent } from './image-canvas.gpu-present';
import type { GpuPresentHost } from './image-canvas.gpu-present';
import type { OpenedLiveSession } from '../../raw-pipeline/raw-pipeline.service';
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
  } as unknown as GpuPresentHost['pipeline'];

  const state = {
    updateAssetDimensions: vi.fn(),
    seedAsShotWhiteBalance: vi.fn(),
    adjustmentFor: vi.fn(() => signal(model)),
  } as unknown as GpuPresentHost['state'];

  const canvasSvc = {
    currentPixels: signal<DecodedImage | null>(null),
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
    gpuFallback,
    serializeForRender: () => '<x/>',
    loading,
    imageBitmap,
    currentAssetId: 'asset-1',
    renderGeneration: 1,
    lastRenderedXmp: null,
    markColdOpenDone: vi.fn(),
    currentLayout: () => ({ canvasW: 800, canvasH: 600, pan: { x: 0, y: 0 } }),
    viewportTargetLongEdge: () => 1440,
    recordNativeDims: vi.fn(),
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

  it('an insecure context reports "insecure-context" and never calls openLiveSession', async () => {
    // Downgrade patchDom()'s secure-context stub for this one test.
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

  it('missing navigator.gpu (no isSecureContext support at all) also reports "insecure-context"', async () => {
    delete (navigator as any).gpu;

    const host = makeHost(() => Promise.resolve(makeOpenedSession()));
    const gpuPresent = new ImageCanvasGpuPresent(host);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(false);
    expect(host.pipeline.openLiveSession).not.toHaveBeenCalled();
    expect(host.gpuFallback.visible()).toBe(true);
    expect(host.gpuFallback.message()).toContain('HTTPS');
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
