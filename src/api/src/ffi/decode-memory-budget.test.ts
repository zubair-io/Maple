import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  budgetBytesForPercent,
  DecodeMemoryBudget,
  DecodeMemoryBudgetError,
  estimateDecodeCost,
  estimateDecodePeakBytes,
  type ReleaseReservation,
} from './decode-memory-budget.ts';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Acquire and record the order grants arrive in. */
function track(budget: DecodeMemoryBudget, bytes: number, label: string, order: string[]) {
  const held: { release: ReleaseReservation | null; error: unknown } = {
    release: null,
    error: null,
  };
  budget
    .acquire(bytes)
    .then((release) => {
      order.push(label);
      held.release = release;
    })
    .catch((error: unknown) => {
      held.error = error;
    });
  return held;
}

describe('budget math', () => {
  it('derives the budget from a percent of the container limit; 0 means no cap', () => {
    expect(budgetBytesForPercent(50, 44 * GIB)).toBe(22 * GIB);
    expect(budgetBytesForPercent(0, 44 * GIB)).toBeNull();
  });

  it('estimates an extraction near the measured 0.5 GB and never below the floor', () => {
    expect(estimateDecodePeakBytes('extract', 1 * MIB)).toBe(512 * MIB);
    expect(estimateDecodePeakBytes('extract', 53_351_765)).toBe(53_351_765 * 12);
  });

  it('estimates a develop above the measured 7.2 GB peak of a 63 MB CR2', () => {
    expect(estimateDecodePeakBytes('develop', 63_000_000)).toBeGreaterThan(7.2 * 1e9);
    expect(estimateDecodePeakBytes('develop', 0)).toBe(1 * GIB);
  });

  it('sizes a real file from disk, and an unreadable one at the floor', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'maple-budget-'));
    try {
      const file = path.join(dir, 'a.cr2');
      writeFileSync(file, Buffer.alloc(16 * MIB));
      expect(await estimateDecodeCost({ weight: 'develop', sourcePath: file })).toBe(
        16 * MIB * 128,
      );
      expect(
        await estimateDecodeCost({
          weight: 'develop',
          sourcePath: path.join(dir, 'gone.cr2'),
        }),
      ).toBe(1 * GIB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DecodeMemoryBudget', () => {
  it('admits everything while uncapped', async () => {
    const budget = new DecodeMemoryBudget();
    const order: string[] = [];
    track(budget, 100 * GIB, 'a', order);
    track(budget, 100 * GIB, 'b', order);
    await settled();
    expect(order).toEqual(['a', 'b']);
    expect(budget.snapshot()).toEqual({
      limitBytes: null,
      reservedBytes: 200 * GIB,
      running: 2,
      waiting: 0,
    });
  });

  it('holds work that does not fit and releases waiters in arrival order', async () => {
    const budget = new DecodeMemoryBudget();
    budget.configure(10 * GIB);
    const order: string[] = [];
    const a = track(budget, 7 * GIB, 'a', order);
    const b = track(budget, 7 * GIB, 'b', order);
    const c = track(budget, 1 * GIB, 'c', order);
    await settled();
    expect(order).toEqual(['a']);
    expect(budget.snapshot().waiting).toBe(2);

    a.release!();
    await settled();
    expect(order).toEqual(['a', 'b', 'c']);
    b.release!();
    c.release!();
    expect(budget.snapshot()).toEqual({
      limitBytes: 10 * GIB,
      reservedBytes: 0,
      running: 0,
      waiting: 0,
    });
  });

  it('does not let small requests overtake a large one at the head (no starvation)', async () => {
    const budget = new DecodeMemoryBudget();
    budget.configure(10 * GIB);
    const order: string[] = [];
    const small = track(budget, 4 * GIB, 'small-1', order);
    track(budget, 8 * GIB, 'large', order);
    track(budget, 1 * GIB, 'small-2', order);
    await settled();
    expect(order).toEqual(['small-1']);
    small.release!();
    await settled();
    expect(order).toEqual(['small-1', 'large', 'small-2']);
  });

  it('rejects a request larger than the whole budget without blocking the queue', async () => {
    const budget = new DecodeMemoryBudget();
    budget.configure(4 * GIB);
    const order: string[] = [];
    const huge = track(budget, 12 * GIB, 'huge', order);
    track(budget, 1 * GIB, 'next', order);
    await settled();
    expect(huge.error).toBeInstanceOf(DecodeMemoryBudgetError);
    expect((huge.error as Error).message).toContain('Decode memory budget');
    expect(order).toEqual(['next']);
  });

  it('rejects a waiting request that a lowered budget can no longer hold', async () => {
    const budget = new DecodeMemoryBudget();
    budget.configure(10 * GIB);
    const order: string[] = [];
    const first = track(budget, 6 * GIB, 'first', order);
    const second = track(budget, 6 * GIB, 'second', order);
    await settled();
    budget.configure(5 * GIB);
    await settled();
    expect(second.error).toBeInstanceOf(DecodeMemoryBudgetError);
    first.release!();
    expect(budget.snapshot().reservedBytes).toBe(0);
  });

  it('admits waiters at once when the cap is removed (the escape hatch)', async () => {
    const budget = new DecodeMemoryBudget();
    budget.configure(2 * GIB);
    const order: string[] = [];
    track(budget, 2 * GIB, 'a', order);
    track(budget, 2 * GIB, 'b', order);
    await settled();
    expect(order).toEqual(['a']);
    budget.configure(null);
    await settled();
    expect(order).toEqual(['a', 'b']);
  });

  it('releases a reservation once even when release is called twice', async () => {
    const budget = new DecodeMemoryBudget();
    budget.configure(10 * GIB);
    const order: string[] = [];
    const a = track(budget, 3 * GIB, 'a', order);
    track(budget, 3 * GIB, 'b', order);
    await settled();
    a.release!();
    a.release!();
    expect(budget.snapshot()).toMatchObject({
      reservedBytes: 3 * GIB,
      running: 1,
    });
  });

  it('rejects every waiter on shutdown', async () => {
    const budget = new DecodeMemoryBudget();
    budget.configure(1 * GIB);
    const order: string[] = [];
    track(budget, 1 * GIB, 'a', order);
    const waiting = track(budget, 1 * GIB, 'b', order);
    await settled();
    budget.rejectWaiters(new Error('shutting down'));
    await settled();
    expect((waiting.error as Error).message).toBe('shutting down');
    expect(budget.snapshot().waiting).toBe(0);
  });
});

describe('DecodeMemoryBudget — whole-budget reservation (panorama)', () => {
  it('waits for running decodes, then excludes new ones until it releases', async () => {
    const budget = new DecodeMemoryBudget();
    budget.configure(20 * GIB);
    const order: string[] = [];
    const decode = track(budget, 7 * GIB, 'decode-1', order);
    let releasePano: ReleaseReservation | null = null;
    void budget.acquireAll().then((release) => {
      order.push('pano');
      releasePano = release;
    });
    track(budget, 1 * GIB, 'decode-2', order);
    await settled();
    expect(order).toEqual(['decode-1']);

    decode.release!();
    await settled();
    expect(order).toEqual(['decode-1', 'pano']);
    expect(budget.snapshot()).toMatchObject({
      reservedBytes: 20 * GIB,
      waiting: 1,
    });

    releasePano!();
    await settled();
    expect(order).toEqual(['decode-1', 'pano', 'decode-2']);
  });

  it('is never rejected as oversize, even after the budget shrinks', async () => {
    const budget = new DecodeMemoryBudget();
    budget.configure(20 * GIB);
    const order: string[] = [];
    const decode = track(budget, 7 * GIB, 'decode', order);
    await settled();
    let admitted = false;
    void budget.acquireAll().then(() => {
      admitted = true;
    });
    budget.configure(8 * GIB);
    decode.release!();
    await settled();
    expect(admitted).toBe(true);
    expect(budget.snapshot().reservedBytes).toBe(8 * GIB);
  });

  it('runs at once and reserves nothing while uncapped', async () => {
    const budget = new DecodeMemoryBudget();
    const release = await budget.acquireAll();
    expect(budget.snapshot().reservedBytes).toBe(0);
    release();
  });
});
