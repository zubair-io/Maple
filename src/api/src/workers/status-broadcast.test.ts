/**
 * `WorkersStatusBroadcaster` — subscription gating and single-broadcast fan-out.
 *
 * Deliberately database-free. The broadcaster takes its count source and its
 * demand poke as constructor arguments, so every test here injects both and
 * nothing under test reads or writes a row. The suite used to open a per-pid
 * MongoDB database and empty `worker_status` around each test purely as
 * isolation hygiene against the shared client singleton; with the singleton gone
 * (#3787) there is nothing left for that to protect.
 */

import { describe, expect, it } from 'bun:test';
import { WorkersStatusBroadcaster, type WorkersStatusFrame } from './status-broadcast.ts';
import type { WorkersStatusPayload } from './routes.ts';

const fakePayload: WorkersStatusPayload = {
  stages: [
    {
      name: 'thumb',
      status: 'running',
      inFlight: 1,
      configured: 2,
      pending: 42,
      ready: 40,
      blocked: 2,
      dead: 0,
      throughput: 7,
      lastError: null,
      config: null,
      batchSize: 10,
    },
  ],
  damaged: 0,
  newlyHiddenTotal: 0,
  countsAt: 1_700_000_000_000,
};

/** Every broadcaster under test gets a no-op demand poke — the real one sets
 * the worker's demand flag, which these unit tests don't need. */
const noPoke = async () => {};

describe('WorkersStatusBroadcaster — subscription gating', () => {
  it('does not run counts (no count source call) when there are no subscribers', async () => {
    let counts = 0;
    const b = new WorkersStatusBroadcaster(async () => {
      counts++;
      return fakePayload;
    }, noPoke);
    b._resetForTests();
    expect(b.isCounting).toBe(false);
    // A tick with zero subscribers must not call the count source.
    await b._tickForTests();
    expect(counts).toBe(0);
    expect(b.subscriberCount).toBe(0);
  });

  it('a late joiner immediately receives the last broadcast frame (no extra status read)', async () => {
    let computes = 0;
    const b = new WorkersStatusBroadcaster(async () => {
      computes++;
      return fakePayload;
    }, noPoke);
    b._resetForTests();
    const first: WorkersStatusFrame[] = [];
    b.subscribe((f) => first.push(f));
    await Promise.resolve();
    await b._tickForTests();
    expect(first.length).toBeGreaterThanOrEqual(1);
    const computesBefore = computes;

    const late: WorkersStatusFrame[] = [];
    b.subscribe((f) => late.push(f));
    // Synchronous replay of the last frame, and no status recompute for it.
    expect(late).toHaveLength(1);
    expect(late[0]).toBe(first[first.length - 1]!);
    expect(computes).toBe(computesBefore);
    b._resetForTests();
  });

  it('marks frames counted only when the worker has persisted counts (countsAt set)', async () => {
    const b = new WorkersStatusBroadcaster(
      async () => ({ ...fakePayload, countsAt: null }),
      noPoke,
    );
    b._resetForTests();
    const frames: WorkersStatusFrame[] = [];
    b.subscribe((f) => frames.push(f));
    await Promise.resolve();
    await b._tickForTests();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]!.counted).toBe(false);
    b._resetForTests();
  });

  it('pokes the worker demand flag on every tick while subscribed', async () => {
    let pokes = 0;
    const b = new WorkersStatusBroadcaster(
      async () => fakePayload,
      async () => {
        pokes++;
      },
    );
    b._resetForTests();
    b.subscribe(() => {});
    await Promise.resolve();
    await b._tickForTests();
    expect(pokes).toBeGreaterThanOrEqual(1);
    b._resetForTests();
  });

  it('arms the shared count timer only while ≥1 subscriber is present', () => {
    const b = new WorkersStatusBroadcaster(async () => fakePayload, noPoke);
    b._resetForTests();
    expect(b.isCounting).toBe(false);
    const off1 = b.subscribe(() => {});
    expect(b.isCounting).toBe(true);
    const off2 = b.subscribe(() => {});
    expect(b.subscriberCount).toBe(2);
    off1();
    // Still one subscriber — timer stays armed.
    expect(b.isCounting).toBe(true);
    off2();
    // Last subscriber gone — timer stops, so counts no longer run.
    expect(b.isCounting).toBe(false);
    expect(b.subscriberCount).toBe(0);
  });
});

describe('WorkersStatusBroadcaster — single broadcast to N subscribers', () => {
  it('runs counts ONCE and fans the counted frame out to every subscriber', async () => {
    let counts = 0;
    const b = new WorkersStatusBroadcaster(async () => {
      counts++;
      return fakePayload;
    }, noPoke);
    b._resetForTests();

    const a: WorkersStatusFrame[] = [];
    const c: WorkersStatusFrame[] = [];
    const d: WorkersStatusFrame[] = [];
    b.subscribe((f) => a.push(f));
    b.subscribe((f) => c.push(f));
    b.subscribe((f) => d.push(f));

    // The first subscribe arms the timer with an immediate auto-tick. Flush
    // any pending microtasks so that counted frame lands before we reset, then
    // assert solely on one explicit tick.
    await Promise.resolve();
    await b._tickForTests();
    a.length = 0;
    c.length = 0;
    d.length = 0;
    counts = 0;

    await b._tickForTests();

    // The expensive count source ran exactly once for all three subscribers.
    expect(counts).toBe(1);
    // Each subscriber received that single counted frame.
    for (const sink of [a, c, d]) {
      expect(sink).toHaveLength(1);
      expect(sink[0]!.counted).toBe(true);
      expect(sink[0]!.status.stages[0]!.pending).toBe(42);
    }
    b._resetForTests();
  });

  it('guards against overlapping ticks — a second tick is a no-op while one is in flight', async () => {
    // A slow count source: resolve it manually so we can fire a second tick
    // while the first is still pending.
    let resolveCount: ((p: WorkersStatusPayload) => void) | null = null;
    let calls = 0;
    const b = new WorkersStatusBroadcaster(() => {
      calls++;
      return new Promise<WorkersStatusPayload>((res) => {
        resolveCount = res;
      });
    }, noPoke);
    b._resetForTests();
    const frames: WorkersStatusFrame[] = [];
    // Subscribe WITHOUT letting the auto-tick settle (its promise is pending).
    b.subscribe((f) => frames.push(f));
    // The demand poke is awaited before the status compute — let it settle.
    await Promise.resolve();
    await Promise.resolve();

    // The auto-tick from subscribe is already in flight (calls === 1, unresolved).
    expect(calls).toBe(1);

    // Fire a second tick while the first is still pending — must be skipped.
    const second = b._tickForTests();
    expect(calls).toBe(1); // no new count pass started

    // Resolve the first pass; it broadcasts one counted frame.
    resolveCount!(fakePayload);
    await second;
    await Promise.resolve();

    expect(calls).toBe(1);
    // Exactly one counted frame from the single completed pass.
    const counted = frames.filter((f) => f.counted);
    expect(counted).toHaveLength(1);
    b._resetForTests();
  });

  it('a failing send to one subscriber does not abort the fan-out', async () => {
    const b = new WorkersStatusBroadcaster(async () => fakePayload, noPoke);
    b._resetForTests();
    const good: WorkersStatusFrame[] = [];
    b.subscribe(() => {
      throw new Error('dead socket');
    });
    b.subscribe((f) => good.push(f));
    await Promise.resolve();
    await b._tickForTests();
    good.length = 0;
    await b._tickForTests();
    expect(good).toHaveLength(1);
    expect(good[0]!.counted).toBe(true);
    b._resetForTests();
  });
});
