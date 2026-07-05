import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  WorkersStatusBroadcaster,
  cheapStatus,
  type WorkersStatusFrame,
} from './status-broadcast.ts';
import type { WorkersStatusPayload } from './routes.ts';
import { getDb } from '../db/client.ts';
import { writeWorkerStatus } from './worker-status.repo.ts';
import type { StageStatusSnapshot } from './registry.ts';

let dbReachable = true;
beforeAll(async () => {
  try {
    await getDb();
  } catch {
    dbReachable = false;
  }
});

async function cleanWorkerStatus(): Promise<void> {
  if (dbReachable) {
    await (await getDb()).collection('worker_status').deleteMany({ _id: 'singleton' });
  }
}

beforeEach(cleanWorkerStatus);
afterEach(cleanWorkerStatus);

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
};

describe('cheapStatus', () => {
  it('returns empty stages when worker_status has no doc', async () => {
    // No writeWorkerStatus call → readWorkerStatus returns null → empty stages.
    const payload = await cheapStatus();
    expect(Array.isArray(payload.stages)).toBe(true);
    expect(payload.stages).toHaveLength(0);
    expect(payload.damaged).toBe(0);
  });

  it('derives rows from worker_status with zeroed counts', async () => {
    if (!dbReachable) return;
    const snapshot: Record<string, StageStatusSnapshot> = {
      thumb: {
        status: 'running',
        inFlight: 2,
        throughput: 5,
        targetVersion: 1,
        dependsOn: [],
        lastError: null,
      },
    };
    await writeWorkerStatus(snapshot, Date.now());

    const payload = await cheapStatus();
    const row = payload.stages.find((s) => s.name === 'thumb');
    expect(row).toBeDefined();
    // Counts are the expensive half — must be zero in the cheap snapshot.
    expect(row!.pending).toBe(0);
    expect(row!.ready).toBe(0);
    expect(row!.blocked).toBe(0);
    expect(row!.dead).toBe(0);
    // Live fields flow through from worker_status.
    expect(row!.status).toBe('running');
    expect(row!.inFlight).toBe(2);
    expect(row!.throughput).toBe(5);
  });
});

describe('WorkersStatusBroadcaster — subscription gating', () => {
  it('does not run counts (no count source call) when there are no subscribers', async () => {
    let counts = 0;
    const b = new WorkersStatusBroadcaster(async () => {
      counts++;
      return fakePayload;
    });
    b._resetForTests();
    expect(b.isCounting).toBe(false);
    // A tick with zero subscribers must not call the count source.
    await b._tickForTests();
    expect(counts).toBe(0);
    expect(b.subscriberCount).toBe(0);
  });

  it('sends a cheap (counted:false) frame on subscribe', async () => {
    // cheapStatus is now async (reads worker_status Mongo). Use a never-settling
    // computeStatus so the only frame that can land is the cheap push.
    const b = new WorkersStatusBroadcaster(() => new Promise<WorkersStatusPayload>(() => {}));
    b._resetForTests();
    const frames: WorkersStatusFrame[] = [];
    b.subscribe((f) => frames.push(f));
    // No frame yet — the cheap push is async.
    expect(frames).toHaveLength(0);
    // Flush the cheapStatus promise (readWorkerStatus → a few microtask hops).
    await new Promise((r) => setTimeout(r, 10));
    // Exactly one frame: the cheap snapshot.
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe('workers-status');
    expect(frames[0]!.counted).toBe(false);
    b._resetForTests();
  });

  it('arms the shared count timer only while ≥1 subscriber is present', () => {
    const b = new WorkersStatusBroadcaster(async () => fakePayload);
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
    });
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
    });
    b._resetForTests();
    const frames: WorkersStatusFrame[] = [];
    // Subscribe WITHOUT letting the auto-tick settle (its promise is pending).
    b.subscribe((f) => frames.push(f));
    // subscribe pushes one cheap frame synchronously; drop it.
    frames.length = 0;

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
    const b = new WorkersStatusBroadcaster(async () => fakePayload);
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
