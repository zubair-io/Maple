// raw-pipeline.dispatch-postmessage.spec.ts
//
// #2319: `dispatchAutoAdjust` / `dispatchExport` used to register their pending
// handler BEFORE calling `worker.postMessage`. `postMessage` throws
// synchronously on a terminated worker (`InvalidStateError`) and on an
// untransferable payload (`DataCloneError`), which left an entry in the
// service's pending map that no worker reply could ever settle, plus a
// `markStart` with no matching `markEnd`.
//
// (The returned Promise was never actually left pending — a synchronous throw
// from a `new Promise` executor rejects it — so the leak was the registry and
// the performance mark, not a hung caller. These specs pin both.)
//
// PURE spec — no Angular TestBed, no raw-wasm import — so it runs under plain
// `bunx vitest run` as well as `ng test`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { dispatchAutoAdjust } from './raw-pipeline.auto-adjust-request';
import { dispatchExport } from './raw-pipeline.export-request';
import type { PendingHandler } from './raw-pipeline.service-internals';
import type { RawExportOptions } from './raw-pipeline.types';

/** Minimal `Worker` stand-in — these dispatchers only ever call `postMessage`. */
function makeWorker(postMessage: (...args: unknown[]) => void): Worker {
  return { postMessage } as unknown as Worker;
}

const throwingPost = () => {
  throw new DOMException('Worker has been terminated', 'InvalidStateError');
};

const BYTES = new Uint8Array([1, 2, 3, 4]);
const EXPORT_OPTIONS = { format: 'jpeg', quality: 90 } as unknown as RawExportOptions;

describe.each([
  {
    name: 'dispatchAutoAdjust',
    measure: 'maple:auto-adjust',
    run: (worker: Worker, id: number, register: (i: number, h: PendingHandler) => void) =>
      dispatchAutoAdjust(worker, id, register, BYTES, 'dng', undefined),
  },
  {
    name: 'dispatchExport',
    measure: 'maple:export',
    run: (worker: Worker, id: number, register: (i: number, h: PendingHandler) => void) =>
      dispatchExport(worker, id, register, BYTES, 'dng', EXPORT_OPTIONS, undefined),
  },
])('$name postMessage failure (#2319)', ({ measure, run }) => {
  beforeEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  it('does not register a pending handler when postMessage throws', async () => {
    const register = vi.fn();
    await expect(run(makeWorker(throwingPost), 7, register)).rejects.toThrow(
      /Worker has been terminated/,
    );
    expect(register).not.toHaveBeenCalled();
  });

  it('closes the performance span when postMessage throws', async () => {
    const register = vi.fn();
    await expect(run(makeWorker(throwingPost), 8, register)).rejects.toThrow();
    // A stranded `markStart` with no `markEnd` would leave the measure absent.
    expect(performance.getEntriesByName(measure, 'measure').length).toBe(1);
  });

  it('registers the pending handler on the happy path', async () => {
    const register = vi.fn();
    const worker = makeWorker(() => {});
    const promise = run(worker, 9, register);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0]).toBe(9);

    // Settle so the returned Promise isn't left dangling for the runner.
    const handler = register.mock.calls[0][1] as PendingHandler;
    handler.reject(new Error('test teardown'));
    await expect(promise).rejects.toThrow('test teardown');
  });

  it('registers before any worker reply can be dispatched', async () => {
    // Ordering safety for posting first: the reply is delivered as a queued
    // message event, so it cannot run until this synchronous executor returns.
    // Assert the observable half of that — `register` has already happened by
    // the time `dispatch*` returns, i.e. before control yields to the loop.
    const register = vi.fn();
    const seenAtPost: boolean[] = [];
    const worker = makeWorker(() => seenAtPost.push(register.mock.calls.length > 0));
    const promise = run(worker, 10, register);
    expect(seenAtPost).toEqual([false]); // post happened first …
    expect(register).toHaveBeenCalledTimes(1); // … and register still landed synchronously

    const handler = register.mock.calls[0][1] as PendingHandler;
    handler.reject(new Error('test teardown'));
    await expect(promise).rejects.toThrow('test teardown');
  });
});
