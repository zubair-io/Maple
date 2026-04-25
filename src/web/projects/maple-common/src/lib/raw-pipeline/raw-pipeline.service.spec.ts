// RawPipelineService — Plan 3 M1 scene-linear decode round-trip test.
//
// Mocks the Worker constructor so the service's posted request and the
// worker's reply are exchanged synchronously through a Subject. The WASM
// render itself is exercised by raw-core's fixture-gated tests; this
// spec covers the TS plumbing on the main-thread side.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { RawPipelineService } from './raw-pipeline.service';
import type {
  DecodeRequest,
  DecodeSceneLinearRequest,
  DecodeSceneLinearSuccess,
  DecodeSuccess,
} from './raw-pipeline.types';

/**
 * Minimal Worker stub. Captures the most recently posted message and
 * exposes a `reply(...)` method the test calls to feed a response back
 * into the service's listener. Avoids spinning up a real Web Worker
 * (vitest's default jsdom environment doesn't bundle the WASM, and we
 * don't want this spec to be flaky on raw-wasm rebuilds).
 */
class WorkerStub {
  readonly postMessage = vi.fn<(msg: unknown, transfer?: Transferable[]) => void>();
  readonly terminate = vi.fn();
  private listeners: Record<string, ((e: unknown) => void)[]> = {
    message: [],
    error: [],
  };

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

describe('RawPipelineService — decodeSceneLinear (Plan 3 M1)', () => {
  let workerStub: WorkerStub;
  let originalWorker: typeof Worker;

  beforeEach(() => {
    workerStub = new WorkerStub();
    originalWorker = globalThis.Worker;
    // Replace the Worker constructor for the duration of the test. The
    // service's `new Worker(...)` call returns our stub.
    // The service uses `new Worker(...)`, so the global must be a real
    // constructor (not a vi.fn). Wrap workerStub in a class whose
    // constructor returns it (constructor return-object override).
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
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'Worker', {
      value: originalWorker,
      writable: true,
      configurable: true,
    });
  });

  it('round-trips a 2x2 scene-linear decode and exposes Uint16Array fp16 RGBA', async () => {
    const service = TestBed.inject(RawPipelineService);

    const inputBytes = new Uint8Array([0x44, 0x4e, 0x47, 0x00]); // junk DNG signature
    const promise = service.decodeSceneLinear(inputBytes, 'dng', undefined, true);

    // The service posts its request on `decodeChain.then(...)`, which is
    // a microtask. Flush it.
    await Promise.resolve();
    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeSceneLinearRequest;
    expect(sent.type).toBe('decode-scene-linear');
    expect(sent.ext).toBe('dng');
    expect(sent.qualityPreview).toBe(true);
    expect(sent.bytes).toBeInstanceOf(ArrayBuffer);

    // Build a synthetic 2x2 fp16 RGBA buffer: 2*2*4 = 16 lanes, 32 bytes.
    // Alpha lane (0x3c00) every 4th u16; rest zero. This matches the
    // bit-pattern Apple's MapleSceneLinearBuffer would produce on a
    // black 2x2 input.
    const w = 2;
    const h = 2;
    const lanes = new Uint16Array(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      lanes[i * 4 + 3] = 0x3c00; // fp16 1.0
    }
    const fp16Rgba = lanes.buffer;

    const reply: DecodeSceneLinearSuccess = {
      id: sent.id,
      type: 'decode-scene-linear-success',
      width: w,
      height: h,
      fp16Rgba,
      asShotTemperature: 5500,
      asShotTint: 0,
    };
    workerStub.reply(reply);

    const decoded = await promise;
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(decoded.fp16Rgba).toBeInstanceOf(Uint16Array);
    expect(decoded.fp16Rgba.length).toBe(w * h * 4);
    // Alpha lane preserved.
    for (let i = 0; i < w * h; i += 1) {
      expect(decoded.fp16Rgba[i * 4 + 3]).toBe(0x3c00);
    }
    expect(decoded.asShotTemperature).toBe(5500);
    expect(decoded.asShotTint).toBe(0);
  });

  it('rejects when the worker posts a decode-scene-linear-error', async () => {
    const service = TestBed.inject(RawPipelineService);
    const promise = service.decodeSceneLinear(new Uint8Array([0]), 'dng');

    await Promise.resolve();
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeSceneLinearRequest;
    workerStub.reply({
      id: sent.id,
      type: 'decode-scene-linear-error',
      message: 'simulated decode failure',
    });

    await expect(promise).rejects.toThrow('simulated decode failure');
  });

  it('serialises two concurrent scene-linear decodes through decodeChain', async () => {
    const service = TestBed.inject(RawPipelineService);
    const p1 = service.decodeSceneLinear(new Uint8Array([0]), 'dng');
    const p2 = service.decodeSceneLinear(new Uint8Array([1]), 'dng');

    await Promise.resolve();
    // Only the first request should have been posted at this point.
    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
    const first = workerStub.postMessage.mock.calls[0][0] as DecodeSceneLinearRequest;

    // Resolve the first; the second should then post.
    workerStub.reply({
      id: first.id,
      type: 'decode-scene-linear-success',
      width: 1,
      height: 1,
      fp16Rgba: new Uint16Array([0, 0, 0, 0x3c00]).buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    });
    await p1;
    await Promise.resolve();
    expect(workerStub.postMessage).toHaveBeenCalledTimes(2);
    const second = workerStub.postMessage.mock.calls[1][0] as DecodeSceneLinearRequest;
    workerStub.reply({
      id: second.id,
      type: 'decode-scene-linear-success',
      width: 1,
      height: 1,
      fp16Rgba: new Uint16Array([0, 0, 0, 0x3c00]).buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    });
    await p2;
  });
});

