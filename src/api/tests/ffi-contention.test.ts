import { describe, expect, it } from 'bun:test';
import { _createFfiPoolForTests, type PoolWorker } from '../src/ffi/ffi-pool.ts';
import { ContentionObserver, parseRssSnapshot } from '../scripts/ffi-contention-observer.ts';
import { parseArguments } from '../scripts/ffi-contention.ts';

class ControlledWorker implements PoolWorker {
  readonly posted: Array<{ id: number; type: string }> = [];
  terminated = false;
  private message: ((event: { data: unknown }) => void) | undefined;
  private error: ((event: { message?: string }) => void) | undefined;
  postMessage(message: unknown) {
    this.posted.push(message as { id: number; type: string });
  }
  terminate() {
    this.terminated = true;
  }
  addEventListener(type: 'message' | 'error', callback: (event: never) => void) {
    if (type === 'message') this.message = callback as (event: { data: unknown }) => void;
    else this.error = callback as (event: { message?: string }) => void;
  }
  reply(ok = true) {
    this.message?.({ data: { ...this.posted.at(-1), ok, ...(ok ? {} : { error: 'bad image' }) } });
  }
  crash() {
    this.error?.({ message: 'native child died' });
  }
}

function setup(size: number) {
  const workers: ControlledWorker[] = [];
  const clock = { value: 0 };
  const observer = new ContentionObserver(() => clock.value);
  const pool = _createFfiPoolForTests({
    workerFactory: observer.factory(() => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    }),
  });
  pool.setPoolSize(size);
  const raw = () =>
    observer.measure('raw', '/raw-out.jpg', () =>
      pool.renderDevelopJpegToFile('/a.dng', null, '/raw-out.jpg', 1280),
    );
  const bitmap = () =>
    observer.measure('bitmap', '/bitmap.avif', async () => {
      const result = await pool.renderBitmapThumbToFile('/a.jpg', '/bitmap.avif', 512, 55, 'jpg');
      if (!result.ok) throw new Error(result.error);
    });
  const validate = () =>
    observer.measure('validate', '/existing.avif', async () => {
      const result = await pool.validateAvif('/existing.avif', 512);
      if (!result.ok) throw new Error(result.reason);
    });
  return { workers, clock, observer, pool, raw, bitmap, validate };
}

