// raw-pipeline.mask-raster-request.spec.ts — the worker protocol for the
// bitmap-mask raster registry (#3300): the request shapes the main thread
// posts, the transfer list, and how the replies settle the pending handler.
//
// PURE spec — no Angular TestBed, no raw-wasm import — so it runs under plain
// `bunx vitest run` as well as `ng test`, like
// `raw-pipeline.dispatch-postmessage.spec.ts`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { signal } from '@angular/core';

import {
  dispatchRegisterMaskRaster,
  releaseMaskRasterRequest,
} from './raw-pipeline.mask-raster-request';
import { handleWorkerMessage } from './raw-pipeline.worker-dispatch';
import type { PendingHandler } from './raw-pipeline.service-internals';
import type {
  RegisterMaskRasterRequest,
  ReleaseMaskRasterRequest,
} from './raw-pipeline.mask-raster.types';

function makeWorker(postMessage: (...args: unknown[]) => void): Worker {
  return { postMessage } as unknown as Worker;
}

const DIGEST = 'a1b2c3d4e5f60718';

/** A 2×2 raster carved out of a larger buffer, so the offset copy is exercised. */
const backing = new Uint8Array([9, 9, 0, 255, 255, 0, 9]);
const RASTER = backing.subarray(2, 6);

describe('dispatchRegisterMaskRaster (#3300)', () => {
  beforeEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  it('posts the request shape and transfers a private copy of the bytes', async () => {
    const post = vi.fn();
    const register = vi.fn();
    const promise = dispatchRegisterMaskRaster(makeWorker(post), 3, register, {
      digest: DIGEST,
      width: 2,
      height: 2,
      data: RASTER,
    });

    expect(post).toHaveBeenCalledTimes(1);
    const [request, transfer] = post.mock.calls[0] as [RegisterMaskRasterRequest, Transferable[]];
    expect(request).toMatchObject({
      id: 3,
      type: 'register-mask-raster',
      digest: DIGEST,
      width: 2,
      height: 2,
    });
    expect(Array.from(new Uint8Array(request.data))).toEqual([0, 255, 255, 0]);
    expect(transfer).toEqual([request.data]);
    // The transferred buffer is a copy — the caller's view is untouched.
    expect(request.data).not.toBe(backing.buffer);
    expect(Array.from(RASTER)).toEqual([0, 255, 255, 0]);
    expect(register).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ kind: 'register-mask-raster' }),
    );

    // Settle so the returned Promise isn't left dangling for the runner.
    (register.mock.calls[0][1] as PendingHandler).reject(new Error('test teardown'));
    await expect(promise).rejects.toThrow('test teardown');
  });

  it('rejects without registering a handler when postMessage throws', async () => {
    const register = vi.fn();
    const worker = makeWorker(() => {
      throw new DOMException('Worker has been terminated', 'InvalidStateError');
    });
    await expect(
      dispatchRegisterMaskRaster(worker, 4, register, {
        digest: DIGEST,
        width: 2,
        height: 2,
        data: RASTER,
      }),
    ).rejects.toThrow(/Worker has been terminated/);
    expect(register).not.toHaveBeenCalled();
    expect(performance.getEntriesByName('maple:register-mask-raster', 'measure').length).toBe(1);
  });

  it('resolves with the raster id from the success reply', async () => {
    const pending = new Map<number, PendingHandler>();
    const promise = dispatchRegisterMaskRaster(
      makeWorker(() => {}),
      5,
      (id, handler) => pending.set(id, handler),
      { digest: DIGEST, width: 2, height: 2, data: RASTER },
    );
    handleWorkerMessage(
      { id: 5, type: 'register-mask-raster-success', rasterId: 42 },
      {
        pending,
        threadedSubject: new BehaviorSubject<boolean | null>(null),
        threadCountSubject: new BehaviorSubject<number>(0),
        deepDenoiseProgress: signal<{ pass: 1 | 2; fraction: number } | null>(null),
      },
    );
    await expect(promise).resolves.toBe(42);
    expect(pending.size).toBe(0);
  });

  it('rejects with the error reply message', async () => {
    const pending = new Map<number, PendingHandler>();
    const promise = dispatchRegisterMaskRaster(
      makeWorker(() => {}),
      6,
      (id, handler) => pending.set(id, handler),
      { digest: 'NOT-HEX', width: 2, height: 2, data: RASTER },
    );
    handleWorkerMessage(
      {
        id: 6,
        type: 'register-mask-raster-error',
        message: 'digest must be 16 lowercase hex chars',
      },
      {
        pending,
        threadedSubject: new BehaviorSubject<boolean | null>(null),
        threadCountSubject: new BehaviorSubject<number>(0),
        deepDenoiseProgress: signal<{ pass: 1 | 2; fraction: number } | null>(null),
      },
    );
    await expect(promise).rejects.toThrow('digest must be 16 lowercase hex chars');
  });
});

describe('releaseMaskRasterRequest (#3300)', () => {
  it('posts a fire-and-forget release with the raster id', () => {
    const post = vi.fn();
    releaseMaskRasterRequest(makeWorker(post), 7, 42);
    expect(post).toHaveBeenCalledTimes(1);
    const [request] = post.mock.calls[0] as [ReleaseMaskRasterRequest];
    expect(request).toEqual({ id: 7, type: 'release-mask-raster', rasterId: 42 });
  });
});
