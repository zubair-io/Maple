import { describe, expect, it } from 'bun:test';
import { createBatcher } from './batcher.ts';

describe('createBatcher', () => {
  it('sends a full batch immediately and the remainder after the linger', async () => {
    const batches: number[][] = [];
    const batcher = createBatcher(
      async (items: readonly number[]) => {
        batches.push([...items]);
        return items.map((item) => item * 2);
      },
      { maxBatch: 3, lingerMs: 5 },
    );
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => batcher.submit(n)));
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(batches).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
  });

  it('coalesces callers that arrive within the linger window', async () => {
    const batches: number[][] = [];
    const batcher = createBatcher(
      async (items: readonly number[]) => {
        batches.push([...items]);
        return items;
      },
      { maxBatch: 512, lingerMs: 20 },
    );
    const first = batcher.submit(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = batcher.submit(2);
    await Promise.all([first, second]);
    expect(batches).toEqual([[1, 2]]);
  });

  it('rejects every caller in a batch whose run fails, without poisoning the next', async () => {
    const outcomes: Array<'fail' | 'ok'> = ['fail', 'ok'];
    const batcher = createBatcher(
      async (items: readonly number[]) => {
        if (outcomes.shift() === 'fail') throw new Error('boom');
        return items;
      },
      { maxBatch: 2, lingerMs: 1 },
    );
    const failed = await Promise.allSettled([batcher.submit(1), batcher.submit(2)]);
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(await batcher.submit(3)).toBe(3);
  });
});
