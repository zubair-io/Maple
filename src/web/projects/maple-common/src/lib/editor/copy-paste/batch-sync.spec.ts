// Batch adjustment transfer lifecycle (#2436): progress, cancellation,
// per-asset failure recording, retry-only-failed, and the 2,000-asset run.

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BATCH_CHUNK,
  type BatchProgress,
  batchSummaryText,
  retryableIds,
  runBatchTransfer,
} from './batch-sync';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);
/** Yield stub — resolves immediately so the tests need no real timers. */
const immediate = () => Promise.resolve();

describe('runBatchTransfer (#2436)', () => {
  it('writes every asset in order and reports a clean summary', async () => {
    const written: string[] = [];
    const summary = await runBatchTransfer(ids(5), (id) => void written.push(id), {
      yieldToEventLoop: immediate,
    });
    expect(written).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    expect(summary).toEqual({ applied: written, failed: [], cancelled: false });
  });

  it('emits progress after every asset, counting applied and failed apart', async () => {
    const seen: BatchProgress<string>[] = [];
    await runBatchTransfer(
      ids(3),
      (id) => {
        if (id === 'a1') throw new Error('sidecar locked');
      },
      { onProgress: (p) => seen.push(p), yieldToEventLoop: immediate },
    );
    expect(seen.map((p) => p.processed)).toEqual([1, 2, 3]);
    expect(seen.map((p) => p.outcome)).toEqual(['applied', 'failed', 'applied']);
    expect(seen.at(-1)).toMatchObject({ total: 3, applied: 2, failed: 1 });
  });

  it('records a per-asset failure and keeps going — one bad asset is not fatal', async () => {
    const written: string[] = [];
    const summary = await runBatchTransfer(
      ids(4),
      (id) => {
        if (id === 'a1') throw new Error('sidecar locked');
        written.push(id);
      },
      { yieldToEventLoop: immediate },
    );
    // Every asset after the failure was still written — the old bare loop
    // would have abandoned them.
    expect(written).toEqual(['a0', 'a2', 'a3']);
    expect(summary.failed).toEqual([{ id: 'a1', reason: 'sidecar locked' }]);
    expect(summary.cancelled).toBe(false);
  });

  it('reports a non-Error rejection rather than dropping the reason', async () => {
    const summary = await runBatchTransfer(['a0'], () => Promise.reject('offline'), {
      yieldToEventLoop: immediate,
    });
    expect(summary.failed).toEqual([{ id: 'a0', reason: 'offline' }]);
  });

  it('cancellation leaves exactly the assets processed so far modified', async () => {
    const written: string[] = [];
    let cancelled = false;
    const summary = await runBatchTransfer(
      ids(10),
      (id) => {
        written.push(id);
        if (written.length === 3) cancelled = true;
      },
      { isCancelled: () => cancelled, yieldToEventLoop: immediate },
    );
    // Nothing is rolled back and nothing past the cancel point is touched.
    expect(written).toEqual(['a0', 'a1', 'a2']);
    expect(summary).toEqual({ applied: written, failed: [], cancelled: true });
  });

  it('a run cancelled before it starts writes nothing', async () => {
    const write = vi.fn();
    const summary = await runBatchTransfer(ids(50), write, {
      isCancelled: () => true,
      yieldToEventLoop: immediate,
    });
    expect(write).not.toHaveBeenCalled();
    expect(summary).toEqual({ applied: [], failed: [], cancelled: true });
  });

  it('awaits an async write before moving to the next asset', async () => {
    const order: string[] = [];
    await runBatchTransfer(
      ids(3),
      async (id) => {
        order.push(`start:${id}`);
        await Promise.resolve();
        order.push(`end:${id}`);
      },
      { yieldToEventLoop: immediate },
    );
    expect(order).toEqual(['start:a0', 'end:a0', 'start:a1', 'end:a1', 'start:a2', 'end:a2']);
  });

  it('yields on chunk boundaries only — not once per asset', async () => {
    const yieldFn = vi.fn(immediate);
    await runBatchTransfer(ids(100), () => undefined, {
      chunkSize: 10,
      yieldToEventLoop: yieldFn,
    });
    // 100 assets, chunk 10 → after assets 10..90; never after the last one.
    expect(yieldFn).toHaveBeenCalledTimes(9);
  });

  it('runs a 2,000-asset selection with bounded yields and no lost assets', async () => {
    const yieldFn = vi.fn(immediate);
    let writes = 0;
    const summary = await runBatchTransfer(ids(2000), () => void writes++, {
      yieldToEventLoop: yieldFn,
    });
    expect(writes).toBe(2000);
    expect(summary.applied).toHaveLength(2000);
    expect(summary.failed).toHaveLength(0);
    // The whole run costs one yield per chunk — the runner holds no
    // per-asset state beyond the two result arrays it returns.
    expect(yieldFn).toHaveBeenCalledTimes(Math.ceil(2000 / DEFAULT_BATCH_CHUNK) - 1);
  });

  it('an empty selection is a no-op, not an error', async () => {
    const summary = await runBatchTransfer([], () => undefined, { yieldToEventLoop: immediate });
    expect(summary).toEqual({ applied: [], failed: [], cancelled: false });
  });
});

describe('retryableIds (#2436)', () => {
  it('is exactly the failures, in their original order', () => {
    expect(
      retryableIds({
        applied: ['a0'],
        failed: [
          { id: 'a3', reason: 'x' },
          { id: 'a1', reason: 'y' },
        ],
        cancelled: false,
      }),
    ).toEqual(['a3', 'a1']);
  });
});

describe('batchSummaryText (#2436)', () => {
  it('states what happened, and never hides a failure', () => {
    expect(batchSummaryText({ applied: ['a', 'b'], failed: [], cancelled: false })).toBe(
      '2 images updated',
    );
    expect(batchSummaryText({ applied: ['a'], failed: [], cancelled: false })).toBe(
      '1 image updated',
    );
    expect(
      batchSummaryText({ applied: ['a'], failed: [{ id: 'b', reason: 'x' }], cancelled: false }),
    ).toBe('1 image updated · 1 failed');
  });

  it('a cancelled run says how far it got', () => {
    expect(
      batchSummaryText({
        applied: ['a', 'b'],
        failed: [{ id: 'c', reason: 'x' }],
        cancelled: true,
      }),
    ).toBe('Cancelled — 2 of 3 written · 1 failed');
  });
});
