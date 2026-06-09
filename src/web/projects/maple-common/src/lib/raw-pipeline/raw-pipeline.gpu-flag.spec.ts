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

  beforeEach(() => install());

  afterEach(() => {
    Object.defineProperty(globalThis, 'Worker', {
      value: originalWorker,
      writable: true,
      configurable: true,
    });
  });

  it('defaults to gpu:false (flag-off == today, CPU render_bytes path)', async () => {
    // No provider override → the token's default factory (`false`).
    TestBed.configureTestingModule({});
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
});
