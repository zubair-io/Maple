/**
 * Integration test for the generic child-process transport (the shared spine
 * of the FFI decode pool and the onnx face pool).
 *
 * The pools' dispatch/fallback logic is unit-tested against fakes elsewhere.
 * This exercises the actual `Bun.spawn` + IPC path: a live round-trip, graceful
 * degradation, and — the reason this whole layer exists — that a child dying
 * surfaces as an `error` event WITHOUT taking down the parent.
 *
 * Uses the real FFI decode child (`ffi/raw_ffi.child.ts`) as a concrete native
 * child: with no built `.so` in the test env it replies `ok: false`, which is
 * all we need to drive the transport.
 */

import { describe, it, expect } from 'bun:test';
import { ChildProcessWorker, childScriptPath } from './child-process-worker.ts';

const CHILD = childScriptPath(import.meta.url, '../ffi/raw_ffi.child.ts');

function nextMessage(w: ChildProcessWorker, ms = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for child message')), ms);
    w.addEventListener('message', (e) => {
      clearTimeout(t);
      resolve(e.data);
    });
  });
}

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
    const w = new ChildProcessWorker(CHILD, { label: 'test', nice: 10 });
    try {
      const got = nextMessage(w);
      w.postMessage({
        type: 'renderThumb',
        id: 7,
        rawPath: '/no/such/file.dng',
        outPath: '/tmp/maple-cpw-test-out.jpg',
        maxPx: 256,
        quality: 82,
      });
      const msg = (await got) as { type: string; id: number; ok: boolean };
      expect(msg.type).toBe('renderThumb');
      expect(msg.id).toBe(7);
      // No built .so in the test env ⇒ the child reports ok:false (dylib not
      // loaded); a missing input file also yields ok:false. Either way the
      // failure comes back as an ordinary message, never a parent crash.
      expect(msg.ok).toBe(false);
    } finally {
      w.terminate();
    }
  }, 20000);

  it('surfaces a child crash as an `error` event — the parent survives', async () => {
    const w = new ChildProcessWorker(CHILD, { label: 'test' });
    const errP = nextError(w);
    // Kill the child OUT FROM UNDER the worker (a proxy for a native SIGSEGV) —
    // NOT via terminate(), so the worker reads onExit as an unexpected death.
    await new Promise((r) => setTimeout(r, 400));
    expect(w.pid).toBeGreaterThan(0);
    process.kill(w.pid, 'SIGKILL');
    const err = await errP;
    expect(err.message ?? '').toContain('child died');
    // Reaching this line at all is the isolation guarantee: a child dying did
    // not take down this parent process.
    expect(true).toBe(true);
  }, 20000);
});
