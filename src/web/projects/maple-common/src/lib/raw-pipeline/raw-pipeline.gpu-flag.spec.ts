// RawPipelineService — GPU live-render flag routing (epic #925, P4b-web / #1029).
//
// The autonomous TS-side gate for W2: the `GPU_LIVE_RENDER_ENABLED` token must
// flow into the worker request's `gpu` field so the worker can route the render
// through `render_bytes_gpu` (the GPU live chain) instead of `render_bytes`. The
// worker's actual entry SELECTION (gpu-vs-cpu) needs the real WASM module and a
// WebGPU browser — that's the W3 user checkpoint — so this spec covers the flag
// PLUMBING (main-thread → request), which is what makes flag-off == today and a
// flag-on opt-in observable. Mirrors the legacy-decode WorkerStub harness in
// `raw-pipeline.service.spec.ts`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { RawPipelineService } from './raw-pipeline.service';
import { GPU_LIVE_RENDER_ENABLED } from './gpu-live-render.token';
import { GpuLiveRenderGate } from './gpu-live-render.gate';
import { STORAGE_KEYS, TypedStorage } from '../util/typed-storage';
import type { DecodeRequest, DecodeSuccess } from './raw-pipeline.types';

/** Minimal Worker stub — captures the posted request, replays a reply. */
class WorkerStub {
  readonly postMessage = vi.fn<(msg: unknown, transfer?: Transferable[]) => void>();
  readonly terminate = vi.fn();
  private listeners: Record<string, ((e: unknown) => void)[]> = { message: [], error: [] };

  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn);
  }
  dispatchEvent(_e: Event): boolean {
    return true;
  }
  reply(payload: unknown): void {
    for (const fn of this.listeners['message'] ?? []) {
      fn({ data: payload } as unknown as MessageEvent);
    }
  }
}

/** Resolve an in-flight legacy decode by replying with a 1×1 sRGB pixel. */
function replyOnePixel(stub: WorkerStub, id: number): void {
  const rgb = new Uint8Array(3).fill(0x40);
  stub.reply({
    id,
    type: 'decode-success',
    width: 1,
    height: 1,
    nativeWidth: 1,
    nativeHeight: 1,
    rgb: rgb.buffer,
    asShotTemperature: 5500,
    asShotTint: 0,
  } satisfies DecodeSuccess);
}

