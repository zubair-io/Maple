import { describe, it, expect, afterAll, beforeAll, beforeEach, spyOn } from 'bun:test';
import type { Db } from 'mongodb';
import { closeDb, getDb } from '../db/client.ts';
import * as dbClient from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

// Own per-pid database + explicit close — the repo-wide suite convention
// (#2835): otherwise this file operates on whatever database MAPLE_MONGO_DB
// happens to name (the real `maple` dev DB when it runs first) and leaks its
// singleton connection into later suites (the #2783 flake class).
withTestDb(`maple_test_worker_status_repo_${process.pid}`);

// Captured here, not re-resolved in afterAll: withTestDb restores
// MAPLE_MONGO_DB before this suite's teardown runs.
let suiteDb: Db | null = null;

let reachable = true;
beforeAll(async () => {
  try {
    await closeDb();
    suiteDb = await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (reachable) await (await getDb()).collection('worker_status').deleteMany({ _id: 'singleton' });
});
afterAll(async () => {
  if (suiteDb) await suiteDb.dropDatabase();
  await closeDb();
});

describe('worker-status.repo', () => {
  it('returns null (never throws) when getDb() rejects', async () => {
    // Verify the DB-down degradation path: readWorkerStatus() must resolve to
    // null rather than rejecting so GET /api/workers/status degrades gracefully.
    // Uses spyOn on the db/client namespace (not mock.module, which leaks into
    // sibling test files in Bun's shared module registry).
    const spy = spyOn(dbClient, 'getDb').mockImplementation(async () => {
      throw new Error('simulated connection refused');
    });
    try {
      const { readWorkerStatus } = await import('./worker-status.repo.ts');
      const result = await readWorkerStatus();
      expect(result).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  it('returns null when no snapshot has been written', async () => {
    if (!reachable) return;
    const { readWorkerStatus } = await import('./worker-status.repo.ts');
    expect(await readWorkerStatus()).toBeNull();
  });

  it('round-trips a snapshot: write then read', async () => {
    if (!reachable) return;
    const { writeWorkerStatus, readWorkerStatus } = await import('./worker-status.repo.ts');

    const snapshot = {
      exif: {
        status: 'running' as const,
        inFlight: 2,
        throughput: 5,
        targetVersion: 1,
        dependsOn: [],
        lastError: null,
      },
      thumb: {
        status: 'paused' as const,
        inFlight: 0,
        throughput: 0,
        targetVersion: 1,
        dependsOn: [{ name: 'exif', minVersion: 1 }],
        lastError: 'disk full',
      },
    };
    const ts = Date.now();
    await writeWorkerStatus(snapshot, ts);

    const result = await readWorkerStatus();
    expect(result).not.toBeNull();
    expect(result!.updated_at).toBe(ts);
    expect(result!.statuses['exif'].status).toBe('running');
    expect(result!.statuses['exif'].inFlight).toBe(2);
    expect(result!.statuses['thumb'].status).toBe('paused');
    expect(result!.statuses['thumb'].lastError).toBe('disk full');
    expect(result!.statuses['thumb'].dependsOn).toEqual([{ name: 'exif', minVersion: 1 }]);
  });

  it('overwrites on subsequent writes (upsert — no duplicate id error)', async () => {
    if (!reachable) return;
    const { writeWorkerStatus, readWorkerStatus } = await import('./worker-status.repo.ts');

    await writeWorkerStatus(
      {
        exif: {
          status: 'running',
          inFlight: 1,
          throughput: 0,
          targetVersion: 1,
          dependsOn: [],
          lastError: null,
        },
      },
      1000,
    );
    await writeWorkerStatus(
      {
        exif: {
          status: 'paused',
          inFlight: 0,
          throughput: 0,
          targetVersion: 1,
          dependsOn: [],
          lastError: null,
        },
      },
      2000,
    );

    const result = await readWorkerStatus();
    expect(result!.updated_at).toBe(2000);
    expect(result!.statuses['exif'].status).toBe('paused');
  });

  it('round-trips the face-models status when supplied', async () => {
    if (!reachable) return;
    const { writeWorkerStatus, readWorkerStatus } = await import('./worker-status.repo.ts');

    await writeWorkerStatus({}, 1000, { kind: 'loaded', errorDetail: null });
    expect((await readWorkerStatus())!.face_models).toEqual({ kind: 'loaded', errorDetail: null });

    // Subsequent error state overwrites it.
    await writeWorkerStatus({}, 2000, { kind: 'error', errorDetail: 'onnx load failed' });
    expect((await readWorkerStatus())!.face_models).toEqual({
      kind: 'error',
      errorDetail: 'onnx load failed',
    });
  });

  it('omits face_models when not supplied (back-compat)', async () => {
    if (!reachable) return;
    const { writeWorkerStatus, readWorkerStatus } = await import('./worker-status.repo.ts');

    await writeWorkerStatus({}, 1000);
    expect((await readWorkerStatus())!.face_models).toBeUndefined();
  });

  it('counts and the registry snapshot live on the same doc but have separate writers (#3491)', async () => {
    if (!reachable) return;
    const { writeWorkerStatus, writeStatusCounts, readWorkerStatus } =
      await import('./worker-status.repo.ts');
    const counts = {
      pending: { exif: 3 },
      ready: { exif: 1 },
      dead: {},
      damaged: 0,
      newly_hidden: 0,
      computed_at: 1_700_000_000_000,
      duration_ms: 12,
    };
    // Counts written before any registry snapshot exists → doc is created.
    await writeStatusCounts(counts);
    expect((await readWorkerStatus())?.counts).toEqual(counts);
    // A registry write must not clobber the counts …
    await writeWorkerStatus({ exif: { status: 'running' } }, 5);
    const after = await readWorkerStatus();
    expect(after?.counts).toEqual(counts);
    expect(after?.updated_at).toBe(5);
    expect(after?.statuses['exif']?.status).toBe('running');
    // … and a counts write must not clobber the registry snapshot.
    await writeStatusCounts({ ...counts, computed_at: 1_700_000_000_001 });
    const again = await readWorkerStatus();
    expect(again?.statuses['exif']?.status).toBe('running');
    expect(again?.counts?.computed_at).toBe(1_700_000_000_001);
  });

  it('reads counts as null when the worker has never counted', async () => {
    if (!reachable) return;
    const { writeWorkerStatus, readWorkerStatus } = await import('./worker-status.repo.ts');
    await writeWorkerStatus({}, 1);
    expect((await readWorkerStatus())?.counts).toBeNull();
  });

  it('demand pokes only ever move the deadline forward', async () => {
    if (!reachable) return;
    const { pokeStatusCountsDemand, readStatusCountsDemand } =
      await import('./worker-status.repo.ts');
    expect(await readStatusCountsDemand()).toBe(0);
    await pokeStatusCountsDemand(2_000);
    expect(await readStatusCountsDemand()).toBe(2_000);
    // An older (smaller) poke arriving late must not shorten the window.
    await pokeStatusCountsDemand(1_000);
    expect(await readStatusCountsDemand()).toBe(2_000);
    await pokeStatusCountsDemand(3_000);
    expect(await readStatusCountsDemand()).toBe(3_000);
  });
});
