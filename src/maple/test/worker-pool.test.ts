import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildNoNativeBindingError,
  callNative,
  getMapleConcurrency,
  getMapleExecutionMode,
  setMapleConcurrency,
  setMapleExecutionMode,
  shutdownMaplePool,
  _getBusyMapleWorkerForTests,
  _resetMaplePoolForTests,
  _setIsBunRuntimeForTests,
} from '../src/worker-pool';
import { _resetNapiBindingForTests } from '../src/native-napi';

/**
 * Forces `callNative` onto the `bun:ffi`/worker-pool path for the rest of
 * this test, even on a machine with a napi addon built and resolvable — via
 * `MAPLE_NAPI=0` (`native-napi.ts`'s escape hatch, added alongside this
 * fix). Needed by every test below whose actual point is to exercise the
 * POOL's own machinery (concurrency, idle-worker reuse, `handleWorkerDeath`
 * recovery) using `validateFilename` as the vehicle: since #3509,
 * `validateFilename` has a real napi implementation, so on a machine with
 * the addon built it would otherwise never reach the pool at all, and these
 * tests would keep passing while silently testing nothing about the pool —
 * exactly the kind of vacuous-pass bug a "does this still hold under CI's
 * napi-enabled dev loop" review caught.
 */
function forceBunFfiPoolForTest(): void {
  process.env.MAPLE_NAPI = '0';
  _resetNapiBindingForTests();
}

afterEach(() => {
  shutdownMaplePool();
  _resetMaplePoolForTests();
  setMapleExecutionMode('worker');
  setMapleConcurrency(4);
  delete process.env.MAPLE_NAPI;
  _resetNapiBindingForTests();
  _setIsBunRuntimeForTests(undefined);
});

