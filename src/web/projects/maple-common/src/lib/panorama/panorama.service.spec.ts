// panorama.service.spec.ts — Unit tests for PanoramaService.
//
// Mocks the Worker constructor so the RPC layer can be tested synchronously
// without spinning up a real Web Worker or a real WASM module.
//
// What is tested here:
//   - Worker is lazy-created on first stitch() call.
//   - The correct message shape (id, type, images, options) is posted.
//   - Resolves with StitchResult when the worker replies { ok: true }.
//   - Rejects when the worker replies { ok: false }.
//   - Throws "already in progress" synchronously if called while busy.
//   - ngOnDestroy() terminates the worker and rejects pending promises.
//
// What is NOT tested here:
//   - The actual stitch algorithm (covered by Rust pano-core tests).
//   - The WASM loading path (exercised by the manual smoke run).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { PanoramaService } from './panorama.service';

// ---------------------------------------------------------------------------
// WorkerStub
// ---------------------------------------------------------------------------

/**
 * Minimal Worker stub.  Captures the most-recently posted message and
 * exposes `reply(...)` so tests can feed a response back into the service's
 * onmessage handler.
 */
class WorkerStub {
  readonly postMessage = vi.fn<(msg: unknown, transfer?: Transferable[]) => void>();
  readonly terminate = vi.fn();

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  /** Deliver a worker reply to the service's onmessage handler. */
  reply(payload: unknown): void {
    this.onmessage?.({ data: payload } as MessageEvent);
  }

  /** Trigger the service's onerror handler. */
  triggerError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImages(n = 2): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => new Uint8Array([i, i + 1, i + 2]));
}

