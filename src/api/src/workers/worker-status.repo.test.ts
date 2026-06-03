import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { getDb } from '../db/client.ts';

let reachable = true;
beforeAll(async () => {
  try {
    await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (reachable) await (await getDb()).collection('worker_status').deleteMany({ _id: 'singleton' });
});

describe('worker-status.repo', () => {
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
});
