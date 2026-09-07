import { describe, expect, it } from 'bun:test';
import type { Collection } from 'mongodb';
import type { WorkerConfigDoc } from './worker-config.repo.ts';
import { WorkerConfigRepo } from './worker-config.repo.ts';

// ---------------------------------------------------------------------------
// Hand-rolled typed mock for Collection<WorkerConfigDoc>.
// No mongodb-memory-server needed — the repo only calls findOne, updateOne,
// and we can fully control those with a simple in-memory Map.
// ---------------------------------------------------------------------------

function makeMockCollection(): Collection<WorkerConfigDoc> {
  const store = new Map<string, WorkerConfigDoc>();

  return {
    async findOne(filter: Record<string, unknown>) {
      const name = filter['name'] as string | undefined;
      if (!name) return null;
      return store.get(name) ?? null;
    },
    async updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      opts?: { upsert?: boolean },
    ) {
      const name = filter['name'] as string;
      const setDoc = (update['$set'] ?? {}) as Partial<WorkerConfigDoc>;
      if (opts?.upsert) {
        const existing = store.get(name);
        store.set(name, { ...(existing ?? {}), ...setDoc } as WorkerConfigDoc);
      } else {
        const existing = store.get(name);
        if (existing) store.set(name, { ...existing, ...setDoc });
      }
      return {
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
        acknowledged: true,
      };
    },
  } as unknown as Collection<WorkerConfigDoc>;
}

describe('WorkerConfigRepo.load', () => {
  it('returns null when no doc exists', async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    const result = await repo.load('thumb');
    expect(result).toBeNull();
  });

  it('returns the doc when it exists', async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert('thumb', {
      concurrency: 4,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 1,
    });
    const result = await repo.load('thumb');
    expect(result?.concurrency).toBe(4);
    expect(result?.last_seen_target_version).toBe(1);
  });
});

describe('WorkerConfigRepo.upsert', () => {
  it('inserts on first call', async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert('exif', {
      concurrency: 4,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    const result = await repo.load('exif');
    expect(result?.concurrency).toBe(4);
  });

  it('updates on subsequent calls', async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert('exif', {
      concurrency: 4,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    await repo.upsert('exif', {
      concurrency: 8,
      maxAttempts: 5,
      paused: true,
      last_seen_target_version: 1,
    });
    const result = await repo.load('exif');
    expect(result?.concurrency).toBe(8);
    expect(result?.paused).toBe(true);
    expect(result?.last_seen_target_version).toBe(1);
  });
});

describe('WorkerConfigRepo.patch', () => {
  it('updates only the supplied fields', async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert('thumb', {
      concurrency: 2,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    await repo.patch('thumb', { concurrency: 4 });
    const result = await repo.load('thumb');
    expect(result?.concurrency).toBe(4);
    expect(result?.maxAttempts).toBe(5);
    expect(result?.paused).toBe(false);
  });
});

describe('WorkerConfigRepo — self-imposed pause reason (#3315)', () => {
  it('round-trips pause_reason and omits the key when none was recorded', async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    await repo.upsert('meili', {
      concurrency: 2,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 10,
    });
    expect(await repo.load('meili')).not.toHaveProperty('pause_reason');

    await repo.patch('meili', { paused: true, pause_reason: 'Paused automatically: policy' });
    const paused = await repo.load('meili');
    expect(paused?.paused).toBe(true);
    expect(paused?.pause_reason).toBe('Paused automatically: policy');
  });

  it('clears pause_reason on every resume, whichever path patches paused: false', async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    await repo.patch('meili', { paused: true, pause_reason: 'Paused automatically: policy' });

    await repo.patch('meili', { paused: false });
    const resumed = await repo.load('meili');
    expect(resumed?.paused).toBe(false);
    expect(resumed).not.toHaveProperty('pause_reason');
  });

  it('keeps an existing pause_reason when an unrelated knob is patched', async () => {
    const coll = makeMockCollection();
    const repo = new WorkerConfigRepo(coll);
    await repo.patch('meili', { paused: true, pause_reason: 'Paused automatically: policy' });

    await repo.patch('meili', { concurrency: 4 });
    const patched = await repo.load('meili');
    expect(patched?.concurrency).toBe(4);
    expect(patched?.pause_reason).toBe('Paused automatically: policy');
  });
});
