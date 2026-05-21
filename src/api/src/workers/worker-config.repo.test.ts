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
      pollIntervalMs: 1000,
      batchSize: 10,
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
      pollIntervalMs: 1000,
      batchSize: 10,
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
      pollIntervalMs: 1000,
      batchSize: 10,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    await repo.upsert('exif', {
      concurrency: 8,
      pollIntervalMs: 500,
      batchSize: 20,
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
      pollIntervalMs: 1000,
      batchSize: 5,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    });
    await repo.patch('thumb', { concurrency: 4 });
    const result = await repo.load('thumb');
    expect(result?.concurrency).toBe(4);
    expect(result?.batchSize).toBe(5);
    expect(result?.paused).toBe(false);
  });
});