describe('worker pool execution mode', () => {
  it('defaults to worker mode', () => {
    expect(getMapleExecutionMode()).toBe('worker');
  });

  it('dispatches a pure-computation native method through a real worker thread and gets the right answer', async () => {
    forceBunFfiPoolForTest();
    const result = await callNative('validateFilename', ['ok-name.jpg']);
    expect(result).toEqual({ ok: true });
  });

  it('propagates a native-side validation failure as the resolved (non-throwing) result shape', async () => {
    const result = await callNative('validateFilename', ['bad/name.jpg']);
    expect(result.ok).toBe(false);
  });

  it('runs multiple calls concurrently without serializing them onto one worker', async () => {
    forceBunFfiPoolForTest();
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
    //
    // Forces the bun:ffi/pool path for the whole test: the FOLLOWUP
    // `validateFilename` call is the actual "still usable afterwards"
    // assertion, and since #3509 that method has a real napi
    // implementation — without forcing, it would silently answer from napi
    // instead of the pool, proving nothing about pool recovery specifically.
    forceBunFfiPoolForTest();
    await expect(callNative('thisMethodDoesNotExist' as never, [] as never)).rejects.toThrow(
      /unknown native method/,
    );
    const after = await callNative('validateFilename', ['still-works.jpg']);
    expect(after).toEqual({ ok: true });
  });

  it('rejects the in-flight call and recovers when a worker is genuinely killed mid-call (real handleWorkerDeath, not a caught in-worker error)', async () => {
    // The previous test only reaches the pool's OWN "reject a caught error"
    // path (the worker replies normally with `{ ok: false }`). This test
    // triggers `handleWorkerDeath` for real: dispatch a call, then reach
    // into the pool and `.terminate()` the actual live worker thread that
    // is serving it before it can reply — exactly the shape of a genuine
    // worker crash — and confirm both that the in-flight promise rejects
    // (rather than hanging forever) and that the pool recovers afterwards.
    //
    // Uses the same bogus method name the other pool-recovery tests above
    // use, rather than `validateFilename`: since #3509, `callNative` tries
    // the napi addon first when one is resolvable for this platform, and
    // `validateFilename` — unlike this bogus name — has a real napi
    // implementation, so it would never reach the worker pool at all on a
    // machine with the addon built, leaving no live worker here to kill.
    // The bogus method name is guaranteed to fall through to the pool on
    // every machine regardless of napi availability, which is what this
    // test needs: a real live `Worker` to reach in and terminate. Which
    // method name drives the pool is incidental to what's under test here
    // (`handleWorkerDeath`), so this substitution changes nothing about the
    // pool behavior being verified.
    //
    // Also forces the bun:ffi/pool path for the whole test, same reason as
    // the previous test: the trailing `validateFilename` "recovered"
    // assertion must actually go through the pool to prove the pool
    // recovered, not just that napi (an entirely separate, unaffected
    // backend) still answers.
    forceBunFfiPoolForTest();
    const inFlight = callNative('thisMethodDoesNotExist' as never, [] as never);
    const worker = _getBusyMapleWorkerForTests();
    expect(worker).not.toBeNull();
    worker!.terminate();

    await expect(inFlight).rejects.toThrow();

    const after = await callNative('validateFilename', ['after-real-death.jpg']);
    expect(after).toEqual({ ok: true });
  });

  it('a second, rejecting call checked with expect().rejects settles even when it reuses an idle worker from a prior successful call (#3508 regression)', async () => {
    // Reproduces a real Bun engine quirk (seen on 1.4.3-canary.1): when a
    // promise settled from a Worker `'message'` listener is awaited through
    // ANY `expect(...)` async matcher — `.resolves` on success included, not
    // just `.rejects` here — and it is NOT the first worker round trip the
    // test makes, `bun:test`'s async matcher wedged the pool's `Worker`
    // message port — the worker still replied, but the main thread's
    // `message` listener never fired for that reply. That's a genuine
    // process wedge (needs `kill -9`, not a clean timeout-then-exit) absent
    // the fix below. This test exercises the `.rejects` case specifically;
    // `handleResponse`'s macrotask-deferred settle (see its doc comment in
    // `worker-pool.ts`) is the fix that covers both, and this test is the
    // gate for this shape.
    //
    // Forces the bun:ffi/pool path for the whole test: the quirk this test
    // guards against needs the FIRST call to genuinely settle a promise from
    // a real `Worker` `'message'` listener — since #3509, `validateFilename`
    // has a real napi implementation, so without forcing, `first` would be
    // answered by napi instead (no worker involved at all), and this
    // regression gate would keep passing while proving nothing about the
    // actual wedge it exists to catch.
    forceBunFfiPoolForTest();
    const first = await callNative('validateFilename', ['first-call.jpg']);
    expect(first).toEqual({ ok: true });
    await expect(callNative('thisMethodDoesNotExist' as never, [] as never)).rejects.toThrow(
      /unknown native method/,
    );
  });

  it('on plain Node with no working napi function, throws an informative error instead of crashing into the Bun-only worker pool', async () => {
    // Regression test for the Critical bug from code review: forcing napi
    // off (MAPLE_NAPI=0) and simulating "no Bun" via `_setIsBunRuntimeForTests`
    // (real Bun's own `globalThis.Bun` is non-configurable and
    // non-writable — confirmed empirically that neither `delete` nor
    // `Object.defineProperty` can override it under `bun test` — hence the
    // injectable check `worker-pool.ts` exposes specifically for this)
    // reproduces exactly the real-world failure this fix targets: a plain
    // Node process with no working native binding at all. Before the fix,
    // `callNative` fell through into `getPool().dispatch(...)`, which calls
    // `new Worker(...)` against the bare `Worker` global that simply does
    // not exist outside Bun/a browser, crashing with a bare `ReferenceError:
    // Worker is not defined`. After the fix, it throws a specific error
    // instead, naming both that no backend is available and WHY napi in
    // particular failed (the preserved `MAPLE_NAPI=0` reason, via
    // `getNapiLoadError()`).
    forceBunFfiPoolForTest();
    _setIsBunRuntimeForTests(() => false);
    await expect(callNative('validateFilename', ['node-no-backend.jpg'])).rejects.toThrow(
      /no working native binding.*MAPLE_NAPI=0.*requires Bun/s,
    );
  });

  it('buildNoNativeBindingError names the real napi failure reason when one is known', () => {
    const withReason = buildNoNativeBindingError(new Error('napi disabled via MAPLE_NAPI=0'));
    expect(withReason.message).toMatch(/napi disabled via MAPLE_NAPI=0/);
    expect(withReason.message).toMatch(/requires Bun/);

    const withoutReason = buildNoNativeBindingError(null);
    expect(withoutReason.message).toMatch(/no working native binding/);
    expect(withoutReason.message).not.toMatch(/\(\)/); // no empty parens when there's no reason
  });
});
