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
  it('fires a pass once the running FACE total reaches the threshold', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 10 });

    c.recordFacesEmbedded(4); // 4 — below
    await tick();
    expect(calls()).toBe(0);

    c.recordFacesEmbedded(6); // 10 — hits threshold
    await tick();
    expect(calls()).toBe(1);
    // Accumulator reset after the pass started.
    expect(c._state.facesSinceLastPass).toBe(0);
  });

  it('does not fire below the threshold', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 100 });
    c.recordFacesEmbedded(50);
    c.recordFacesEmbedded(40);
    await tick();
    expect(calls()).toBe(0);
  });

  it('counts FACES, not asset docs — a zero-face asset does not advance', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 3 });
    // Three assets, none of which had any faces — must not advance the counter
    // (the old asset-count cadence would have fired here).
    c.recordFacesEmbedded(0);
    c.recordFacesEmbedded(0);
    c.recordFacesEmbedded(0);
    await tick();
    expect(calls()).toBe(0);
    expect(c._state.facesSinceLastPass).toBe(0);
    // A single 3-face asset DOES cross the threshold.
    c.recordFacesEmbedded(3);
    await tick();
    expect(calls()).toBe(1);
  });

  it('arms: reaching the threshold logs/triggers once until N more accumulate', async () => {
    const { runner, calls, release, gate } = makeRunner();
    gate(true); // hold the pass open so the threshold can't reset via runPass
    const c = new ClusterCoordinator({ runner, faceThreshold: 10 });

    c.recordFacesEmbedded(10); // crosses → one trigger
    await tick();
    expect(calls()).toBe(1);
    expect(c._state.inFlight).toBe(true);
    expect(c._state.dirty).toBe(false);
    // Accumulator reset on the cross, so further records during the in-flight
    // pass must NOT re-trigger until N more faces accumulate.
    expect(c._state.facesSinceLastPass).toBe(0);

    c.recordFacesEmbedded(4); // 4 < 10 — no new trigger, no dirty
    await tick();
    expect(c._state.dirty).toBe(false);

    c.recordFacesEmbedded(6); // 10 again — crosses → arms the ONE follow-up
    await tick();
    expect(c._state.dirty).toBe(true);
    expect(c._state.facesSinceLastPass).toBe(0);

    // More faces while a follow-up is already queued must not re-arm/re-log.
    c.recordFacesEmbedded(50);
    await tick();
    expect(c._state.dirty).toBe(true);

    gate(false);
    release();
    await tick();
    expect(calls()).toBe(2); // exactly the one coalesced follow-up
  });
});

describe('ClusterCoordinator — idle edge', () => {
  it('fires exactly once on the work → drained edge, not on repeat idle ticks', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 1000 });

    c.recordFacesEmbedded(5); // did work (embedded faces)
    c.notifyProgress(2, false); // loop tick — still has work
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

  it('does not fire on idle when no faces were embedded since the last pass', async () => {
    const { runner, calls } = makeRunner();
    const c = new ClusterCoordinator({ runner, faceThreshold: 1000 });
    // Loop processed asset docs but the handler reported zero faces on each.
    c.recordFacesEmbedded(0);
    c.notifyProgress(3, false);
    c.notifyProgress(0, true);
    await tick();
    expect(calls()).toBe(0);
  });

  it('does not fire on idle when the stage was idle from the start', async () => {
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
    c.recordFacesEmbedded(3);
    c.notifyProgress(0, true); // fire #1
    await tick();
    expect(calls()).toBe(1);

    c.recordFacesEmbedded(2); // new faces embedded
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
    c.recordFacesEmbedded(5);
    await tick();
    expect(calls()).toBe(1);
    expect(c._state.inFlight).toBe(true);

    // Three more triggers while the pass is in flight → coalesce to ONE
    // follow-up, not three.
    c.recordFacesEmbedded(5);
    c.recordFacesEmbedded(5);
    c.recordFacesEmbedded(5);
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
    c.recordFacesEmbedded(5);
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
    c.recordFacesEmbedded(1);
    await tick();
    expect(calls).toBe(1);
    expect(c._state.inFlight).toBe(false); // lock released despite throw

    // A later trigger still works.
    c.recordFacesEmbedded(1);
    await tick();
    expect(calls).toBe(2);
  });
});

describe('ClusterCoordinator — manual vs auto error semantics', () => {
  it('auto-trigger SWALLOWS a runner failure (no throw, loop survives)', async () => {
    let calls = 0;
    const runner: ClusterRunner = async () => {
      calls += 1;
      throw new Error('auto boom');
    };
    const c = new ClusterCoordinator({ runner, faceThreshold: 1 });
    // Auto path goes through recordFacesEmbedded → void trigger(); the
    // rejection must NOT surface anywhere (it's logged + swallowed).
    c.recordFacesEmbedded(1);
    await tick();
    expect(calls).toBe(1);
    expect(c._state.inFlight).toBe(false);
  });

  it('manual runClusterNow RETHROWS when its pass fails', async () => {
    const err = new Error('manual boom');
    const runner: ClusterRunner = async () => {
      throw err;
    };
    const c = new ClusterCoordinator({ runner, faceThreshold: 1000 });
    await expect(c.runClusterNow()).rejects.toThrow('manual boom');
    // Lock released; a later successful manual run resolves cleanly.
    expect(c._state.inFlight).toBe(false);
  });

  it('manual run resolves with counts when its pass succeeds', async () => {
    const runner: ClusterRunner = async () => ({ assigned: 7, newPeople: 2, scanned: 99 });
    const c = new ClusterCoordinator({ runner, faceThreshold: 1000 });
    const result = await c.runClusterNow();
    expect(result).toEqual({ assigned: 7, newPeople: 2, scanned: 99 });
  });

  it('a coalesced manual call reflects the coalesced pass: rethrows if it threw', async () => {
    let calls = 0;
    let gated = true;
    let pending: Array<() => void> = [];
    const runner: ClusterRunner = async () => {
      calls += 1;
      if (gated) await new Promise<void>((resolve) => pending.push(resolve));
      // The follow-up (coalesced) pass throws.
      if (calls >= 2) throw new Error('coalesced boom');
      return { assigned: 0, newPeople: 0, scanned: 0 };
    };
    const release = () => {
      const w = pending;
      pending = [];
      for (const r of w) r();
    };
    const c = new ClusterCoordinator({ runner, faceThreshold: 5 });

    // Auto-trigger starts a held first pass.
    c.recordFacesEmbedded(5);
    await tick();
    expect(calls).toBe(1);

    // Manual click coalesces onto the guaranteed follow-up (which will throw).
    const manual = c.runClusterNow();
    await tick();

    gated = false;
    release();
    await expect(manual).rejects.toThrow('coalesced boom');
    expect(calls).toBe(2);
    expect(c._state.inFlight).toBe(false);
  });
});
