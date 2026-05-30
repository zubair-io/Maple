import { describe, expect, it } from 'bun:test';
import { ThroughputWindow } from './throughput-window.ts';

describe('ThroughputWindow', () => {
  it('counts completions within the rolling window', () => {
    const tw = new ThroughputWindow(5 * 60_000);
    const now = Date.now();
    tw.record(new Date(now - 10_000));
    tw.record(new Date(now - 20_000));
    tw.record(new Date(now - 400_000)); // outside 5-min window
    expect(tw.countInWindow(now)).toBe(2);
  });

  it('returns 0 when empty', () => {
    const tw = new ThroughputWindow(5 * 60_000);
    expect(tw.countInWindow(Date.now())).toBe(0);
  });

  it('evicts old entries as the window advances', () => {
    const tw = new ThroughputWindow(1000);
    tw.record(new Date(Date.now() - 2000));
    expect(tw.countInWindow(Date.now())).toBe(0);
  });

  it('counts correctly after far more than window-many entries', () => {
    // 50_000 entries, all stamped within the trailing 300s window. The old
    // array+filter would scan all 50_000 on each read; the bucketed ring
    // collapses them into <=301 one-second slots and still returns the
    // exact total.
    const windowMs = 300_000;
    const tw = new ThroughputWindow(windowMs);
    const now = 1_000_000_000_000;
    const n = 50_000;
    for (let i = 0; i < n; i++) {
      // Spread across the window: i mod 250s of age, all inside 300s.
      tw.record(new Date(now - (i % 250_000)));
    }
    expect(tw.countInWindow(now)).toBe(n);
  });

  it('drops entries that age out of the window across many records', () => {
    const windowMs = 60_000;
    const tw = new ThroughputWindow(windowMs);
    const now = 2_000_000_000_000;
    // 1000 inside the window, 1000 well outside it.
    for (let i = 0; i < 1000; i++) tw.record(new Date(now - (i % 30_000)));
    for (let i = 0; i < 1000; i++) tw.record(new Date(now - 120_000 - (i % 30_000)));
    expect(tw.countInWindow(now)).toBe(1000);
  });

  it('read cost is independent of throughput (fixed bucket footprint)', () => {
    // Structural assertion — no wall-clock timing (flaky in CI). The internal
    // bucket arrays must stay a fixed size regardless of how many completions
    // were recorded: that IS the O(1)-per-record / O(window)-per-read invariant.
    const windowMs = 300_000;
    const expectedSlots = Math.ceil(windowMs / 1000) + 1;

    const few = new ThroughputWindow(windowMs);
    few.record(new Date());

    const many = new ThroughputWindow(windowMs);
    const base = Date.now();
    for (let i = 0; i < 200_000; i++) many.record(new Date(base - (i % 250_000)));

    type RingInternals = { slotBucket: { length: number }; slotHits: { length: number } };
    const fewInternal = few as unknown as RingInternals;
    const manyInternal = many as unknown as RingInternals;

    expect(fewInternal.slotBucket.length).toBe(expectedSlots);
    expect(manyInternal.slotBucket.length).toBe(expectedSlots);
    expect(manyInternal.slotBucket.length).toBe(fewInternal.slotBucket.length);
    expect(manyInternal.slotHits.length).toBe(expectedSlots);
  });

  it('ignores future-dated (clock-skewed) records', () => {
    const tw = new ThroughputWindow(300_000);
    const now = 3_000_000_000_000;
    tw.record(new Date(now - 5_000)); // inside window
    tw.record(new Date(now + 60_000)); // future — read-side cap must exclude it
    expect(tw.countInWindow(now)).toBe(1);
  });
});
