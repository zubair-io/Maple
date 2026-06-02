/**
 * Integration test for the real child-process FFI transport.
 *
 * The pool's dispatch/resize/crash logic is unit-tested against an injected
 * fake in `ffi-pool.test.ts`. This file exercises the actual `Bun.spawn`-backed
 * `ChildProcessWorker`: a live IPC round-trip, graceful degradation when the
 * dylib is absent, and — the reason this whole change exists — that a child
 * dying does NOT take down the parent (it surfaces as an `error` event).
 */

import { describe, it, expect } from 'bun:test';
import { ChildProcessWorker } from './ffi-child-worker.ts';

/** Resolve with the next `message` event's data, or reject on timeout. */
function nextMessage(w: ChildProcessWorker, ms = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for child message')), ms);
    w.addEventListener('message', (e) => {
      clearTimeout(t);
      resolve(e.data);
    });
  });
}

/** Resolve with the next `error` event, or reject on timeout. */
function nextError(w: ChildProcessWorker, ms = 15000): Promise<{ message?: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for child error')), ms);
    w.addEventListener('error', (e) => {
      clearTimeout(t);
      resolve(e);
    });
  });
}

describe('ChildProcessWorker — real Bun child transport', () => {
  it('round-trips a request over IPC and degrades cleanly', async () => {
    const w = new ChildProcessWorker();
    try {
      const got = nextMessage(w);
      w.postMessage({
        type: 'renderThumb',
        id: 7,
        rawPath: '/no/such/file.dng',
        outPath: '/tmp/maple-ffi-test-out.jpg',
        maxPx: 256,
        quality: 82,
      });
      const msg = (await got) as { type: string; id: number; ok: boolean };
      expect(msg.type).toBe('renderThumb');
      expect(msg.id).toBe(7);
      // With no built .so in the test env the child reports `ok: false` (dylib
      // not loaded); if a .so IS present, the missing input file also yields
      // `ok: false`. Either way the failure comes back as an ordinary message
      // — never as a crash of this (parent) process.
      expect(msg.ok).toBe(false);
    } finally {
      w.terminate();
    }
  }, 20000);

  it('surfaces a child crash as an `error` event — the parent survives', async () => {
    const w = new ChildProcessWorker();
    const errP = nextError(w);
    // Give the child a beat to finish spawning so it has a live pid, then kill
    // it OUT FROM UNDER the worker (a proxy for a native SIGSEGV) — crucially
    // NOT via terminate(), so the worker reads onExit as an unexpected death.
    await new Promise((r) => setTimeout(r, 400));
    expect(w.pid).toBeGreaterThan(0);
    process.kill(w.pid, 'SIGKILL');
    const err = await errP;
    expect(err.message ?? '').toContain('ffi child died');
    // Reaching this line at all is the isolation guarantee: a child dying did
    // not take down this parent process.
    expect(true).toBe(true);
  }, 20000);
});
