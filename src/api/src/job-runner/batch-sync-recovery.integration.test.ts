/**
 * What a settings batch does when something interrupts it: a change-feed write
 * that fails, a sidecar edited out from under a prepared entry, an
 * acknowledgement that never lands, a lease taken by another worker.
 *
 * Split out of `batch-sync.integration.test.ts` during the SQLite cutover
 * (#3787) because the two sets of cases together no longer fit inside one
 * file's line budget. Same shape as that file: real temporary sidecars, a
 * SQLite database per test, and the shared temporary library root registered
 * once. The fixture helpers are repeated here rather than imported from it —
 * importing a test module would register its cases a second time in this file's
 * run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from '../fs/mirrored.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import type { ObjectId } from 'mongodb';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { batchAdjustmentSyncHandler } from './handlers/batch-adjustment-sync.ts';
import type { JobHandlerContext } from './handlers/index.ts';
import * as jobs from './jobs.repo.ts';
import { jobsRoutes } from '../routes/jobs.ts';
import { __resetChangeBusForTests } from '../runtime/change-bus.ts';

let root = '';
const patch = { attributes: { 'crs:Exposure2012': '1.25' }, elements: {} };
const untouched =
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:custom="urn:custom" custom:Keep="&#65;"/></rdf:RDF>';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'maple-batch-recovery-'));
  registerRoot(root);
});
beforeEach(() => {
  __resetChangeBusForTests();
});
afterEach(() => {
  // The cache is process-wide and this test's database is about to close, so
  // the next case must not be served a map built from a disposed handle.
  invalidateLibraryRoots();
});
afterAll(async () => {
  __resetChangeBusForTests();
  if (root) {
    unregisterRoot(root);
    await rm(root, { recursive: true, force: true });
  }
  invalidateLibraryRoots();
});

/** Register the shared temporary root as a library of this test's database. */
function seedLibrary(db: Database): string {
  const id = insertFolder(db, { path: root, slug: 'batch' });
  invalidateLibraryRoots();
  return id;
}

/** The single number a `SELECT … AS n` query answers, or -1 for no row. */
function scalar(db: Database, sql: string, ...params: string[]): number {
  return (db.query(sql).get(...params) as { n: number } | null)?.n ?? -1;
}

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
    saveCheckpoint: (value, entryIndex) =>
      jobs.saveJobCheckpoint(jobId, worker, value, 60000, undefined, entryIndex),
    reportProgress: (current, total) =>
      jobs.updateProgress(jobId, { current, total }, 60000, undefined, worker),
    shouldCancel: () => jobs.isCancelRequested(jobId),
  };
}
async function claimed(targets: Awaited<ReturnType<typeof target>>[]) {
  const job = await jobs.createJob({
    kind: 'batch_adjustment_sync',
    payload: { targets, patch },
  });
  expect((await jobs.claimJob('worker-a', 60000))?._id.toHexString()).toBe(job._id.toHexString());
  return job;
}

describe('interrupted batch adjustment sync', () => {
  it('recovers a real change-feed failure without rewriting an already committed sidecar', async () => {
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
    const photo = await target('notification-recovery');
    const job = await claimed([photo]);
    // The stand-in for Mongo's `collMod` document validator: a rule the table
    // itself enforces, which refuses the insert without the caller being able
    // to see it coming, and which is lifted again in the `finally`.
    run(
      live.db,
      `CREATE TRIGGER refuse_change BEFORE INSERT ON asset_changes
       BEGIN SELECT RAISE(ABORT, 'change feed unavailable'); END`,
    );
    try {
      await expect(
        batchAdjustmentSyncHandler.run(job.payload, await context(job._id)),
      ).rejects.toThrow();
      const ledger = (await jobs.getJob(job._id))?.checkpoint?.entries as { status: string }[];
      expect(ledger[0].status).toBe('prepared');
      expect(await readFile(xmpSidecarPath(photo.path), 'utf8')).toContain(
        'crs:Exposure2012="1.25"',
      );
    } finally {
      run(live.db, 'DROP TRIGGER refuse_change');
    }
    const written = await stat(xmpSidecarPath(photo.path));
    const out = await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
    expect(out.result.applied).toEqual([photo.id]);
    expect((await stat(xmpSidecarPath(photo.path))).mtimeMs).toBe(written.mtimeMs);
    expect(
      scalar(live.db, 'SELECT COUNT(*) AS n FROM asset_changes WHERE abs_path = ?', photo.path),
    ).toBe(1);
  });

  it('detects a new sidecar created after preparation and leaves its bytes untouched', async () => {
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
    const photo = await target('new-sidecar-race');
    await rm(xmpSidecarPath(photo.path));
    const job = await claimed([photo]);
    const ctx = await context(job._id);
    const save = ctx.saveCheckpoint!;
    ctx.saveCheckpoint = async (ledger) => {
      await save(ledger);
      if ((ledger.entries as { status?: string }[])[0]?.status === 'prepared')
        await writeFile(xmpSidecarPath(photo.path), untouched);
    };
    const out = await batchAdjustmentSyncHandler.run(job.payload, ctx);
    expect(out.result.applied).toEqual([]);
    expect((out.result.failed as { reason: string }[])[0].reason).toContain('changed');
    expect(await readFile(xmpSidecarPath(photo.path), 'utf8')).toBe(untouched);
  });

  it('cancels between photos, resumes pending work, and never replays acknowledged photos', async () => {
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
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
    const response = await new Elysia().use(jobsRoutes).handle(
      new Request(`http://localhost/api/jobs/${job._id}/resume`, {
        method: 'POST',
      }),
    );
    expect(response.status).toBe(200);
    await jobs.claimJob('worker-a', 60000);
    const completed = await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
    expect(completed.result.applied).toEqual(targets.map((t) => t.id));
    expect(await readFile(xmpSidecarPath(targets[0].path), 'utf8')).toBe(changedAfter);
  });

  it('reconciles a crash after atomic rename before acknowledgement without writing twice', async () => {
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
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
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
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
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
    const job = await claimed([await target('fence')]);
    run(
      live.db,
      'UPDATE jobs SET lease_expires_at = ? WHERE id = ?',
      '2000-01-01T00:00:00.000Z',
      job._id.toHexString(),
    );
    expect((await jobs.claimJob('worker-b', 60000))?._id).toEqual(job._id);
    await expect(jobs.saveJobCheckpoint(job._id, 'worker-a', {}, 60000)).rejects.toThrow('lease');
    await expect(
      jobs.updateProgress(job._id, { current: 99, total: 99 }, 60000, undefined, 'worker-a'),
    ).rejects.toThrow('lease');
    await jobs.completeJob(job._id, {}, undefined, 'worker-a');
    await jobs.failJob(job._id, 'stale failure', undefined, 'worker-a');
    expect((await jobs.getJob(job._id))?.status).toBe('running');
    expect((await jobs.getJob(job._id))?.progress.current).toBe(0);
  });
});
