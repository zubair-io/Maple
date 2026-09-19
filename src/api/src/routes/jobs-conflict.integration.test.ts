/**
 * HTTP conflict handling for job creation and failed-only retries, against real
 * roots and a real catalogue.
 *
 * Every conflict here is decided by SQLite (#3787): the request-id collision by
 * `ON CONFLICT (id) DO NOTHING` plus a read-back, and the "another batch already
 * holds this library" fence by the insert's own predicate. A fresh database per
 * test replaces the `deleteMany({})` on `jobs` the MongoDB version ran.
 *
 * The last case still needs a failure the routes did *not* anticipate, to prove
 * they do not dress one up as a 409. On MongoDB that was a unique index added to
 * the collection for the duration of the test; here it is a unique index added
 * to the table, which is the same trick against the same column.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Elysia } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { createJob, getJob, JobConflictError, markCancelled } from '../job-runner/jobs.repo.ts';
import { jobsRoutes } from './jobs.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let root = '';
const patch = { attributes: { 'crs:Exposure2012': '1.25' }, elements: {} };
const app = new Elysia().use(jobsRoutes);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'maple-job-conflicts-'));
  registerRoot(root);
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  insertFolder(live.db, { path: root, slug: 'conflicts' });
  invalidateLibraryRoots();
});

afterEach(() => {
  live.close();
  invalidateLibraryRoots();
});

afterAll(async () => {
  if (root) {
    unregisterRoot(root);
    await rm(root, { recursive: true, force: true });
  }
  invalidateLibraryRoots();
});

/** How many job rows exist — the MongoDB `countDocuments()`. */
function jobCount(): number {
  return (live.db.query(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n;
}

function batchPayload(name = 'photo') {
  return { targets: [{ id: `conflicts:${name}.jpg`, path: join(root, `${name}.jpg`) }], patch };
}

function post(path: string, body: Record<string, unknown>) {
  return app.handle(
    new Request(`http://localhost/api/jobs${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function failedBatch() {
  const payload = batchPayload();
  const previous = await createJob({ kind: 'batch_adjustment_sync', payload });
  await markCancelled(previous._id);
  const frozenPatch = { attributes: { 'crs:Exposure2012': '2.5' }, elements: {} };
  // `checkpoint` is the `ledger` column; the recovery ledger is written whole
  // here because the retry route is what is under test, not the checkpointer.
  run(
    live.db,
    `UPDATE jobs SET ledger = ? WHERE id = ?`,
    JSON.stringify({
      failed: [{ id: payload.targets[0].id, reason: 'Write failed' }],
      entries: [{ id: payload.targets[0].id, status: 'failed', patch: frozenPatch }],
    }),
    previous._id.toHexString(),
  );
  return { previous, payload, frozenPatch };
}

describe('job creation conflicts', () => {
  it('rejects a malformed batch target before path authorization', async () => {
    const response = await post('', {
      kind: 'batch_adjustment_sync',
      payload: { targets: [null], patch },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Every photo needs an id and an absolute path');
  });

  it('rejects targets whose aliased paths resolve to one sidecar', async () => {
    const real = join(root, 'real');
    const alias = join(root, 'alias');
    await mkdir(real);
    await symlink(real, alias);
    const response = await post('', {
      kind: 'batch_adjustment_sync',
      payload: {
        targets: [
          { id: 'conflicts:real/photo.jpg', path: join(real, 'photo.jpg') },
          { id: 'conflicts:alias/photo.jpg', path: join(alias, 'photo.jpg') },
        ],
        patch,
      },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('share a sidecar');
  });

  it('reports a typed conflict when an identity belongs to a different payload', async () => {
    const requestId = new ObjectId().toHexString();
    await createJob({ kind: 'batch_jpeg_export', payload: { quality: 90 }, requestId });
    await expect(
      createJob({ kind: 'batch_jpeg_export', payload: { quality: 80 }, requestId }),
    ).rejects.toBeInstanceOf(JobConflictError);
  });

  it('returns 409 for a different payload or kind while preserving the original job', async () => {
    const requestId = new ObjectId().toHexString();
    const original = { kind: 'batch_jpeg_export', payload: { quality: 90 }, requestId };
    expect((await post('', original)).status).toBe(201);
    for (const body of [
      { ...original, payload: { quality: 80 } },
      { kind: 'batch_adjustment_sync', payload: batchPayload(), requestId },
    ]) {
      const response = await post('', body);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain('different job');
    }
    expect((await getJob(new ObjectId(requestId)))?.payload).toEqual(original.payload);
    expect((await post('', original)).status).toBe(201);
  });

  it('returns 409 for an active library conflict and accepts the submission after cancellation', async () => {
    const active = await createJob({
      kind: 'batch_adjustment_sync',
      payload: batchPayload('active'),
    });
    const body = { kind: 'batch_adjustment_sync', payload: batchPayload('later') };
    const blocked = await post('', body);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toContain('active in this library');
    await markCancelled(active._id);
    expect((await post('', body)).status).toBe(201);
  });

  it('fences active batches submitted through aliased library registrations', async () => {
    const alias = join(dirname(root), `${basename(root)}-alias`);
    await symlink(root, alias);
    registerRoot(alias);
    insertFolder(live.db, { path: alias, slug: 'conflicts-alias' });
    invalidateLibraryRoots();
    try {
      await createJob({ kind: 'batch_adjustment_sync', payload: batchPayload('canonical') });
      const response = await post('', {
        kind: 'batch_adjustment_sync',
        payload: {
          targets: [{ id: 'conflicts-alias:aliased.jpg', path: join(alias, 'aliased.jpg') }],
          patch,
        },
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain('active in this library');
    } finally {
      unregisterRoot(alias);
      await rm(alias, { force: true });
      invalidateLibraryRoots();
    }
  });

  it('returns 409 when a retry request id belongs to another job', async () => {
    const { previous } = await failedBatch();
    const requestId = new ObjectId().toHexString();
    await createJob({ kind: 'batch_jpeg_export', payload: {}, requestId });
    const response = await post(`/${previous._id}/retry-failed`, { requestId });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('different job');
    expect((await getJob(new ObjectId(requestId)))?.kind).toBe('batch_jpeg_export');
  });

  it('returns 409 when a retry overlaps an active library batch', async () => {
    const { previous } = await failedBatch();
    await createJob({ kind: 'batch_adjustment_sync', payload: batchPayload('active') });
    const response = await post(`/${previous._id}/retry-failed`, {});
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('active in this library');
  });

  it('recovers a lost retry response with one job and its original prepared patch', async () => {
    const { previous, payload, frozenPatch } = await failedBatch();
    const requestId = new ObjectId().toHexString();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post(`/${previous._id}/retry-failed`, { requestId });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: requestId });
    }
    const created = await getJob(new ObjectId(requestId));
    expect(created?.payload.targets).toEqual([{ ...payload.targets[0], patch: frozenPatch }]);
    expect(created?.payload).not.toHaveProperty('relativeWhiteBalance');
    expect(jobCount()).toBe(2);
  });

  it('preserves unrelated database failures as 500 on both creation routes', async () => {
    const { previous, payload } = await failedBatch();
    live.db.run(`CREATE UNIQUE INDEX test_unrelated_conflict ON jobs (kind)`);
    try {
      expect((await post('', { kind: 'batch_adjustment_sync', payload })).status).toBe(500);
      expect((await post(`/${previous._id}/retry-failed`, {})).status).toBe(500);
    } finally {
      live.db.run(`DROP INDEX test_unrelated_conflict`);
    }
  });
});
