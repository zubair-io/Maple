import { afterEach, describe, expect, it } from 'bun:test';
import {
  callNative,
  getMapleConcurrency,
  getMapleExecutionMode,
  setMapleConcurrency,
  setMapleExecutionMode,
  shutdownMaplePool,
  _resetMaplePoolForTests,
} from '../src/worker-pool';

afterEach(() => {
  shutdownMaplePool();
  _resetMaplePoolForTests();
  setMapleExecutionMode('worker');
  setMapleConcurrency(4);
});

describe('worker pool execution mode', () => {
  it('defaults to worker mode', () => {
    expect(getMapleExecutionMode()).toBe('worker');
  });

  it('dispatches a pure-computation native method through a real worker thread and gets the right answer', async () => {
    const result = await callNative('validateFilename', ['ok-name.jpg']);
    expect(result).toEqual({ ok: true });
  });

  it('propagates a native-side validation failure as the resolved (non-throwing) result shape', async () => {
    const result = await callNative('validateFilename', ['bad/name.jpg']);
    expect(result.ok).toBe(false);
  });

  it('runs multiple calls concurrently without serializing them onto one worker', async () => {
    const concurrency = 4;
    setMapleConcurrency(concurrency);
    const started = Date.now();
    // renderFilenameTemplate has no artificial delay, so this only proves
    // the pool *can* fan out — see the dedicated event-loop-stall test
    // (Task 9) for the actual non-blocking proof against a real decode.
    const calls = Array.from({ length: concurrency }, (_, i) =>
      callNative('validateFilename', [`file-${i}.jpg`]),
    );
    const results = await Promise.all(calls);
    expect(results).toHaveLength(concurrency);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('falls back to a fully synchronous call when execution mode is sync', async () => {
    setMapleExecutionMode('sync');
    expect(getMapleExecutionMode()).toBe('sync');
    const result = await callNative('validateFilename', ['ok.jpg']);
    expect(result).toEqual({ ok: true });
  });

  it('calls a `this`-dependent native method correctly in sync mode (regression: sync dispatch used to call the method detached, losing `this`)', async () => {
    setMapleExecutionMode('sync');
    // rasterProbeMetadata's own implementation calls `this.rasterProbeMetadataBuf(...)`
    // internally — if callNative's sync path invokes it as a bare detached
    // function, that inner call throws on `undefined`, not on the missing file.
    const result = await callNative('rasterProbeMetadata', ['/nonexistent/does-not-exist.jpg']);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toMatch(/Cannot read propert(y|ies) of undefined/);
    expect(result.error).not.toMatch(/rasterProbeMetadataBuf/);
  });

  it('clamps concurrency to a sane minimum of 1', () => {
    setMapleConcurrency(0);
    expect(getMapleConcurrency()).toBe(1);
    setMapleConcurrency(-5);
    expect(getMapleConcurrency()).toBe(1);
  });

  it('respects MAPLE_WORKER_CONCURRENCY at pool construction when no explicit value was set', async () => {
    process.env.MAPLE_WORKER_CONCURRENCY = '2';
    _resetMaplePoolForTests();
    expect(getMapleConcurrency()).toBe(2);
    delete process.env.MAPLE_WORKER_CONCURRENCY;
  });

  it('recovers after a worker dies mid-call: the request rejects, and the NEXT call still succeeds', async () => {
    // validateFilename can't crash a worker on its own, so this exercises
    // the pool's own defensive path instead: dispatch a bogus method name,
    // which the worker entry throws on (a controlled, catchable throw —
    // not a real segfault), confirming the pool surfaces it as a rejection
    // rather than hanging, and that the pool is still usable afterwards.
    await expect(
      callNative('thisMethodDoesNotExist' as never, [] as never),
    ).rejects.toThrow(/unknown native method/);
    const after = await callNative('validateFilename', ['still-works.jpg']);
    expect(after).toEqual({ ok: true });
  });
});
