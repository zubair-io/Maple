/** Real temporary sidecars plus real Mongo. Set MAPLE_MONGO_URI to run integration cases. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from '../fs/mirrored.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Elysia } from 'elysia';
import { type MongoClient, ObjectId } from 'mongodb';
import { tryConnectTestMongo, withTestDb } from '../db/test-db.test-helpers.ts';
import { closeDb, getDb } from '../db/client.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { batchAdjustmentSyncHandler, parseSyncPayload } from './handlers/batch-adjustment-sync.ts';
import type { JobHandlerContext } from './handlers/index.ts';
import * as jobs from './jobs.repo.ts';
import { jobsRoutes } from '../routes/jobs.ts';

const dbName = withTestDb(`maple_test_batch_sync_${process.pid}`);
let mongo: MongoClient | null = null;
let root = '';
const patch = { attributes: { 'crs:Exposure2012': '1.25' }, elements: {} };
const untouched =
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:custom="urn:custom" custom:Keep="&#65;"/></rdf:RDF>';

beforeAll(async () => {
  mongo = await tryConnectTestMongo();
  if (!mongo) {
    console.log('[batch-sync integration] skipped: MongoDB unavailable');
    return;
  }
  root = await mkdtemp(join(tmpdir(), 'maple-batch-sync-'));
  registerRoot(root);
  await closeDb();
  await (await getDb()).collection('folders').insertOne({ path: root, slug: 'batch' });
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

async function target(name: string, sidecar = untouched) {
  const path = join(root, `${name}.jpg`);
  // The runner never decodes or modifies originals. These sentinel bytes make that testable.
  await writeFile(path, 'original sentinel');
  await writeFile(xmpSidecarPath(path), sidecar);
  return { id: `batch:${name}.jpg`, path };
}

async function context(jobId: ObjectId, worker = 'worker-a'): Promise<JobHandlerContext> {
  return {
    jobId,
    checkpoint: (await jobs.getJob(jobId))?.checkpoint,
    saveCheckpoint: (value) => jobs.saveJobCheckpoint(jobId, worker, value, 60000),
    reportProgress: (current, total) =>
      jobs.updateProgress(jobId, { current, total }, 60000, undefined, worker),
    shouldCancel: () => jobs.isCancelRequested(jobId),
  };
}
async function claimed(targets: Awaited<ReturnType<typeof target>>[]) {
  const job = await jobs.createJob({ kind: 'batch_adjustment_sync', payload: { targets, patch } });
  expect((await jobs.claimJob('worker-a', 60000))?._id.toHexString()).toBe(job._id.toHexString());
  return job;
}

describe('persisted batch adjustment sync', () => {
  it('reuses a client-generated job identity after a lost creation response', async () => {
    if (!mongo) return;
    const payload = { targets: [await target('request-id')], patch };
    const requestId = new ObjectId().toHexString();
    const one = await jobs.createJob({ kind: 'batch_adjustment_sync', payload, requestId });
    const two = await jobs.createJob({ kind: 'batch_adjustment_sync', payload, requestId });
    expect(two._id).toEqual(one._id);
    expect(await mongo.db(dbName).collection('jobs').countDocuments({ _id: one._id })).toBe(1);
    await expect(
      jobs.createJob({
        kind: 'batch_adjustment_sync',
        payload: { ...payload, patch: { attributes: { 'crs:Exposure2012': '2' }, elements: {} } },
        requestId,
      }),
    ).rejects.toThrow('different job');
  });

  it('returns 409 for conflicting create and retry identities without changing either job', async () => {
    if (!mongo) return;
    const targets = [await target('identity-conflict')];
    const original = await claimed(targets);
    const ctx = await context(original._id);
    await ctx.saveCheckpoint!({ failed: [{ id: targets[0].id, reason: 'Disk full' }] });
    await jobs.completeJob(original._id, {});
    const occupiedId = new ObjectId().toHexString();
    const occupied = await jobs.createJob({
      kind: 'batch_jpeg_export',
      payload: { assetIds: [] },
      requestId: occupiedId,
    });
    const app = new Elysia().use(jobsRoutes);
    for (const [route, body] of [
      [
        '/api/jobs',
        { kind: 'batch_adjustment_sync', payload: { targets, patch }, requestId: occupiedId },
      ],
      [`/api/jobs/${original._id}/retry-failed`, { requestId: occupiedId }],
    ] as const) {
      const response = await app.handle(
        new Request(`http://localhost${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain('different job');
    }
    expect(await jobs.getJob(occupied._id)).toEqual(occupied);
    expect((await jobs.getJob(original._id))?.checkpoint?.failed).toEqual([
      { id: targets[0].id, reason: 'Disk full' },
    ]);
    expect(await mongo.db(dbName).collection('jobs').countDocuments()).toBe(2);
  });

  it('measures a 2,000-sidecar run when MAPLE_BATCH_BENCHMARK=1', async () => {
    if (!mongo || process.env.MAPLE_BATCH_BENCHMARK !== '1') return;
    const targets = [];
    for (let i = 0; i < 2000; i++) targets.push(await target(`bench-${i}`));
    const job = await claimed(targets);
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 50);
    const started = performance.now();
    try {
      const out = await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
      expect(out.result.applied).toHaveLength(2000);
      expect(out.result.failed).toEqual([]);
      console.log(
        JSON.stringify({
          fixture: '2,000 synthetic local sidecars; no RAW decoding',
          elapsedMs: Math.round(performance.now() - started),
          baselineRssMiB: Math.round(baseline / 1048576),
          peakRssMiB: Math.round(peak / 1048576),
        }),
      );
      expect(await readFile(targets[1999].path, 'utf8')).toBe('original sentinel');
    } finally {
      clearInterval(sampler);
    }
  }, 180000);

  it('continues after a malformed sidecar and retries only failed photos through HTTP', async () => {
    if (!mongo) return;
    const targets = [await target('good'), await target('bad', '<broken>'), await target('later')];
    const job = await claimed(targets);
    const out = await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
    await jobs.completeJob(job._id, out.result);
    expect(out.result.applied).toEqual([targets[0].id, targets[2].id]);
    expect(out.result.failed as unknown[]).toHaveLength(1);
    expect(await readFile(targets[0].path, 'utf8')).toBe('original sentinel');
    expect(await readFile(xmpSidecarPath(targets[0].path), 'utf8')).toContain(
      'custom:Keep="&#65;"',
    );
    const app = new Elysia().use(jobsRoutes);
    const retry = await app.handle(
      new Request(`http://localhost/api/jobs/${job._id}/retry-failed`, { method: 'POST' }),
    );
    expect(retry.status).toBe(201);
    const retryJob = await jobs.getJob(new ObjectId((await retry.json()).id));
    expect(retryJob?.payload.targets).toEqual([targets[1]]);
    expect(retryJob?.payload.patch).toEqual(patch);
    const view = await (
      await app.handle(new Request(`http://localhost/api/jobs/${job._id}?summary=1`))
    ).json();
    expect(view.payload).toBeUndefined();
    expect(view.checkpoint.applied).toEqual(out.result.applied);
    expect(view.checkpoint.entries).toBeUndefined();
  });

  it('cancels between photos, resumes pending work, and never replays acknowledged photos', async () => {
    if (!mongo) return;
    const targets = [await target('cancel-a'), await target('cancel-b')];
    const job = await claimed(targets);
    const ctx = await context(job._id);
    const report = ctx.reportProgress;
    ctx.reportProgress = async (current, total) => {
      await report(current, total);
      if (current === 1) await jobs.requestCancel(job._id);
    };
    const out = await batchAdjustmentSyncHandler.run(job.payload, ctx);
    expect(out.kind).toBe('cancelled');
    await jobs.markCancelled(job._id, out.result);
    const appliedBytes = await readFile(xmpSidecarPath(targets[0].path), 'utf8');
    const changedAfter = appliedBytes.replace('1.25', '2.75');
    await writeFile(xmpSidecarPath(targets[0].path), changedAfter);
    const response = await new Elysia()
      .use(jobsRoutes)
      .handle(new Request(`http://localhost/api/jobs/${job._id}/resume`, { method: 'POST' }));
    expect(response.status).toBe(200);
    await jobs.claimJob('worker-a', 60000);
    const completed = await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
    expect(completed.result.applied).toEqual(targets.map((t) => t.id));
    expect(await readFile(xmpSidecarPath(targets[0].path), 'utf8')).toBe(changedAfter);
  });

  it('reconciles a crash after atomic rename before acknowledgement without writing twice', async () => {
    if (!mongo) return;
    const photo = await target('crash');
    const job = await claimed([photo]);
    const ctx = await context(job._id);
    const save = ctx.saveCheckpoint!;
    ctx.saveCheckpoint = async (ledger) => {
      if ((ledger.applied as string[]).length > 0) throw new Error('simulated process loss');
      await save(ledger);
    };
    await expect(batchAdjustmentSyncHandler.run(job.payload, ctx)).rejects.toThrow('process loss');
    const before = await stat(xmpSidecarPath(photo.path));
    const ledger = (await jobs.getJob(job._id))?.checkpoint;
    expect(((ledger?.entries ?? []) as { status: string }[])[0].status).toBe('prepared');
    const completed = await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
    expect(completed.result.applied).toEqual([photo.id]);
    expect((await stat(xmpSidecarPath(photo.path))).mtimeMs).toBe(before.mtimeMs);
  });

  it('records an intervening edit as a conflict instead of replaying a prepared write', async () => {
    if (!mongo) return;
    const photo = await target('conflict');
    const job = await claimed([photo]);
    const ctx = await context(job._id);
    const save = ctx.saveCheckpoint!;
    ctx.saveCheckpoint = async (ledger) => {
      await save(ledger);
      if ((ledger.entries as { status?: string }[])[0]?.status === 'prepared')
        throw new Error('process loss');
    };
    await expect(batchAdjustmentSyncHandler.run(job.payload, ctx)).rejects.toThrow();
    const edit = untouched.replace('&#65;', 'new edit');
    await writeFile(xmpSidecarPath(photo.path), edit);
    const completed = await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
    expect(completed.result.applied).toEqual([]);
    expect((completed.result.failed as { reason: string }[])[0].reason).toContain('changed');
    expect(await readFile(xmpSidecarPath(photo.path), 'utf8')).toBe(edit);
  });

  it('fences stale progress, checkpoint and completion after a lease is reclaimed', async () => {
    if (!mongo) return;
    const job = await claimed([await target('fence')]);
    await mongo
      .db(dbName)
      .collection('jobs')
      .updateOne({ _id: job._id }, { $set: { lease_expires_at: '2000-01-01T00:00:00.000Z' } });
    expect((await jobs.claimJob('worker-b', 60000))?._id).toEqual(job._id);
    await expect(jobs.saveJobCheckpoint(job._id, 'worker-a', {}, 60000)).rejects.toThrow('lease');
    await jobs.updateProgress(job._id, { current: 99, total: 99 }, 60000, undefined, 'worker-a');
    await jobs.completeJob(job._id, {}, undefined, 'worker-a');
    await jobs.failJob(job._id, 'stale failure', undefined, 'worker-a');
    expect((await jobs.getJob(job._id))?.status).toBe('running');
    expect((await jobs.getJob(job._id))?.progress.current).toBe(0);
  });

  it('rejects relative paths, unsupported fields and same-stem sidecar collisions before queueing', () => {
    expect(() => parseSyncPayload({ targets: [{ id: 'a', path: 'relative.jpg' }], patch })).toThrow(
      'absolute',
    );
    if (!root) return;
    expect(() =>
      parseSyncPayload({
        targets: [
          { id: 'a', path: join(root, 'same.jpg') },
          { id: 'b', path: join(root, 'same.arw') },
        ],
        patch,
      }),
    ).toThrow('share a sidecar');
  });
});
