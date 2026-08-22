/**
 * Unit tests for the operator-triggered "Run now" entry point.
 *
 * The guard matters more than the trigger: a run makes LLM calls that take
 * minutes, and the settings-page button will get double-clicked. The second
 * click must be refused, not queued — two concurrent runs would write
 * duplicate collections for the same day.
 *
 * `paused` is deliberately NOT checked here: the whole point of the button is
 * kicking a first run right after enabling — or a dry run WHILE paused to
 * evaluate the prompt before enabling. `runGeneratedSearchOnce`'s own paused
 * gate would skip the LLM work, so the trigger forces past it.
 */

import { describe, it, expect } from 'bun:test';
import { startRunNow, _resetRunNowForTests } from './run-now.ts';

describe('startRunNow', () => {
  it('starts a run and reports it', async () => {
    _resetRunNowForTests();
    let ran = 0;
    const result = startRunNow(async () => {
      ran += 1;
      return { libraries: 1, saved: 2, pruned: 0, skipped: false };
    });
    expect(result.started).toBe(true);
    await Promise.resolve();
    expect(ran).toBe(1);
  });

  it('refuses a second click while a run is in flight', async () => {
    _resetRunNowForTests();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));

    const first = startRunNow(async () => {
      await gate;
      return { libraries: 0, saved: 0, pruned: 0, skipped: false };
    });
    const second = startRunNow(async () => {
      throw new Error('must not start');
    });

    expect(first.started).toBe(true);
    expect(second).toEqual({ started: false, reason: 'already-running' });

    release();
    await new Promise((r) => setTimeout(r, 0));
    // The slot frees once the run settles.
    const third = startRunNow(async () => ({ libraries: 0, saved: 0, pruned: 0, skipped: false }));
    expect(third.started).toBe(true);
  });

  it('frees the slot even when the run throws', async () => {
    _resetRunNowForTests();
    startRunNow(async () => {
      throw new Error('boom');
    });
    await new Promise((r) => setTimeout(r, 0));
    const next = startRunNow(async () => ({ libraries: 0, saved: 0, pruned: 0, skipped: false }));
    expect(next.started).toBe(true);
  });
});
