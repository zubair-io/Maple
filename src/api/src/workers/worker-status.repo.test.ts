import { describe, it, expect, afterAll, beforeAll, beforeEach, spyOn } from 'bun:test';
import { closeDb, getDb } from '../db/client.ts';
import * as dbClient from '../db/client.ts';

// Own per-pid database + explicit close — the repo-wide suite convention
// (#2835): otherwise this file operates on whatever database MAPLE_MONGO_DB
// happens to name (the real `maple` dev DB when it runs first) and leaks its
// singleton connection into later suites (the #2783 flake class).
const TEST_DB = `maple_test_worker_status_repo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let reachable = true;
beforeAll(async () => {
  try {
    await closeDb();
    await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (reachable) await (await getDb()).collection('worker_status').deleteMany({ _id: 'singleton' });
});
afterAll(async () => {
  if (reachable) await (await getDb()).dropDatabase();
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
});
