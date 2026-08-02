// ThumbLoadQueue — bounded thumbnail load queue with drop-on-scroll-away.

import { describe, it, expect, vi } from 'vitest';
import { ThumbLoadQueue, MAX_CONCURRENT_THUMB_LOADS } from './library-cache.thumb-queue';

/** A load whose completion the test controls, so queue depth is observable. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ThumbLoadQueue', () => {
  it('runs at most MAX_CONCURRENT_THUMB_LOADS at a time', () => {
    const q = new ThumbLoadQueue();
    const started: string[] = [];
    const gates = new Map<string, () => void>();

    for (let i = 0; i < 10; i++) {
      const id = `a${i}`;
      void q.enqueue(id, () => {
        started.push(id);
        const d = deferred();
        gates.set(id, d.resolve);
        return d.promise;
      });
    }

    expect(started).toHaveLength(MAX_CONCURRENT_THUMB_LOADS);
    expect(q.depth).toBe(10 - MAX_CONCURRENT_THUMB_LOADS);
  });

  it('starts the next queued load when one finishes', async () => {
    const q = new ThumbLoadQueue();
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const run = (id: string) => () => {
      started.push(id);
      const d = deferred();
      gates.set(id, d.resolve);
      return d.promise;
    };

    for (let i = 0; i < 6; i++) void q.enqueue(`a${i}`, run(`a${i}`));
    expect(started).toEqual(['a0', 'a1', 'a2', 'a3']);

    gates.get('a0')!();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toContain('a4');
  });

  // The scroll-away fix: a tile that leaves the viewport before its request
  // ever started must not spend one of the four connections later. Without
  // this, scrolling a large folder leaves the current viewport's thumbnails
  // queued behind hundreds of requests for rows the reader has passed.
  it('cancel drops a not-yet-started load so it never runs', async () => {
    const q = new ThumbLoadQueue();
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const run = (id: string) => () => {
      started.push(id);
      const d = deferred();
      gates.set(id, d.resolve);
      return d.promise;
    };

    for (let i = 0; i < 8; i++) void q.enqueue(`a${i}`, run(`a${i}`));
    expect(started).toEqual(['a0', 'a1', 'a2', 'a3']);

    // a4..a7 are queued; the reader scrolls past all of them.
    expect(q.cancel('a4')).toBe(true);
    expect(q.cancel('a5')).toBe(true);
    expect(q.cancel('a6')).toBe(true);
    expect(q.cancel('a7')).toBe(true);
    expect(q.depth).toBe(0);

    // Drain the in-flight four; nothing new should start.
    for (const id of ['a0', 'a1', 'a2', 'a3']) gates.get(id)!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(['a0', 'a1', 'a2', 'a3']);
  });

  it('cancel resolves the waiter rather than rejecting it', async () => {
    // A cancelled tile was never attempted, so it must not be branded a
    // failure — `ThumbFailMemory` would otherwise refuse to retry it when the
    // reader scrolls back.
    const q = new ThumbLoadQueue();
    for (let i = 0; i < 4; i++) void q.enqueue(`busy${i}`, () => deferred().promise);

    const waiter = q.enqueue('later', () => Promise.resolve());
    const onReject = vi.fn();
    q.cancel('later');

    await waiter.catch(onReject);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('cancel leaves an already-started load alone', () => {
    const q = new ThumbLoadQueue();
    void q.enqueue('a0', () => deferred().promise);
    expect(q.active).toBe(1);
    expect(q.cancel('a0')).toBe(false);
    expect(q.active).toBe(1);
  });

  it('clear rejects queued waiters with the Queue cleared sentinel', async () => {
    // `ThumbFailMemory.record` special-cases this message so a source switch
    // does not brand every queued asset as permanently failed.
    const q = new ThumbLoadQueue();
    for (let i = 0; i < 4; i++) void q.enqueue(`busy${i}`, () => deferred().promise);
    const waiter = q.enqueue('queued', () => Promise.resolve());

    q.clear();

    await expect(waiter).rejects.toThrow('Queue cleared');
    expect(q.depth).toBe(0);
  });
});