describe('RawPipelineService — GPU live-render flag routing (#1029)', () => {
  let workerStub: WorkerStub;
  let originalWorker: typeof Worker;

  function install(): void {
    workerStub = new WorkerStub();
    originalWorker = globalThis.Worker;
    const stub = workerStub;
    class WorkerCtor {
      constructor(_url: URL, _opts?: WorkerOptions) {
        return stub as unknown as Worker;
      }
    }
    Object.defineProperty(globalThis, 'Worker', {
      value: WorkerCtor,
      writable: true,
      configurable: true,
    });
  }

  beforeEach(() => {
    // #1062: the gate warm-starts from localStorage, so clear any cached
    // operator value — these cases exercise the build-time token alone.
    TypedStorage.remove(STORAGE_KEYS.GPU_LIVE_RENDER_ENABLED);
    install();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'Worker', {
      value: originalWorker,
      writable: true,
      configurable: true,
    });
  });

  it('defaults to gpu:true (GPU live-render is the shipping default, #1059)', async () => {
    // No provider override → the token's default factory (now `true`, #1059). The
    // request carries gpu:true; the worker still gates the ACTUAL GPU entry on
    // `'gpu' in navigator` + the bundle export + an adapter-failure CPU fallback,
    // so a no-WebGPU host stays on the threaded-CPU `render_bytes` path.
    TestBed.configureTestingModule({});
    const service = TestBed.inject(RawPipelineService);

    const promise = service.decode(new Uint8Array([0x44, 0x4e, 0x47, 0x00]), 'dng');
    await Promise.resolve(); // flush the decodeChain microtask

    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    expect(sent.type).toBe('decode');
    expect(sent.gpu).toBe(true);

    replyOnePixel(workerStub, sent.id);
    await promise;
  });

  it('operator kill-switch (useValue:false) sends gpu:false (CPU render_bytes path)', async () => {
    // Overriding the token to `false` is the operator off-switch (#1059): the
    // request carries gpu:false, so the worker takes the unchanged threaded-CPU
    // `render_bytes` path — byte-for-byte today's behaviour everywhere.
    TestBed.configureTestingModule({
      providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: false }],
    });
    const service = TestBed.inject(RawPipelineService);

    const promise = service.decode(new Uint8Array([0x44, 0x4e, 0x47, 0x00]), 'dng');
    await Promise.resolve(); // flush the decodeChain microtask

    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    expect(sent.type).toBe('decode');
    expect(sent.gpu).toBe(false);

    replyOnePixel(workerStub, sent.id);
    await promise;
  });

  it('sets gpu:true on the request when GPU_LIVE_RENDER_ENABLED is true', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: true }],
    });
    const service = TestBed.inject(RawPipelineService);

    const promise = service.decode(new Uint8Array([0x44, 0x4e, 0x47, 0x00]), 'dng');
    await Promise.resolve();

    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    expect(sent.type).toBe('decode');
    expect(sent.gpu).toBe(true);
    // The response shape is identical (u8 RGB), so the decode resolves the same
    // way regardless of which entry the worker picks.
    replyOnePixel(workerStub, sent.id);
    const decoded = await promise;
    expect(decoded.rgb).toBeInstanceOf(Uint8Array);
    expect(decoded.rgb.length).toBe(3);
  });

  it('an operator kill mid-session lands on the NEXT decode (#1062)', async () => {
    // The flag is read per request, not captured at construction, so a flip
    // arriving on the config poll does not need a reload to take effect.
    TestBed.configureTestingModule({});
    const service = TestBed.inject(RawPipelineService);
    const gate = TestBed.inject(GpuLiveRenderGate);

    const first = service.decode(new Uint8Array([0x44]), 'dng');
    await Promise.resolve();
    const sentBefore = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    expect(sentBefore.gpu).toBe(true);
    replyOnePixel(workerStub, sentBefore.id);
    await first;

    gate.apply(false);
    expect(service.gpuLiveRenderEnabled).toBe(false);

    const second = service.decode(new Uint8Array([0x44]), 'dng');
    await Promise.resolve();
    const sentAfter = workerStub.postMessage.mock.calls[1][0] as DecodeRequest;
    expect(sentAfter.gpu).toBe(false);
    replyOnePixel(workerStub, sentAfter.id);
    await second;
  });

  it('carries the flag alongside the develop XMP (re-render path, #846)', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: true }],
    });
    const service = TestBed.inject(RawPipelineService);

    const xmp = '<?xpacket begin="" ?><x:xmpmeta><test crs:Exposure2012="1.0"/></x:xmpmeta>';
    const promise = service.decode(new Uint8Array([0x44]), 'dng', xmp);
    await Promise.resolve();

    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    expect(sent.xmp).toBe(xmp);
    expect(sent.gpu).toBe(true);

    replyOnePixel(workerStub, sent.id);
    await promise;
  });

  // ── Persistent live session plumbing (epic #925, P4b-web / #1038) ──────────
  // The 16ms-ready path: the service posts open/render/close-session messages and
  // transfers the OffscreenCanvas. Worker-side WebLiveSession selection + the GPU
  // pixels are the W3 checkpoint; this gates the main-thread → worker plumbing.

  it('gpuLiveRenderEnabled reflects the token', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: true }],
    });
    expect(TestBed.inject(RawPipelineService).gpuLiveRenderEnabled).toBe(true);
  });

  it('openLiveSession posts open-session and TRANSFERS the OffscreenCanvas', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: true }],
    });
    const service = TestBed.inject(RawPipelineService);
    const canvas = {} as OffscreenCanvas;

    const promise = service.openLiveSession(canvas, new Uint8Array([0x44, 0x4e, 0x47]), 'dng');
    await Promise.resolve();

    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
    const [msg, transfer] = workerStub.postMessage.mock.calls[0] as [
      { type: string; ext: string; canvas: OffscreenCanvas },
      Transferable[],
    ];
    expect(msg.type).toBe('open-session');
    expect(msg.ext).toBe('dng');
    expect(msg.canvas).toBe(canvas);
    // BOTH the byte buffer and the canvas must be in the transfer list.
    expect(transfer).toContain(canvas);
    expect(transfer.length).toBe(2);

    // Resolve the open so the promise settles.
    workerStub.reply({
      id: (msg as unknown as { id: number }).id,
      type: 'open-session-success',
      width: 4000,
      height: 3000,
      asShotTemperature: 5200,
      asShotTint: 0,
      colorSpace: 'display-p3',
    });
    const info = await promise;
    expect(info.width).toBe(4000);
    expect(info.colorSpace).toBe('display-p3');
  });

  it('renderLiveSession posts render-session and resolves the colour-space tag', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: true }],
    });
    const service = TestBed.inject(RawPipelineService);

    const xmp = '<x:xmpmeta><t crs:Exposure2012="0.5"/></x:xmpmeta>';
    const promise = service.renderLiveSession(xmp);
    await Promise.resolve();

    const msg = workerStub.postMessage.mock.calls[0][0] as {
      type: string;
      xmp: string;
      id: number;
    };
    expect(msg.type).toBe('render-session');
    expect(msg.xmp).toBe(xmp);

    workerStub.reply({ id: msg.id, type: 'render-session-success', colorSpace: 'srgb' });
    const result = await promise;
    expect(result.colorSpace).toBe('srgb');
    // No `scope` in the reply → no readback pixels (scopes keep their fallback).
    expect(result.scopePixels).toBeUndefined();
  });

  it('threads a scope readback snapshot from open + render into DecodedImage (#1045)', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: true }],
    });
    const service = TestBed.inject(RawPipelineService);

    // Open: reply with a 2×1 RGB scope snapshot folded into the success message.
    const openPromise = service.openLiveSession(
      {} as OffscreenCanvas,
      new Uint8Array([0x44]),
      'dng',
    );
    await Promise.resolve();
    const openMsg = workerStub.postMessage.mock.calls[0][0] as { id: number };
    const openRgb = new Uint8Array([10, 20, 30, 40, 50, 60]); // 2 px
    workerStub.reply({
      id: openMsg.id,
      type: 'open-session-success',
      width: 4000,
      height: 3000,
      asShotTemperature: 5200,
      asShotTint: 0,
      colorSpace: 'display-p3',
      scope: { width: 2, height: 1, rgb: openRgb.buffer },
    });
    const opened = await openPromise;
    expect(opened.scopePixels).toBeDefined();
    expect(opened.scopePixels!.width).toBe(2);
    expect(opened.scopePixels!.rgb).toBeInstanceOf(Uint8Array);
    expect(Array.from(opened.scopePixels!.rgb)).toEqual([10, 20, 30, 40, 50, 60]);

    // Render: same fold-in on the edit path.
    const renderPromise = service.renderLiveSession('<x/>');
    await Promise.resolve();
    const renderMsg = workerStub.postMessage.mock.calls[1][0] as { id: number };
    const renderRgb = new Uint8Array([1, 2, 3]); // 1 px
    workerStub.reply({
      id: renderMsg.id,
      type: 'render-session-success',
      colorSpace: 'srgb',
      scope: { width: 1, height: 1, rgb: renderRgb.buffer },
    });
    const rendered = await renderPromise;
    expect(rendered.scopePixels).toBeDefined();
    expect(Array.from(rendered.scopePixels!.rgb)).toEqual([1, 2, 3]);
  });

  it('a session-error rejects the open promise (component then falls back)', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: true }],
    });
    const service = TestBed.inject(RawPipelineService);

    const promise = service.openLiveSession({} as OffscreenCanvas, new Uint8Array([0x44]), 'dng');
    await Promise.resolve();
    const msg = workerStub.postMessage.mock.calls[0][0] as { id: number };
    workerStub.reply({ id: msg.id, type: 'session-error', message: 'WebLiveSession unavailable' });

    await expect(promise).rejects.toThrow('WebLiveSession unavailable');
  });
});
