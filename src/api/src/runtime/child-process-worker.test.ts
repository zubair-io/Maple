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
import { ChildProcessWorker, StderrRing, childScriptPath } from './child-process-worker.ts';

const CHILD = childScriptPath(import.meta.url, '../ffi/raw_ffi.child.ts');
const CRASH_CHILD = childScriptPath(import.meta.url, './__fixtures__/stderr-crash-child.ts');
const CRASH_HARNESS = childScriptPath(import.meta.url, './__fixtures__/stderr-crash-harness.ts');

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

describe('StderrRing — bounded tail buffer (#899)', () => {
  it('retains everything pushed while under capacity', () => {
    const ring = new StderrRing(64);
    ring.push(new TextEncoder().encode('hello '));
    ring.push(new TextEncoder().encode('world'));
    expect(ring.toString()).toBe('hello world');
  });

  it('drops whole oldest chunks once over capacity', () => {
    const ring = new StderrRing(10);
    ring.push(new TextEncoder().encode('0123456789')); // exactly at capacity
    ring.push(new TextEncoder().encode('ABCDE')); // pushes the first chunk out entirely
    // Only the most recent 10 bytes survive: the tail of the run, not the head.
    expect(ring.toString()).toBe('56789ABCDE');
  });

  it('trims a partially-evicted chunk down to just the bytes still in budget', () => {
    const ring = new StderrRing(8);
    ring.push(new TextEncoder().encode('12345')); // 5 bytes
    ring.push(new TextEncoder().encode('6789')); // +4 = 9 bytes, 1 over budget
    // The oldest chunk ('12345') gets trimmed by exactly the 1-byte overage,
    // not dropped wholesale — so byte '1' is gone but '2'-'5' survive.
    expect(ring.toString()).toBe('23456789');
  });

  it('decodes UTF-8 and trims surrounding whitespace', () => {
    const ring = new StderrRing(64);
    ring.push(new TextEncoder().encode('\n  panic: café crashed  \n'));
    expect(ring.toString()).toBe('panic: café crashed');
  });

  it('reports empty for a ring nothing has been pushed to', () => {
    expect(new StderrRing(64).toString()).toBe('');
  });
});

describe('ChildProcessWorker — stderr tee + crash-diagnostic exit log (#899)', () => {
  it('tees the crashing child stderr through to the parent process stderr, lossless', async () => {
    const seen: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // `pumpStderr` calls `process.stderr.write` directly (not through pino), so
    // spying on it here — in-process — is reliable, unlike trying to intercept
    // pino-pretty's sonic-boom-backed stdout writes (see the harness test below).
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
      chunk: unknown,
      ...rest: unknown[]
    ) => {
      seen.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    const w = new ChildProcessWorker(CRASH_CHILD, { label: 'crash-tee-test' });
    const errP = nextError(w);
    try {
      const err = await errP;
      expect(err.message ?? '').toContain('child died');
    } finally {
      process.stderr.write = originalWrite;
      w.terminate();
    }

    expect(seen.join('')).toContain('marker-899-stderr-tail');
  }, 20000);

  it('folds the stderr tail into the structured onExit log line', async () => {
    // Run the whole scenario in a dedicated child process with
    // NODE_ENV=production so `log.ts` emits plain JSON on stdout (see the
    // harness fixture's header comment for why pino-pretty can't be
    // intercepted from within this same process). We then parse that JSON
    // back out of the harness's own stdout pipe.
    const proc = Bun.spawn([process.execPath, CRASH_HARNESS], {
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const record = stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find(
        (rec): rec is Record<string, unknown> =>
          rec !== null && typeof rec.msg === 'string' && rec.msg.includes('native child died'),
      );

    expect(record).toBeTruthy();
    expect(typeof record?.stderrTail).toBe('string');
    expect(record?.stderrTail as string).toContain('marker-899-stderr-tail');
    // exit=7 is the fixture's deliberate `process.exit(7)`.
    expect(record?.exitCode).toBe(7);
  }, 20000);
});
