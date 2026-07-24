// RawPipelineService — Plan 3 M1 scene-linear decode round-trip test.
//
// Mocks the Worker constructor so the service's posted request and the
// worker's reply are exchanged synchronously through a Subject. The WASM
// render itself is exercised by raw-core's fixture-gated tests; this
// spec covers the TS plumbing on the main-thread side.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { decodeNonRawToSceneLinear } from './image-utils';
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
      nativeWidth: w,
      nativeHeight: h,
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

describe('RawPipelineService — performance-mark deadlock guard (#1123)', () => {
  // #1123: `performance.measure` THROWS if either named mark was cleared out from
  // under it (DevTools' `performance.clearMarks()`, a monitoring shim, or a test
  // harness can do this anytime — the Performance Timeline is a single shared,
  // mutable buffer). Before the fix, the mark/measure pair ran INSIDE the pending
  // handler's `resolve` wrapper, un-guarded — a throw there meant the real
  // `resolve(result)` call one line below never ran. Because every decode is
  // serialized behind `decodeChain`, that one stranded decode permanently wedged
  // every later decode too. These specs simulate the throw and assert the promise
  // still settles and the chain still drains.
  let workerStub: WorkerStub;
  let originalWorker: typeof Worker;
  let originalMeasure: typeof performance.measure;

  beforeEach(() => {
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
    TestBed.configureTestingModule({});
    originalMeasure = performance.measure.bind(performance);
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'Worker', {
      value: originalWorker,
      writable: true,
      configurable: true,
    });
    performance.measure = originalMeasure;
  });

  it('still resolves decode() when performance.measure throws (simulated cleared mark)', async () => {
    performance.measure = vi.fn(() => {
      throw new DOMException(
        "Failed to execute 'measure' on 'Performance': The mark 'maple:decode:1:start' does not exist.",
        'SyntaxError',
      );
    });

    const service = TestBed.inject(RawPipelineService);
    const promise = service.decode(new Uint8Array([0x44]), 'dng');

    await Promise.resolve();
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    const rgb = new Uint8Array(3).fill(0x22);
    workerStub.reply({
      id: sent.id,
      type: 'decode-success',
      width: 1,
      height: 1,
      nativeWidth: 1,
      nativeHeight: 1,
      rgb: rgb.buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    } satisfies DecodeSuccess);

    // Before the fix, this hangs forever — the throw inside the un-guarded
    // resolve wrapper strands the promise (never resolves, never rejects).
    const decoded = await promise;
    expect(decoded.rgb[0]).toBe(0x22);
  });

  it('does not deadlock decodeChain: a second decode still runs after a measure throw', async () => {
    performance.measure = vi.fn(() => {
      throw new Error('simulated Performance Timeline throw');
    });

    const service = TestBed.inject(RawPipelineService);
    const p1 = service.decode(new Uint8Array([0x01]), 'dng');
    const p2 = service.decode(new Uint8Array([0x02]), 'dng');

    await Promise.resolve();
    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
    const first = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    workerStub.reply({
      id: first.id,
      type: 'decode-success',
      width: 1,
      height: 1,
      nativeWidth: 1,
      nativeHeight: 1,
      rgb: new Uint8Array(3).fill(0x11).buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    } satisfies DecodeSuccess);
    await p1;

    // decodeChain must have advanced — the second decode posts next.
    await Promise.resolve();
    expect(workerStub.postMessage).toHaveBeenCalledTimes(2);
    const second = workerStub.postMessage.mock.calls[1][0] as DecodeRequest;
    workerStub.reply({
      id: second.id,
      type: 'decode-success',
      width: 1,
      height: 1,
      nativeWidth: 1,
      nativeHeight: 1,
      rgb: new Uint8Array(3).fill(0x22).buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    } satisfies DecodeSuccess);
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
      nativeWidth: w,
      nativeHeight: h,
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

  it('threads the develop XMP into the decode request (#846)', async () => {
    const service = TestBed.inject(RawPipelineService);
    const xmp = '<?xpacket begin="" ?><x:xmpmeta><test crs:Exposure2012="1.0"/></x:xmpmeta>';
    const promise = service.decode(new Uint8Array([0x44]), 'dng', xmp);

    await Promise.resolve();
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    expect(sent.type).toBe('decode');
    expect(sent.xmp).toBe(xmp);

    const rgb = new Uint8Array(1 * 1 * 3).fill(0x40);
    workerStub.reply({
      id: sent.id,
      type: 'decode-success',
      width: 1,
      height: 1,
      nativeWidth: 1,
      nativeHeight: 1,
      rgb: rgb.buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    } satisfies DecodeSuccess);
    await promise;
  });

  it('leaves xmp undefined on a cold-open decode (#846)', async () => {
    const service = TestBed.inject(RawPipelineService);
    const promise = service.decode(new Uint8Array([0x44]), 'dng');

    await Promise.resolve();
    const sent = workerStub.postMessage.mock.calls[0][0] as DecodeRequest;
    expect(sent.xmp).toBeUndefined();

    const rgb = new Uint8Array(3).fill(0x10);
    workerStub.reply({
      id: sent.id,
      type: 'decode-success',
      width: 1,
      height: 1,
      nativeWidth: 1,
      nativeHeight: 1,
      rgb: rgb.buffer,
      asShotTemperature: 5500,
      asShotTint: 0,
    } satisfies DecodeSuccess);
    await promise;
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

describe('RawPipelineService — non-RAW browser-native decode (#784)', () => {
  // Non-RAW images (jpg/png/heic/…) must NOT go through the WASM RAW
  // decoder. Both decode() and decodeSceneLinear() branch on extension and
  // decode browser-natively instead. These tests stub createImageBitmap +
  // OffscreenCanvas (jsdom has neither) and assert the Worker is never
  // touched for non-RAW input.
  let workerStub: WorkerStub;
  let originalWorker: typeof Worker;
  let originalCreateImageBitmap: typeof globalThis.createImageBitmap;
  let originalOffscreenCanvas: typeof globalThis.OffscreenCanvas;

  // A 2x2 mid-grey image: every RGBA sample is (128,128,128,255).
  const W = 2;
  const H = 2;
  const greyData = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < greyData.length; i += 4) {
    greyData[i] = 128;
    greyData[i + 1] = 128;
    greyData[i + 2] = 128;
    greyData[i + 3] = 255;
  }

  beforeEach(() => {
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

    // Stub createImageBitmap → a fake bitmap of known size.
    originalCreateImageBitmap = globalThis.createImageBitmap;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      value: vi.fn(async () => ({ width: W, height: H, close: vi.fn() })),
      writable: true,
      configurable: true,
    });

    // Stub OffscreenCanvas → a 2D context that returns the grey pixels.
    originalOffscreenCanvas = globalThis.OffscreenCanvas;
    class OffscreenCanvasStub {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          drawImage: vi.fn(),
          getImageData: () => ({ data: greyData, width: W, height: H }),
        };
      }
    }
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      value: OffscreenCanvasStub,
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
    Object.defineProperty(globalThis, 'createImageBitmap', {
      value: originalCreateImageBitmap,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      value: originalOffscreenCanvas,
      writable: true,
      configurable: true,
    });
  });

  it('decode() routes non-RAW to the browser and never posts to the worker', async () => {
    const service = TestBed.inject(RawPipelineService);
    const decoded = await service.decode(new Uint8Array([0xff, 0xd8]), 'jpg');

    expect(workerStub.postMessage).not.toHaveBeenCalled();
    expect(decoded.width).toBe(W);
    expect(decoded.height).toBe(H);
    expect(decoded.rgb).toBeInstanceOf(Uint8Array);
    expect(decoded.rgb.length).toBe(W * H * 3); // alpha dropped
    expect(decoded.rgb[0]).toBe(128);
    // Neutral WB so seedAsShotWhiteBalance no-ops (default 6500K / 0 tint).
    expect(decoded.asShotTemperature).toBe(6500);
    expect(decoded.asShotTint).toBe(0);
    // EXIF orientation must be applied by the browser decode so portrait
    // iPhone captures don't open sideways (parity with Apple's
    // CIImage.oriented(forExifOrientation:)).
    expect(globalThis.createImageBitmap).toHaveBeenCalledWith(expect.anything(), {
      imageOrientation: 'from-image',
    });
  });

  it('decodeSceneLinear() routes non-RAW to the browser and produces fp16 Rec.2020', async () => {
    const service = TestBed.inject(RawPipelineService);
    const decoded = await service.decodeSceneLinear(new Uint8Array([0x89, 0x50]), 'png');

    expect(workerStub.postMessage).not.toHaveBeenCalled();
    expect(decoded.width).toBe(W);
    expect(decoded.height).toBe(H);
    expect(decoded.fp16Rgba).toBeInstanceOf(Uint16Array);
    expect(decoded.fp16Rgba.length).toBe(W * H * 4);
    // Alpha lane is fp16 1.0.
    expect(decoded.fp16Rgba[3]).toBe(0x3c00);
    // 128/255 sRGB → ~0.2159 linear; neutral grey stays neutral through the
    // sRGB→Rec.2020 rotation (rows sum to ~1), so RGB lanes are equal and
    // non-zero. Decode the fp16 R lane back to f32 to sanity-check the range.
    const r = f16ToF32(decoded.fp16Rgba[0]);
    expect(r).toBeGreaterThan(0.18);
    expect(r).toBeLessThan(0.26);
    // Grey in → grey out (channels within a hair of each other).
    const g = f16ToF32(decoded.fp16Rgba[1]);
    const b = f16ToF32(decoded.fp16Rgba[2]);
    expect(Math.abs(r - g)).toBeLessThan(0.01);
    expect(Math.abs(r - b)).toBeLessThan(0.01);
    expect(decoded.asShotTemperature).toBe(6500);
    expect(decoded.asShotTint).toBe(0);
  });

  it('still routes RAW extensions through the worker', async () => {
    const service = TestBed.inject(RawPipelineService);
    void service.decode(new Uint8Array([0]), 'dng');
    await Promise.resolve();
    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('decodeNonRawToSceneLinear — sRGB→linear LUT exactness (#784)', () => {
  // The hot loop replaced per-pixel srgbToLinear(byte/255) with a 256-entry LUT.
  // Verify the LUT-driven fp16 output is bit-identical to the scalar formula for
  // representative bytes (0 = the linear-segment branch, 128 = mid, 255 = max).
  let originalCreateImageBitmap: typeof globalThis.createImageBitmap;
  let originalOffscreenCanvas: typeof globalThis.OffscreenCanvas;

  // Reference scalar path, copied from image-utils.ts, to diff against the LUT.
  const srgbToLinearScalar = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

  function setCanvasPixel(rByte: number, gByte: number, bByte: number): void {
    const data = new Uint8ClampedArray([rByte, gByte, bByte, 255]);
    originalCreateImageBitmap = globalThis.createImageBitmap;
    Object.defineProperty(globalThis, 'createImageBitmap', {
      value: vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
      writable: true,
      configurable: true,
    });
    originalOffscreenCanvas = globalThis.OffscreenCanvas;
    class OffscreenCanvasStub {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          drawImage: vi.fn(),
          getImageData: () => ({ data, width: 1, height: 1 }),
        };
      }
    }
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      value: OffscreenCanvasStub,
      writable: true,
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'createImageBitmap', {
      value: originalCreateImageBitmap,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      value: originalOffscreenCanvas,
      writable: true,
      configurable: true,
    });
  });

  for (const byte of [0, 128, 255]) {
    it(`matches the scalar sRGB→linear formula for byte ${byte}`, async () => {
      setCanvasPixel(byte, byte, byte);
      const decoded = await decodeNonRawToSceneLinear(new Uint8Array([0x89, 0x50]));

      // Grey in → equal linear channels; the fp16 lane round-trips back to the
      // scalar formula's value within fp16 quantization (~2^-11 relative).
      const expectedLin = srgbToLinearScalar(byte / 255);
      const r = f16ToF32(decoded.fp16Rgba[0]);
      // Rec.2020 rows sum to ~1, so neutral grey is preserved.
      expect(r).toBeCloseTo(expectedLin, 3);
      expect(decoded.fp16Rgba[3]).toBe(0x3c00);
    });
  }
});

/** Decode an IEEE-754 half (fp16) lane back to f32 for assertions. */
function f16ToF32(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  let value: number;
  if (exp === 0) {
    value = Math.pow(2, -14) * (frac / 1024); // subnormal
  } else if (exp === 0x1f) {
    value = frac ? NaN : Infinity;
  } else {
    value = Math.pow(2, exp - 15) * (1 + frac / 1024);
  }
  return sign ? -value : value;
}
