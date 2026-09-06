/** Real Mongo indexes exercise HTTP conflict handling for creation and failed-only retries. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { type MongoClient, ObjectId } from 'mongodb';
import { closeDb, getDb } from '../db/client.ts';
import { tryConnectTestMongo, withTestDb } from '../db/test-db.test-helpers.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { createJob, getJob, JobConflictError, markCancelled } from '../job-runner/jobs.repo.ts';
import { jobsRoutes } from './jobs.ts';

const dbName = withTestDb(`maple_test_job_conflicts_${process.pid}`);
let mongo: MongoClient | null = null;
let root = '';
const patch = { attributes: { 'crs:Exposure2012': '1.25' }, elements: {} };
const app = new Elysia().use(jobsRoutes);

beforeAll(async () => {
  mongo = await tryConnectTestMongo();
  if (!mongo) throw new Error('Job conflict integration tests require MongoDB');
  root = await mkdtemp(join(tmpdir(), 'maple-job-conflicts-'));
  registerRoot(root);
  await closeDb();
  await (await getDb()).collection('folders').insertOne({ path: root, slug: 'conflicts' });
  invalidateLibraryRoots();
});
beforeEach(async () => {
  if (mongo) await mongo.db(dbName).collection('jobs').deleteMany({});
});
afterAll(async () => {
  await closeDb();
  await mongo?.close();
  if (root) {
    unregisterRoot(root);
    await rm(root, { recursive: true, force: true });
  }
  invalidateLibraryRoots();
});

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
  await mongo!
    .db(dbName)
    .collection('jobs')
    .updateOne(
      { _id: previous._id },
      {
        $set: {
          checkpoint: {
            failed: [{ id: payload.targets[0].id, reason: 'Write failed' }],
            entries: [{ id: payload.targets[0].id, status: 'failed', patch: frozenPatch }],
          },
        },
      },
    );
  return { previous, payload, frozenPatch };
}

describe('job creation conflicts', () => {
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
    expect(await mongo!.db(dbName).collection('jobs').countDocuments()).toBe(2);
  });

  it('preserves unrelated database failures as 500 on both creation routes', async () => {
    const { previous, payload } = await failedBatch();
    const collection = mongo!.db(dbName).collection('jobs');
    await collection.createIndex({ kind: 1 }, { unique: true, name: 'test_unrelated_conflict' });
    try {
      expect((await post('', { kind: 'batch_adjustment_sync', payload })).status).toBe(500);
      expect((await post(`/${previous._id}/retry-failed`, {})).status).toBe(500);
    } finally {
      await collection.dropIndex('test_unrelated_conflict');
    }
  });
});
