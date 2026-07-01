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

// ── DOM stubs ────────────────────────────────────────────────────────────────
// jsdom omits OffscreenCanvas / transferControlToOffscreen. Stub both so the
// `typeof OffscreenCanvas === 'undefined'` guard in `open()` doesn't short-
// circuit to `false` before we can test the present-detection path.

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
}

function unpatchDom(): void {
  HTMLCanvasElement.prototype.transferControlToOffscreen = originalTransferControl;
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    value: originalOffscreenCanvas,
    writable: true,
    configurable: true,
  });
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

function makeHost(openLiveSessionImpl: () => Promise<OpenedLiveSession>): GpuPresentHost {
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
    adjustmentFor: vi.fn(() => signal({ version: 0 })),
  } as unknown as GpuPresentHost['state'];

  const canvasSvc = {
    currentPixels: signal<DecodedImage | null>(null),
    pan: signal({ x: 0, y: 0 }),
  } as unknown as GpuPresentHost['canvasSvc'];

  const xmpSerializer = {
    serialize: vi.fn(() => '<x/>'),
  } as unknown as GpuPresentHost['xmpSerializer'];

  return {
    wrapRef: { nativeElement: wrapEl },
    pipeline,
    state,
    canvasSvc,
    xmpSerializer,
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
