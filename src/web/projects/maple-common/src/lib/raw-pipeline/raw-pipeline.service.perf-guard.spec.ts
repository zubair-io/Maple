// raw-pipeline.service.perf-guard.spec.ts
//
// RawPipelineService — performance-mark deadlock guard (#1123). Split out of
// raw-pipeline.service.spec.ts (file-budget split) — this block is the PR's own new
// regression coverage, so it gets its own sibling file rather than pushing the
// original spec file over the repo's 600-line hard budget.
//
// #1123: `performance.measure` THROWS if either named mark was cleared out from
// under it (DevTools' `performance.clearMarks()`, a monitoring shim, or a test
// harness can do this anytime — the Performance Timeline is a single shared,
// mutable buffer). Before the fix, the mark/measure pair ran INSIDE the pending
// handler's `resolve` wrapper, un-guarded — a throw there meant the real
// `resolve(result)` call one line below never ran. Because every decode is
// serialized behind `decodeChain`, that one stranded decode permanently wedged
// every later decode too. These specs simulate the throw and assert the promise
// still settles and the chain still drains.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { RawPipelineService } from './raw-pipeline.service';
import { WorkerStub, installWorkerStub } from './raw-pipeline.service.test-helpers';
import type { DecodeRequest, DecodeSuccess } from './raw-pipeline.types';

describe('RawPipelineService — performance-mark deadlock guard (#1123)', () => {
  let workerStub: WorkerStub;
  let restoreWorker: () => void;
  let originalMeasure: typeof performance.measure;

  beforeEach(() => {
    workerStub = new WorkerStub();
    restoreWorker = installWorkerStub(workerStub).restore;
    TestBed.configureTestingModule({});
    // Store the RAW function reference, not a `.bind(performance)` copy — a bound
    // wrapper is a DIFFERENT function object, so restoring it in `afterEach` would
    // leave `performance.measure` pointing at our wrapper forever instead of the
    // true original (jules review / Copilot review, #1123). Calling it as
    // `performance.measure(...)` already binds `this` to `performance` correctly,
    // so the raw reference works identically without that risk.
    originalMeasure = performance.measure;
  });

  afterEach(() => {
    restoreWorker();
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
