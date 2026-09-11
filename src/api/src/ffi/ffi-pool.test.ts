/**
 * FFI pool dispatch / resize / crash tests (ticket #673).
 *
 * Drives an injected fake worker so the pool's dispatch-across-N, queue-when-
 * busy, grow/shrink resize, drain-before-terminate, and crash-isolation logic
 * can be exercised without the native dylib or real worker threads.
 */

import { describe, it, expect } from 'bun:test';
import {
  _createFfiPoolForTests,
  _resetFfiPoolForTests,
  _setFfiPoolForTests,
  ffiPool,
  type PoolWorker,
  type WorkerFactory,
} from './ffi-pool.ts';

/** A posted request as the fake worker records it. `type` is a plain string
 * rather than `'renderThumb'`: the pool posts several request types and the
 * bitmap-ops test below asserts on the one it got. */
interface PostedMsg {
  type: string;
  id: number;
}

/** A controllable fake worker. Records posted message ids and exposes
 * `respond(ok)` / `crash()` to simulate the worker thread. */
class FakeWorker implements PoolWorker {
  static all: FakeWorker[] = [];
  terminated = false;
  posted: PostedMsg[] = [];
  private msgCb: ((e: { data: unknown }) => void) | null = null;
  private errCb: ((e: { message?: string }) => void) | null = null;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(msg: unknown): void {
    this.posted.push(msg as PostedMsg);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: 'message' | 'error', cb: (e: never) => void): void {
    if (type === 'message') this.msgCb = cb as (e: { data: unknown }) => void;
    else this.errCb = cb as (e: { message?: string }) => void;
  }

  /** Resolve the most-recently-posted call on this worker. */
  respond(ok: boolean): void {
    const last = this.posted[this.posted.length - 1];
    this.msgCb?.({ data: { type: 'renderThumb', id: last.id, ok } });
  }

  crash(message = 'boom'): void {
    this.errCb?.({ message });
  }

  /** Reply to the most-recently-posted call with an arbitrary message body
   * (the `id` is filled in) — simulates a child answering with the WRONG
   * response type. */
  respondWith(body: Record<string, unknown>): void {
    const last = this.posted[this.posted.length - 1];
    this.msgCb?.({ data: { ...body, id: last.id } });
  }
}

function freshFactory(): { factory: WorkerFactory; workers: FakeWorker[] } {
  FakeWorker.all = [];
  return { factory: () => new FakeWorker(), workers: FakeWorker.all };
}

function render(pool: ReturnType<typeof _createFfiPoolForTests>) {
  // outPath/maxPx/quality are inert in the fake — only the dispatch matters.
  return pool.renderThumbnailAvifToFile('/raw.dng', '/out.avif', 256);
}

describe('FfiWorkerPool — dispatch', () => {
  it('spawns lazily: no workers until the first request', () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    pool.setPoolSize(4);
    expect(workers.length).toBe(0);
    expect(pool.stats().spawned).toBe(0);
  });

  it('dispatches concurrent requests across N workers up to the target', () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    pool.setPoolSize(3);

    void render(pool);
    void render(pool);
    void render(pool);

    // Three concurrent requests → three workers, each one busy.
    expect(workers.length).toBe(3);
    expect(pool.stats().busy).toBe(3);
    expect(pool.stats().queued).toBe(0);
  });

  it('queues additional requests when all workers are busy', () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    pool.setPoolSize(2);

    void render(pool);
    void render(pool);
    const third = render(pool);

    expect(workers.length).toBe(2); // capped at target
    expect(pool.stats().queued).toBe(1);

    // Free worker 0's first call → the queued request runs on it (reused,
    // not a new spawn).
    workers[0].respond(true);
    expect(pool.stats().queued).toBe(0);
    expect(workers.length).toBe(2);
    expect(workers[0].posted.length).toBe(2);
    // Complete the re-dispatched (third) call so its promise settles.
    workers[0].respond(true);
    return expect(third).resolves.toBe(true);
  });

  it('resolves renderThumb results back to the caller', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    const p = render(pool);
    workers[0].respond(true);
    await expect(p).resolves.toBe(true);
  });
});