describe('mixed RAW / bitmap / validation lane routing (#3721 instrumentation, #3527 policy)', () => {
  // #3721 pinned the shared FIFO queue as the pre-decision baseline. The #3527
  // decision replaced it with lanes: RAW requests ride the operator-sized RAW
  // lane, bitmap renders + AVIF validations ride a pinned single-child bitmap
  // lane, so cheap bitmap work never queues behind a RAW demosaic. These tests
  // pin that routing, per-lane FIFO, and per-lane stats.
  it('one RAW worker never blocks bitmap and validation; the bitmap lane runs them in FIFO', async () => {
    const s = setup(1);
    try {
      const raw = s.raw();
      s.clock.value = 10;
      const bitmap = s.bitmap();
      const validation = s.validate();
      expect(s.pool.stats()).toEqual({
        target: 1,
        spawned: 1,
        busy: 1,
        queued: 0,
        bitmap: { target: 1, spawned: 1, busy: 1, queued: 1 },
      });
      expect(s.workers[0].posted.map((x) => x.type)).toEqual(['renderDevelop']);
      expect(s.workers[1].posted.map((x) => x.type)).toEqual(['renderBitmap']);
      // The bitmap lane drains on its own child while RAW is still busy.
      s.clock.value = 100;
      s.workers[1].reply();
      await bitmap;
      expect(s.workers[1].posted.at(-1)?.type).toBe('validateAvif');
      s.clock.value = 120;
      s.workers[1].reply();
      await validation;
      s.clock.value = 130;
      s.workers[0].reply();
      await raw;
      // Bitmap dispatched the moment it was submitted (queue 0); only the
      // validation waited, and only behind the bitmap ahead of it in its lane.
      expect(s.observer.report().map((x) => x.queueMs)).toEqual([0, 0, 90]);
      expect(s.observer.report().map((x) => x.dispatchToReplyMs)).toEqual([130, 90, 20]);
      expect(s.observer.report().map((x) => x.totalMs)).toEqual([130, 90, 110]);
      expect(s.pool.stats().queued).toBe(0);
      expect(s.pool.stats().bitmap.queued).toBe(0);
    } finally {
      s.pool.shutdown();
    }
  });

  it('bitmap and validation finish on their lane while RAW remains busy', async () => {
    const s = setup(2);
    try {
      const raw = s.raw();
      const bitmap = s.bitmap();
      const validation = s.validate();
      expect(s.workers.map((w) => w.posted[0].type)).toEqual(['renderDevelop', 'renderBitmap']);
      expect(s.pool.stats().queued).toBe(0);
      expect(s.pool.stats().bitmap.queued).toBe(1);
      s.workers[1].reply();
      await bitmap;
      expect(s.workers[1].posted.at(-1)?.type).toBe('validateAvif');
      s.workers[1].reply();
      await validation;
      expect(s.pool.stats().busy).toBe(1);
      expect(s.observer.report()[0].status).toBe('pending');
      s.workers[0].reply();
      await raw;
    } finally {
      s.pool.shutdown();
    }
  });

  it('RAW crash rejects only the RAW request; the bitmap lane is untouched', async () => {
    const s = setup(1);
    try {
      const raw = s.raw();
      const bitmap = s.bitmap();
      const validation = s.validate();
      s.workers[0].crash();
      await expect(raw).rejects.toThrow('native child died');
      // The bitmap was already dispatched to the other lane's child — no
      // replacement spawn, no requeue, and the bitmap child survives.
      expect(s.workers.length).toBe(2);
      expect(s.workers[1].posted[0].type).toBe('renderBitmap');
      expect(s.workers[1].terminated).toBe(false);
      s.workers[1].reply();
      await bitmap;
      s.workers[1].reply();
      await validation;
      expect(s.observer.report()[0]).toMatchObject({
        status: 'failed',
        repliedMs: null,
        dispatchToReplyMs: null,
      });
    } finally {
      s.pool.shutdown();
    }
  });

  it('four RAW workers take the RAWs; bitmap ops share the one bitmap child in FIFO', async () => {
    const s = setup(4);
    try {
      const first = [
        s.raw(),
        s.bitmap(),
        s.validate(),
        s.observer.measure('raw-second', '/raw-second.jpg', () =>
          s.pool.renderDevelopJpegToFile('/b.dng', null, '/raw-second.jpg', 1280),
        ),
      ];
      const fifth = s.observer.measure('validation-second', '/second.avif', () =>
        s.pool.validateAvif('/second.avif', 512),
      );
      expect(s.pool.stats()).toEqual({
        target: 4,
        spawned: 2,
        busy: 2,
        queued: 0,
        bitmap: { target: 1, spawned: 1, busy: 1, queued: 2 },
      });
      expect(s.workers.map((w) => w.posted[0].type)).toEqual([
        'renderDevelop',
        'renderBitmap',
        'renderDevelop',
      ]);
      // Bitmap lane drains FIFO on its single child: bitmap, validate,
      // validation-second.
      s.workers[1].reply();
      expect(s.workers[1].posted.at(-1)?.type).toBe('validateAvif');
      s.workers[1].reply();
      expect(s.workers[1].posted.at(-1)?.type).toBe('validateAvif');
      s.workers[1].reply();
      for (const index of [0, 2]) s.workers[index].reply();
      await Promise.all([...first, fifth]);
      expect(s.observer.report().every((row) => row.status === 'ok')).toBe(true);
    } finally {
      s.pool.shutdown();
    }
  });

  it('records render then validation of the same output as separate requests', async () => {
    const s = setup(1);
    try {
      const bitmap = s.bitmap();
      s.workers[0].reply();
      await bitmap;
      const validation = s.observer.measure('validate-rendered', '/bitmap.avif', () =>
        s.pool.validateAvif('/bitmap.avif', 512),
      );
      s.clock.value = 50;
      s.workers[0].reply();
      await validation;
      expect(s.observer.report().map((row) => row.label)).toEqual(['bitmap', 'validate-rendered']);
      expect(s.observer.report().map((row) => row.repliedMs)).toEqual([0, 50]);
    } finally {
      s.pool.shutdown();
    }
  });

  it('shutdown rejects in-flight and queued work without claiming replies', async () => {
    const s = setup(1);
    const all = Promise.allSettled([s.raw(), s.bitmap(), s.validate()]);
    s.pool.shutdown();
    expect((await all).map((x) => x.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(s.observer.report().map((x) => x.status)).toEqual(['failed', 'failed', 'failed']);
    // RAW + bitmap were in flight on their lanes; only the validation (queued
    // in the bitmap lane behind the bitmap) never dispatched.
    expect(s.observer.report()[2]).toMatchObject({
      dispatchedMs: null,
      queueMs: null,
      repliedMs: null,
    });
    expect(s.workers[0].terminated).toBe(true);
    expect(s.workers[1].terminated).toBe(true);
  });

  it('ok:false bitmap replies count as failed measurements', async () => {
    const s = setup(1);
    try {
      const bitmap = s.bitmap();
      s.workers[0].reply(false);
      await expect(bitmap).rejects.toThrow('bad image');
      expect(s.observer.report()[0].status).toBe('failed');
    } finally {
      s.pool.shutdown();
    }
  });
});

describe('local qualification guardrails', () => {
  it('requires opt-in and rejects direct fixture overwrite', () => {
    expect(() => parseArguments([])).toThrow('Usage');
    expect(() => parseArguments(['--run', '/a.dng', '/b.jpg', '/a.dng'])).toThrow('overwrite');
    expect(parseArguments(['--run', '/a.dng', '/b.jpg', '/out.json'])).toEqual({
      raw: '/a.dng',
      jpeg: '/b.jpg',
      output: '/out.json',
    });
  });
  it('RSS selects this parent and direct FFI children, excluding ps and other APIs', () => {
    const sample = parseRssSnapshot(
      [
        '10 1 100 bun scripts/ffi-contention.ts',
        '11 10 200 /bin/bun /repo/src/api/src/ffi/raw_ffi.child.ts',
        '12 99 999 /bin/bun /other/raw_ffi.child.ts',
        '13 10 40 ps -axo pid=,ppid=,rss=,command=',
      ].join('\n'),
      10,
      12,
    );
    expect(sample).toEqual({
      elapsedMs: 12,
      parentRssBytes: 102400,
      children: [{ pid: 11, rssBytes: 204800 }],
      childRssBytes: 204800,
    });
    expect(() => parseRssSnapshot('garbage', 10, 0)).toThrow('invalid ps');
    expect(() => parseRssSnapshot('11 1 20 bun child', 10, 0)).toThrow('absent');
  });
});
