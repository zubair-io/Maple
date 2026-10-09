/**
 * #4443 — the per-stage breakdown on a search's log line reports each awaited
 * stage by its own duration, so concurrent stages don't add up to more than
 * the request took.
 */

import { describe, expect, it } from 'bun:test';
import { stageTimings } from './stage-timings.ts';

/** A clock the test advances by hand. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  const state = { at: 1_000 };
  return { now: () => state.at, advance: (ms) => (state.at += ms) };
}

describe('stageTimings', () => {
  it('reports each stage, in tenths of a millisecond, plus the total', async () => {
    const time = clock();
    const timings = stageTimings(time.now);
    await timings.time('embedMs', async () => time.advance(250.44));
    await timings.time('meiliMs', async () => time.advance(30.06));
    time.advance(5);
    expect(timings.report()).toEqual({ embedMs: 250.4, meiliMs: 30.1, totalMs: 285.5 });
  });

  it('records a stage that was awaited more than once as one sum', async () => {
    const time = clock();
    const timings = stageTimings(time.now);
    await timings.time('peopleMs', async () => time.advance(2));
    await timings.time('peopleMs', async () => time.advance(3));
    timings.record('peopleMs', 1);
    expect(timings.report().peopleMs).toBe(6);
  });

  it('records a stage even when its work throws', async () => {
    const time = clock();
    const timings = stageTimings(time.now);
    await expect(
      timings.time('rowsMs', async () => {
        time.advance(7);
        throw new Error('gone');
      }),
    ).rejects.toThrow('gone');
    expect(timings.report().rowsMs).toBe(7);
  });

  it('gives concurrent stages their own durations, not a shared one', async () => {
    const time = clock();
    const timings = stageTimings(time.now);
    const gate = Promise.withResolvers<void>();
    const page = timings.time('pageMs', async () => {
      await gate.promise;
      time.advance(10);
    });
    const count = timings.time('countMs', async () => {
      time.advance(4);
    });
    await count;
    gate.resolve();
    await page;
    expect(timings.report()).toEqual({ countMs: 4, pageMs: 14, totalMs: 14 });
  });

  it('leaves an un-awaited stage out of the report', () => {
    expect(stageTimings(clock().now).report()).toEqual({ totalMs: 0 });
  });
});