describe('FfiWorkerPool — resize', () => {
  it('grow lets queued work spawn the extra workers', () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    pool.setPoolSize(1);

    void render(pool);
    void render(pool); // queued — only 1 worker allowed

    expect(workers.length).toBe(1);
    expect(pool.stats().queued).toBe(1);

    pool.setPoolSize(2); // grow → the queued request spawns worker #2
    expect(workers.length).toBe(2);
    expect(pool.stats().queued).toBe(0);
    expect(pool.stats().busy).toBe(2);
  });

  it('shrink terminates idle surplus workers immediately', () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    pool.setPoolSize(3);

    void render(pool);
    void render(pool);
    void render(pool);
    // Free all three → 3 idle workers.
    workers[0].respond(true);
    workers[1].respond(true);
    workers[2].respond(true);
    expect(pool.stats().busy).toBe(0);
    expect(pool.stats().spawned).toBe(3);

    pool.setPoolSize(1);
    // Two idle surplus workers terminate now; one survives.
    expect(pool.stats().spawned).toBe(1);
    expect(workers.filter((w) => w.terminated).length).toBe(2);
  });

  it('shrink drains an in-flight call before terminating (never mid-decode)', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    pool.setPoolSize(2);

    void render(pool);
    const second = render(pool); // worker #2, busy

    expect(pool.stats().busy).toBe(2);

    pool.setPoolSize(1); // mark worker #2 surplus, but it's busy
    // Surplus busy worker is NOT terminated yet — its decode is in flight.
    expect(workers[1].terminated).toBe(false);
    expect(pool.stats().spawned).toBe(2);

    // Its call drains → only now does it terminate.
    workers[1].respond(true);
    await expect(second).resolves.toBe(true);
    expect(workers[1].terminated).toBe(true);
    expect(pool.stats().spawned).toBe(1);
  });

  it('clamps the target to [1, 16]', () => {
    const { factory } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    pool.setPoolSize(99);
    expect(pool.poolSize()).toBe(16);
    pool.setPoolSize(0);
    expect(pool.poolSize()).toBe(1);
    pool.setPoolSize(-5);
    expect(pool.poolSize()).toBe(1);
  });
});

describe('FfiWorkerPool — crash isolation', () => {
  it('a worker crash rejects only its in-flight call; siblings are untouched', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    pool.setPoolSize(2);

    const a = render(pool); // worker #1
    const b = render(pool); // worker #2

    expect(workers.length).toBe(2);

    // Worker #1 crashes mid-decode.
    workers[0].crash('segfault');
    await expect(a).rejects.toThrow(/worker errored/);

    // The crashed worker is dropped AND terminated so its thread / dlopen'd
    // dylib is released (no leak).
    expect(workers[0].terminated).toBe(true);
    // The crashed worker is dropped; the sibling keeps running and resolves —
    // and the surviving sibling is NOT terminated.
    expect(workers[1].terminated).toBe(false);
    expect(pool.stats().spawned).toBe(1);
    workers[1].respond(true);
    await expect(b).resolves.toBe(true);
  });

  it('respawns a fresh worker on the next request after a crash', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    pool.setPoolSize(1);

    const a = render(pool);
    workers[0].crash();
    await expect(a).rejects.toThrow(/worker errored/);
    expect(workers[0].terminated).toBe(true); // crashed worker cleaned up
    expect(pool.stats().spawned).toBe(0);

    // Next request spawns a brand-new worker (index 1 in the factory list).
    const b = render(pool);
    expect(workers.length).toBe(2);
    expect(pool.stats().spawned).toBe(1);
    workers[1].respond(true);
    await expect(b).resolves.toBe(true);
  });
});

describe('FfiWorkerPool — protocol mismatch', () => {
  // Regression: a child that answered a renderThumb with a histogram-typed
  // reply (the old unguarded fallthrough in raw_ffi.child.ts) released the
  // worker slot but never settled the caller's promise — it hung forever.
  it('rejects the caller when the reply type does not match the request', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });
    const p = render(pool);

    workers[0].respondWith({ type: 'histogram', ok: false, error: 'render-failed' });

    const hung = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('caller promise hung')), 100),
    );
    await expect(Promise.race([p, hung])).rejects.toThrow(/mismatched response type/);
    // The slot is still released so the next request is not starved.
    expect(pool.stats().busy).toBe(0);
  });
});

describe('FfiWorkerPool — bitmap ops', () => {
  // #3499: the bitmap thumbnail + AVIF-validation ops the retired sharp-backed
  // imgdecode pool used to own now ride this pool. `respondWith` stands in for
  // the child's reply so each op's own response shape (`{ ok, error }` for the
  // render, `{ ok, reason }` for the validation) is pinned at the wire level.
  it('dispatches renderBitmap and validateAvif and resolves their result shapes', async () => {
    const { factory, workers } = freshFactory();
    const pool = _createFfiPoolForTests({ workerFactory: factory });

    const renderResult = pool.renderBitmapThumbToFile('/a.jpg', '/a.avif', 512, 55, 'jpg');
    expect(workers[0].posted[0]?.type).toBe('renderBitmap');
    workers[0].respondWith({ type: 'renderBitmap', ok: true });
    await expect(renderResult).resolves.toEqual({ ok: true });

    const validateResult = pool.validateAvif('/a.avif', 512);
    expect(workers[0].posted[1]?.type).toBe('validateAvif');
    workers[0].respondWith({
      type: 'validateAvif',
      ok: false,
      reason: 'dimensions 900x10 exceed expected long edge 512',
    });
    await expect(validateResult).resolves.toEqual({
      ok: false,
      reason: 'dimensions 900x10 exceed expected long edge 512',
    });
  });
});

describe('ffiPool() — self-heal after shutdown (#3524)', () => {
  it('builds a fresh, live pool instead of handing out a shut-down one', () => {
    const previous = _setFfiPoolForTests(null);
    try {
      const first = ffiPool();
      first.shutdown();
      expect(first.isShutDown).toBe(true);

      const second = ffiPool();
      expect(second).not.toBe(first);
      expect(second.isShutDown).toBe(false);
    } finally {
      _resetFfiPoolForTests();
      if (previous) _setFfiPoolForTests(previous);
    }
  });
});
