/**
 * Auto-clustering coordinator tests — no Mongo.
 *
 * `runOnlineClustering` is injected as a stub so we exercise the trigger
 * logic (N-faces / idle edge), the single-flight + coalescing guard, and the
 * skip cases (paused / zero-processed) without touching the DB.
 */

import { describe, it, expect } from 'bun:test';
import {
  ClusterCoordinator,
  resolveAutoclusterThreshold,
  DEFAULT_AUTOCLUSTER_FACE_THRESHOLD,
  type ClusterRunner,
} from './cluster-coordinator.ts';
import type { RunOnlineClusteringResult } from './clustering-job.ts';

const RESULT: RunOnlineClusteringResult = { assigned: 0, newPeople: 0, scanned: 0 };

/** A runner stub that counts calls and lets a test hold a pass open until
 * `release()` is called (to provoke concurrency). */
function makeRunner(): {
  runner: ClusterRunner;
  calls: () => number;
  release: () => void;
  gate: (on: boolean) => void;
} {
  let calls = 0;
  let gated = false;
  let pending: Array<() => void> = [];
  const runner: ClusterRunner = async () => {
    calls += 1;
    if (gated) {
      await new Promise<void>((resolve) => pending.push(resolve));
    }
    return RESULT;
  };
  return {
    runner,
    calls: () => calls,
    release: () => {
      const waiters = pending;
      pending = [];
      for (const r of waiters) r();
    },
    gate: (on: boolean) => {
      gated = on;
    },
  };
}

/** Spin the microtask queue so queued `void`-promises settle. */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('resolveAutoclusterThreshold', () => {
  it('returns fallback when unset', () => {
    expect(resolveAutoclusterThreshold(undefined)).toBe(DEFAULT_AUTOCLUSTER_FACE_THRESHOLD);
  });
  it('parses a valid integer', () => {
    expect(resolveAutoclusterThreshold('250')).toBe(250);
  });
  it('rejects zero / negative / non-integer and falls back', () => {
    expect(resolveAutoclusterThreshold('0', 500)).toBe(500);
    expect(resolveAutoclusterThreshold('-3', 500)).toBe(500);
    expect(resolveAutoclusterThreshold('1.5', 500)).toBe(500);
    expect(resolveAutoclusterThreshold('abc', 500)).toBe(500);
  });
});

describe('ClusterCoordinator — N-faces trigger', () => {
  it('fires a pass once the running total reaches the threshold', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 10 });

    c.notifyProgress(4, false); // 4 — below
    await tick();
    expect(calls()).toBe(0);

    c.notifyProgress(6, false); // 10 — hits threshold
    await tick();
    expect(calls()).toBe(1);
    // Accumulator reset after the pass started.
    expect(c._state.facesSinceLastPass).toBe(0);
  });

  it('does not fire below the threshold', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 100 });
    c.notifyProgress(50, false);
    c.notifyProgress(40, false);
    await tick();
    expect(calls()).toBe(0);
  });
});

describe('ClusterCoordinator — idle edge', () => {
  it('fires exactly once on the work → drained edge, not on repeat idle ticks', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 1000 });

    c.notifyProgress(5, false); // did work
    await tick();
    expect(calls()).toBe(0); // below N-threshold, no fire yet

    c.notifyProgress(0, true); // drained → idle edge → fire
    await tick();
    expect(calls()).toBe(1);

    // Subsequent idle ticks with no work in between must NOT re-fire.
    c.notifyProgress(0, true);
    c.notifyProgress(0, true);
    await tick();
    expect(calls()).toBe(1);
  });

  it('does not fire on idle when no work was done since the last pass', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 1000 });
    // Stage idle from the start (at rest) — never did work.
    c.notifyProgress(0, true);
    c.notifyProgress(0, true);
    await tick();
    expect(calls()).toBe(0);
  });

  it('re-arms after a fresh batch of work following a drain', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 1000 });
    c.notifyProgress(3, false);
    c.notifyProgress(0, true); // fire #1
    await tick();
    expect(calls()).toBe(1);

    c.notifyProgress(2, false); // new work
    c.notifyProgress(0, true); // fire #2
    await tick();
    expect(calls()).toBe(2);
  });
});

describe('ClusterCoordinator — single-flight coalescing', () => {
  it('coalesces concurrent triggers into one in-flight + one queued pass', async () => {
    const { runner, calls, release, gate } = makeRunner();
    gate(true); // hold passes open
    const c = new ClusterCoordinator({ runner, faceThreshold: 5 });

    // First trigger starts a pass (now held open).
    c.notifyProgress(5, false);
    await tick();
    expect(calls()).toBe(1);
    expect(c._state.inFlight).toBe(true);

    // Three more triggers while the pass is in flight → coalesce to ONE
    // follow-up, not three.
    c.notifyProgress(5, false);
    c.notifyProgress(5, false);
    c.notifyProgress(5, false);
    await tick();
    expect(calls()).toBe(1); // still only the first pass running
    expect(c._state.dirty).toBe(true);

    // Release the first pass; the single coalesced follow-up runs.
    gate(false);
    release();
    await tick();
    expect(calls()).toBe(2); // exactly one follow-up, not three
    expect(c._state.inFlight).toBe(false);
    expect(c._state.dirty).toBe(false);
  });

  it('manual runClusterNow shares the lock and never runs concurrently', async () => {
    const { runner, calls, release, gate } = makeRunner();
    gate(true);
    const c = new ClusterCoordinator({ runner, faceThreshold: 5 });

    // Auto-trigger starts a held pass.
    c.notifyProgress(5, false);
    await tick();
    expect(calls()).toBe(1);

    // Manual click arrives mid-pass — must coalesce, not start a 2nd pass now.
    const manual = c.runClusterNow();
    await tick();
    expect(calls()).toBe(1);

    gate(false);
    release();
    await manual; // resolves after the coalesced follow-up pass
    expect(calls()).toBe(2);
    expect(c._state.inFlight).toBe(false);
  });
});

describe('ClusterCoordinator — skip cases', () => {
  it('zero-processed non-idle ticks never fire', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 10 });
    // A paused stage reports processed=0, idle=false via runOnce → no fire.
    c.notifyProgress(0, false);
    c.notifyProgress(0, false);
    await tick();
    expect(calls()).toBe(0);
  });

  it('a runner that throws does not wedge the single-flight lock', async () => {
    let calls = 0;
    const runner: ClusterRunner = async () => {
      calls += 1;
      throw new Error('boom');
    };
    const c = new ClusterCoordinator({ runner, faceThreshold: 1 });
    c.notifyProgress(1, false);
    await tick();
    expect(calls).toBe(1);
    expect(c._state.inFlight).toBe(false); // lock released despite throw

    // A later trigger still works.
    c.notifyProgress(1, false);
    await tick();
    expect(calls).toBe(2);
  });
});
