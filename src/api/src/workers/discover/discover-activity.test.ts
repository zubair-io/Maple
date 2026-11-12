/**
 * The single-flight guard in front of the `sweepRoot` activity: a redelivered
 * slice for a root that is still being swept joins the running slice rather
 * than starting a second one beside it.
 */
import { describe, expect, it } from 'bun:test';
import { singleFlightPerRoot } from './discover-activity.ts';
import type { SliceProgress, SweepSliceSummary } from './sweep-slice.ts';

const SUMMARY: SweepSliceSummary = {
  generation: 2,
  generationsCompleted: 1,
  directoriesVisited: 5,
  registered: true,
};
const PROGRESS: SliceProgress = {
  root: '/lib',
  generation: 1,
  generationsCompleted: 0,
  directoriesVisited: 1,
};

function gatedRunner() {
  const calls: string[] = [];
  const beats: Array<(progress: SliceProgress) => void> = [];
  let release = (_summary: SweepSliceSummary) => {};
  const run = (rootKey: string, heartbeat: (progress: SliceProgress) => void) => {
    calls.push(rootKey);
    beats.push(heartbeat);
    return new Promise<SweepSliceSummary>((resolve) => {
      release = resolve;
    });
  };
  return { calls, beats, run, release: (summary: SweepSliceSummary) => release(summary) };
}

const never = new AbortController().signal;

describe('singleFlightPerRoot', () => {
  it('a second delivery for a running root joins it, heartbeats with it, and ends with it', async () => {
    const runner = gatedRunner();
    const sweep = singleFlightPerRoot(runner.run);
    const first: SliceProgress[] = [];
    const second: SliceProgress[] = [];

    const running = sweep('root-a', (progress) => first.push(progress), never);
    const joined = sweep('root-a', (progress) => second.push(progress), never);
    runner.beats[0]!(PROGRESS);
    runner.release(SUMMARY);

    expect(await running).toEqual(SUMMARY);
    expect(await joined).toEqual(SUMMARY);
    expect(runner.calls).toEqual(['root-a']);
    expect(first).toEqual([PROGRESS]);
    expect(second).toEqual([PROGRESS]);
  });

  it('different roots sweep side by side', () => {
    const runner = gatedRunner();
    const sweep = singleFlightPerRoot(runner.run);

    void sweep('root-a', () => {}, never);
    void sweep('root-b', () => {}, never);

    expect(runner.calls).toEqual(['root-a', 'root-b']);
  });

  it('once a slice ends, the next delivery starts a new one', async () => {
    const runner = gatedRunner();
    const sweep = singleFlightPerRoot(runner.run);

    const first = sweep('root-a', () => {}, never);
    runner.release(SUMMARY);
    await first;
    const second = sweep('root-a', () => {}, never);
    runner.release({ ...SUMMARY, generation: 3 });

    expect((await second).generation).toBe(3);
    expect(runner.calls).toEqual(['root-a', 'root-a']);
  });

  it('a slice that fails frees its root for the retry', async () => {
    const sweep = singleFlightPerRoot(async () => {
      throw new Error('disk gone');
    });

    const failure = await sweep('root-a', () => {}, never).catch((error: unknown) => error);
    const retry = await sweep('root-a', () => {}, never).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(retry).toBeInstanceOf(Error);
    expect(retry).not.toBe(failure);
  });
});