describe('RawPipelineService — legacy decode() regression (Plan 3 M1)', () => {
  // Confirms Task 4's discriminated-union widening did not break the legacy
  // sRGB decode path. Plan 3 M1's invariant is "purely additive — the
  // legacy `render_bytes` path stays the production path." If the
  // `pending` map's `kind: 'legacy'` discriminant or the listener's
  // type-narrowing regresses, this test fires.
  let workerStub: WorkerStub;
  let originalWorker: typeof Worker;

  beforeEach(() => {
    workerStub = new WorkerStub();
    originalWorker = globalThis.Worker;
    // The service uses `new Worker(...)`, so the global must be a real
    // constructor (not a vi.fn). Wrap workerStub in a class whose
    // constructor returns it (constructor return-object override).
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
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'Worker', {
      value: originalWorker,
      writable: true,
      configurable: true,
    });
  });

  it('round-trips a legacy decode and exposes Uint8Array sRGB RGB', async () => {
    const service = TestBed.inject(RawPipelineService);
    const inputBytes = new Uint8Array([0x44, 0x4e, 0x47, 0x00]);
    const promise = service.decode(inputBytes, 'dng');

    await Promise.resolve();
    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    expect(sent.type).toBe('decode');
    expect(sent.ext).toBe('dng');
    expect(sent.bytes).toBeInstanceOf(ArrayBuffer);

    // Build a synthetic 2x2 sRGB RGB buffer: 2*2*3 = 12 bytes.
    const w = 2;
    const h = 2;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = 0x80;
    const reply: DecodeSuccess = {
      id: sent.id,
      type: 'decode-success',
      width: w,
      height: h,
      rgb: rgb.buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    };
    workerStub.reply(reply);

    const decoded = await promise;
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(decoded.rgb).toBeInstanceOf(Uint8Array);
    expect(decoded.rgb.length).toBe(w * h * 3);
    expect(decoded.rgb[0]).toBe(0x80);
    expect(decoded.asShotTemperature).toBe(5500);
    expect(decoded.asShotTint).toBe(0);
  });

  it('rejects when the worker posts a decode-error', async () => {
    const service = TestBed.inject(RawPipelineService);
    const promise = service.decode(new Uint8Array([0]), 'dng');

    await Promise.resolve();
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    workerStub.reply({
      id: sent.id,
      type: 'decode-error',
      message: 'simulated legacy decode failure',
    });

    await expect(promise).rejects.toThrow('simulated legacy decode failure');
  });
});
