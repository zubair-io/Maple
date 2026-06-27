// ImageCanvasGpuPresent — per-session present-failure detection (#1572).
//
// Tests three behaviours introduced in #1572:
//   (a) A successful GPU present (non-black scope snapshot) keeps `active` true
//       and returns `true` from `open()`.
//   (b) A black scope snapshot (GPU session opened but canvas stayed blank)
//       tears down the session and makes `open()` return `false`, falling
//       back to the 2D path.
//   (c) After a black present, every subsequent call to `open()` returns
//       `false` immediately without attempting another GPU session — the
//       session-level `presentBroken` flag prevents re-detection on every image.
//
// The OffscreenCanvas / transferControlToOffscreen APIs are stubbed so the
// tests run in jsdom (no real WebGPU). The pipeline calls are mocked directly
// on the host object; this spec tests ONLY the present-detection logic in
// `ImageCanvasGpuPresent`, not the worker plumbing (covered by
// `raw-pipeline.gpu-flag.spec.ts`).

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

let transferCalledOn: HTMLCanvasElement | null = null;

function patchDom(): void {
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    value: OffscreenCanvasStub,
    writable: true,
    configurable: true,
  });
  HTMLCanvasElement.prototype.transferControlToOffscreen = function () {
    transferCalledOn = this;
    return new OffscreenCanvasStub(0, 0) as unknown as OffscreenCanvas;
  };
}

function unpatchDom(): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete (HTMLCanvasElement.prototype as { transferControlToOffscreen?: unknown })
    .transferControlToOffscreen;
  // Restore OffscreenCanvas to its jsdom state (undefined).
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRgb(fill: number, length = 48): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function makeScopePixels(fill: number): DecodedImage {
  return {
    width: 4,
    height: 4,
    rgb: makeRgb(fill, 4 * 4 * 3),
    asShotTemperature: 5500,
    asShotTint: 0,
  };
}

function makeOpenedSession(scopePixels?: DecodedImage): OpenedLiveSession {
  return {
    width: 800,
    height: 600,
    nativeWidth: 4000,
    nativeHeight: 3000,
    asShotTemperature: 5500,
    asShotTint: 0,
    colorSpace: 'display-p3',
    scopePixels,
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
    transferCalledOn = null;
  });

  afterEach(() => {
    unpatchDom();
  });

  it('(a) non-black scopePixels → open() returns true and active stays set', async () => {
    // scopePixels.rgb has non-zero values → present succeeded.
    const host = makeHost(() => Promise.resolve(makeOpenedSession(makeScopePixels(0x80))));
    const gpuPresent = new ImageCanvasGpuPresent(host);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(true);
    expect(gpuPresent.active()).toBe(true);
    // The pipeline was called exactly once.
    expect((host.pipeline.openLiveSession as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('(b) all-black scopePixels → open() returns false, active stays false, session torn down', async () => {
    // scopePixels.rgb is all zeros → present failed (canvas stayed black).
    const host = makeHost(() => Promise.resolve(makeOpenedSession(makeScopePixels(0x00))));
    const gpuPresent = new ImageCanvasGpuPresent(host);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(false);
    expect(gpuPresent.active()).toBe(false);
    // The session teardown must have been requested.
    expect(
      (host.pipeline.closeLiveSession as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('(b) near-black (≤4) scopePixels → also treated as failed present', async () => {
    // Threshold is 4 — all channels at 4 or below → black present.
    const host = makeHost(() => Promise.resolve(makeOpenedSession(makeScopePixels(4))));
    const gpuPresent = new ImageCanvasGpuPresent(host);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(false);
  });

  it('(b) barely above threshold (5) → treated as successful present', async () => {
    // A channel value of 5 crosses the threshold — present is real.
    const host = makeHost(() => Promise.resolve(makeOpenedSession(makeScopePixels(5))));
    const gpuPresent = new ImageCanvasGpuPresent(host);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    expect(result).toBe(true);
    expect(gpuPresent.active()).toBe(true);
  });

  it('(b) scopePixels undefined → unknown readback; session is NOT torn down as black-present', async () => {
    // Worker couldn't read back the canvas (context miss, etc.). Don't penalise
    // the GPU path for an unrelated readback failure.
    const host = makeHost(() => Promise.resolve(makeOpenedSession(undefined)));
    const gpuPresent = new ImageCanvasGpuPresent(host);

    const result = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');

    // Present is accepted — no black-present teardown.
    expect(result).toBe(true);
    expect(gpuPresent.active()).toBe(true);
  });

  it('(c) after a black present, subsequent open() returns false immediately without opening a session', async () => {
    let callCount = 0;
    const host = makeHost(() => {
      callCount++;
      return Promise.resolve(makeOpenedSession(makeScopePixels(0x00)));
    });
    const gpuPresent = new ImageCanvasGpuPresent(host);

    // First open: black present → marks presentBroken.
    const first = await gpuPresent.open('asset-1', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');
    expect(first).toBe(false);
    expect(callCount).toBe(1);

    // Second open (different asset): must return false immediately, no new session.
    const second = await gpuPresent.open('asset-2', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');
    expect(second).toBe(false);
    // openLiveSession must NOT have been called again.
    expect(callCount).toBe(1);

    // Third open: same — still short-circuits.
    const third = await gpuPresent.open('asset-3', new Uint8Array([0x44, 0x4e, 0x47]), 'dng');
    expect(third).toBe(false);
    expect(callCount).toBe(1);
  });
});