function makeF16Buffer(width: number, height: number): ArrayBuffer {
  // f16 RGB: width × height × 3 u16 values.
  return new ArrayBuffer(width * height * 3 * 2);
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

describe('PanoramaService', () => {
  let workerStub: WorkerStub;
  let originalWorker: typeof Worker;

  beforeEach(() => {
    workerStub = new WorkerStub();
    originalWorker = globalThis.Worker;

    const stub = workerStub;
    // The service calls `new Worker(url, opts)` — return the stub.
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

  // -------------------------------------------------------------------------
  // Worker creation
  // -------------------------------------------------------------------------

  it('does not create the worker before stitch() is called', () => {
    // Spy on the Worker constructor.
    const ctor = vi.fn(() => workerStub as unknown as Worker);
    Object.defineProperty(globalThis, 'Worker', {
      value: ctor,
      writable: true,
      configurable: true,
    });
    TestBed.inject(PanoramaService);
    expect(ctor).not.toHaveBeenCalled();
  });

  it('creates the worker lazily on first stitch() call', async () => {
    const service = TestBed.inject(PanoramaService);

    const promise = service.stitch(makeImages());
    // Worker must have been created (stub registered).
    expect(workerStub.postMessage).toHaveBeenCalledTimes(1);

    // Resolve to avoid a hanging promise.
    const sent = workerStub.postMessage.mock.calls[0][0] as { id: number };
    workerStub.reply({ id: sent.id, ok: true, width: 4, height: 2, pixelsF16: makeF16Buffer(4, 2) });
    await promise;
  });

  it('reuses the same worker across multiple stitch() calls', async () => {
    const service = TestBed.inject(PanoramaService);

    // First stitch.
    const p1 = service.stitch(makeImages());
    const id1 = (workerStub.postMessage.mock.calls[0][0] as { id: number }).id;
    workerStub.reply({ id: id1, ok: true, width: 4, height: 2, pixelsF16: makeF16Buffer(4, 2) });
    await p1;

    // Second stitch.
    const p2 = service.stitch(makeImages());
    // Still 2 calls on the same stub, not a fresh one.
    expect(workerStub.postMessage).toHaveBeenCalledTimes(2);
    const id2 = (workerStub.postMessage.mock.calls[1][0] as { id: number }).id;
    workerStub.reply({ id: id2, ok: true, width: 4, height: 2, pixelsF16: makeF16Buffer(4, 2) });
    await p2;
  });

  // -------------------------------------------------------------------------
  // Message shape
  // -------------------------------------------------------------------------

  it('posts the correct message shape for a default stitch', async () => {
    const service = TestBed.inject(PanoramaService);

    const promise = service.stitch(makeImages(2));
    const sent = workerStub.postMessage.mock.calls[0][0] as {
      id: number;
      type: string;
      images: ArrayBuffer[];
      options: { projection: number; parallaxMode: number; maxDimension: number };
    };

    expect(sent.type).toBe('stitch');
    expect(sent.images).toHaveLength(2);
    expect(sent.images[0]).toBeInstanceOf(ArrayBuffer);
    // Default options: cylindrical (1), homography (0), unconstrained (0).
    expect(sent.options.projection).toBe(1);
    expect(sent.options.parallaxMode).toBe(0);
    expect(sent.options.maxDimension).toBe(0);

    // Clean up.
    workerStub.reply({ id: sent.id, ok: true, width: 4, height: 2, pixelsF16: makeF16Buffer(4, 2) });
    await promise;
  });

  it('maps StitchOptions correctly to numeric worker options', async () => {
    const service = TestBed.inject(PanoramaService);

    const promise = service.stitch(makeImages(3), {
      projection: 'spherical',
      parallaxMode: 'tps',
      maxDimension: 8192,
    });
    const sent = workerStub.postMessage.mock.calls[0][0] as {
      id: number;
      options: { projection: number; parallaxMode: number; maxDimension: number };
    };

    expect(sent.options.projection).toBe(2);    // spherical
    expect(sent.options.parallaxMode).toBe(1);  // tps
    expect(sent.options.maxDimension).toBe(8192);

    workerStub.reply({ id: sent.id, ok: true, width: 4, height: 2, pixelsF16: makeF16Buffer(4, 2) });
    await promise;
  });

  // -------------------------------------------------------------------------
  // ok: true reply
  // -------------------------------------------------------------------------

  it('resolves with StitchResult when the worker replies ok: true', async () => {
    const service = TestBed.inject(PanoramaService);

    const w = 10;
    const h = 5;
    const promise = service.stitch(makeImages());

    const sent = workerStub.postMessage.mock.calls[0][0] as { id: number };
    workerStub.reply({
      id: sent.id,
      ok: true,
      width: w,
      height: h,
      pixelsF16: makeF16Buffer(w, h),
    });

    const result = await promise;
    expect(result.width).toBe(w);
    expect(result.height).toBe(h);
    expect(result.pixelsF16).toBeInstanceOf(Uint16Array);
    expect(result.pixelsF16.length).toBe(w * h * 3);
  });

  // -------------------------------------------------------------------------
  // ok: false reply
  // -------------------------------------------------------------------------

  it('rejects when the worker replies ok: false', async () => {
    const service = TestBed.inject(PanoramaService);

    const promise = service.stitch(makeImages());
    const sent = workerStub.postMessage.mock.calls[0][0] as { id: number };
    workerStub.reply({ id: sent.id, ok: false, error: 'stitch failed: not enough matches' });

    await expect(promise).rejects.toThrow('stitch failed: not enough matches');
  });

  // -------------------------------------------------------------------------
  // Busy guard
  // -------------------------------------------------------------------------

  it('throws "already in progress" synchronously when busy', async () => {
    const service = TestBed.inject(PanoramaService);

    // First stitch — not yet resolved.
    const p1 = service.stitch(makeImages());
    expect(service.busy()).toBe(true);

    // Second concurrent call must throw immediately, not hang.
    await expect(service.stitch(makeImages())).rejects.toThrow(
      'a stitch is already in progress',
    );

    // Clean up first stitch.
    const id1 = (workerStub.postMessage.mock.calls[0][0] as { id: number }).id;
    workerStub.reply({ id: id1, ok: true, width: 4, height: 2, pixelsF16: makeF16Buffer(4, 2) });
    await p1;
  });

  it('resets busy to false after a successful stitch', async () => {
    const service = TestBed.inject(PanoramaService);

    const p = service.stitch(makeImages());
    expect(service.busy()).toBe(true);

    const sent = workerStub.postMessage.mock.calls[0][0] as { id: number };
    workerStub.reply({ id: sent.id, ok: true, width: 4, height: 2, pixelsF16: makeF16Buffer(4, 2) });
    await p;

    expect(service.busy()).toBe(false);
  });

  it('resets busy to false after a failed stitch', async () => {
    const service = TestBed.inject(PanoramaService);

    const p = service.stitch(makeImages());
    const sent = workerStub.postMessage.mock.calls[0][0] as { id: number };
    workerStub.reply({ id: sent.id, ok: false, error: 'boom' });

    await expect(p).rejects.toThrow();
    expect(service.busy()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  it('throws synchronously when fewer than 2 images are provided', async () => {
    const service = TestBed.inject(PanoramaService);

    await expect(service.stitch([new Uint8Array([1, 2, 3])])).rejects.toThrow(
      'stitch requires at least 2 images',
    );
    // No message should have been posted.
    expect(workerStub.postMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Destroy
  // -------------------------------------------------------------------------

  it('terminates the worker on ngOnDestroy', async () => {
    const service = TestBed.inject(PanoramaService);

    // Kick off a stitch to force worker creation.
    const p = service.stitch(makeImages());
    const sent = workerStub.postMessage.mock.calls[0][0] as { id: number };
    workerStub.reply({ id: sent.id, ok: true, width: 4, height: 2, pixelsF16: makeF16Buffer(4, 2) });
    await p;

    service.ngOnDestroy();
    expect(workerStub.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects pending promises on ngOnDestroy', async () => {
    const service = TestBed.inject(PanoramaService);

    const p = service.stitch(makeImages());
    // Destroy before the worker replies.
    service.ngOnDestroy();

    await expect(p).rejects.toThrow('PanoramaService destroyed');
  });

  // -------------------------------------------------------------------------
  // Worker error
  // -------------------------------------------------------------------------

  it('rejects pending promises when the worker fires an error event', async () => {
    const service = TestBed.inject(PanoramaService);

    const p = service.stitch(makeImages());
    workerStub.triggerError('WASM trap: unreachable');

    await expect(p).rejects.toThrow('WASM trap: unreachable');
  });
});
