/**
 * Real temporary sidecars plus a real database. Every case drives the batch
 * handler or the HTTP route end to end against its own SQLite database (#3787).
 *
 * The temporary library root is shared across cases — it is filesystem setup,
 * not state — while the `folders` row that makes it a registered library is
 * seeded per test, because each test owns its database. `seedLibrary` does both
 * halves: the row, and the invalidation the process-wide library cache needs to
 * notice it.
 *
 * The active-batch fence no longer has an index behind it. "Only one settings
 * batch per library" is a `WHERE NOT EXISTS` inside the insert, so there is
 * nothing to create in setup and a conflict arrives as a thrown
 * `JobConflictError` that the route still turns into a 409.
 *
 * The interruption cases — a failed change-feed write, a sidecar edited from
 * under a prepared entry, a lost acknowledgement, a reclaimed lease — live in
 * `batch-sync-recovery.integration.test.ts`, because the two sets together do
 * not fit inside one file's line budget. The fixture helpers below are repeated
 * there rather than shared, so that neither file's tests are registered twice by
 * importing the other.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from '../fs/mirrored.ts';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { listChangesSince } from '../db/sqlite/repos/changes.repo.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { batchAdjustmentSyncHandler, parseSyncPayload } from './handlers/batch-adjustment-sync.ts';
import type { JobHandlerContext } from './handlers/index.ts';
import * as jobs from './jobs.repo.ts';
import { jobsRoutes } from '../routes/jobs.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { getChangeBus, __resetChangeBusForTests } from '../runtime/change-bus.ts';

let root = '';
const patch = { attributes: { 'crs:Exposure2012': '1.25' }, elements: {} };
const untouched =
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:custom="urn:custom" custom:Keep="&#65;"/></rdf:RDF>';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'maple-batch-sync-'));
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
  await ffiPool().shutdown();
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

describe('persisted batch adjustment sync', () => {
  it('publishes the edited copy and bumps its shared asset version without editing its primary copy', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    await mkdir(join(root, 'copies'), { recursive: true });
    const primary = await target('primary-copy');
    const photo = await target('copies/selected');
    const primaryXml = await readFile(xmpSidecarPath(primary.path), 'utf8');
    const assetId = new ObjectId().toHexString();
    insertAsset(live.db, { id: assetId });
    run(live.db, 'UPDATE assets SET sidecar_ver = 7 WHERE id = ?', assetId);
    // The two former fileinfo[] entries, one row each, in array order.
    insertLocation(live.db, {
      assetId,
      libraryId,
      ordinal: 0,
      path: '',
      filename: 'primary-copy.jpg',
    });
    insertLocation(live.db, {
      assetId,
      libraryId,
      ordinal: 1,
      path: 'copies',
      filename: 'selected.jpg',
    });
    const job = await claimed([photo]);
    const out = await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
    expect(out.result.applied).toEqual([photo.id]);
    expect(await readFile(xmpSidecarPath(primary.path), 'utf8')).toBe(primaryXml);
    expect(scalar(live.db, 'SELECT sidecar_ver AS n FROM assets WHERE id = ?', assetId)).toBe(8);
    expect(scalar(live.db, 'SELECT has_xmp AS n FROM assets WHERE id = ?', assetId)).toBe(1);
    const rows = await listChangesSince(undefined, { since: 0, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].asset_id?.toHexString()).toBe(assetId);
    expect(rows[0].abs_path).toBe(photo.path);
    expect(rows[0].relative_path).toBe('copies/selected.jpg');
    expect(rows[0].folder_id?.toHexString()).toBe(libraryId);
    expect(getChangeBus().snapshot()).toEqual(rows);
    const again = await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
    expect(again.result.applied).toEqual([photo.id]);
    expect(scalar(live.db, 'SELECT sidecar_ver AS n FROM assets WHERE id = ?', assetId)).toBe(8);
  });

  it('resolves an id without a slug delimiter from the longest matching library root', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    const misleadingId = insertFolder(live.db, { path: dirname(root), slug: 'plain-photo.jp' });
    invalidateLibraryRoots();
    const photo = await target('plain-photo');
    photo.id = 'plain-photo.jpg';
    const job = await claimed([photo]);
    await batchAdjustmentSyncHandler.run(job.payload, await context(job._id));
    const rows = await listChangesSince(undefined, { since: 0, limit: 10 });
    expect(rows[0]?.abs_path).toBe(photo.path);
    expect(rows[0]?.folder_id?.toHexString()).toBe(libraryId);
    expect(rows[0]?.folder_id?.toHexString()).not.toBe(misleadingId);
  });

  it('rejects legacy or unversioned relative white balance before queueing', async () => {
    using live = await createLiveTestDatabase();
    const photo = await target('legacy-wb');
    const app = new Elysia().use(jobsRoutes);
    for (const version of [undefined, '4']) {
      const response = await app.handle(
        new Request('http://localhost/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'batch_adjustment_sync',
            payload: {
              targets: [photo],
              relativeWhiteBalance: { temperature: 100, tint: -0.5 },
              patch: {
                attributes: {
                  'crs:WhiteBalance': 'Custom',
                  ...(version ? { 'papp:WbScaleVersion': version } : {}),
                },
                elements: {},
              },
            },
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('current-scale');
    }
    expect(scalar(live.db, 'SELECT COUNT(*) AS n FROM jobs')).toBe(0);
    expect(await readFile(xmpSidecarPath(photo.path), 'utf8')).toBe(untouched);
  });

  it('refuses a concurrent batch in the same library, including a second client', async () => {
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
    const first = await claimed([await target('owner')]);
    const app = new Elysia().use(jobsRoutes);
    const request = () =>
      new Request('http://localhost/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'batch_adjustment_sync',
          payload: {
            targets: [{ id: 'batch:second.jpg', path: join(root, 'second.jpg') }],
            patch,
          },
        }),
      });
    const blocked = await app.handle(request());
    expect(blocked.status).toBe(409);
    await jobs.markCancelled(first._id, {
      applied: [],
      failed: [],
      remaining: [],
    });
    expect((await app.handle(request())).status).toBe(201);
  });

  it('reads actual paired RAW baselines through HTTP and writes a frozen relative patch', async () => {
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
    const sourcePath = join(root, 'paired-source.dng');
    const targetPath = join(root, 'paired-target.dng');
    const sourceBytes = await readFile(
      new URL('../../../../test-fixtures/batch-transfer/source.dng', import.meta.url),
    );
    const targetBytes = await readFile(
      new URL('../../../../test-fixtures/batch-transfer/target.dng', import.meta.url),
    );
    await writeFile(sourcePath, sourceBytes);
    await writeFile(targetPath, targetBytes);
    await writeFile(xmpSidecarPath(targetPath), untouched);
    const app = new Elysia().use(jobsRoutes);
    const baseline = async (path: string) => {
      const result = await app.handle(
        new Request(`http://localhost/api/jobs/batch-baseline?path=${encodeURIComponent(path)}`),
      );
      expect(result.status).toBe(200);
      return result.json();
    };
    expect(await baseline(sourcePath)).toEqual({ temperature: 7350, tint: 14 });
    expect(await baseline(targetPath)).toEqual({ temperature: 5050, tint: 38 });
    const payload = {
      targets: [{ id: 'batch:paired-target.dng', path: targetPath }],
      patch: {
        attributes: {
          'crs:WhiteBalance': 'Custom',
          'crs:Temperature': '8550',
          'crs:Tint': '24',
          'papp:WbScaleVersion': '5',
        },
        elements: {},
      },
      relativeWhiteBalance: { temperature: 1200, tint: 10 },
    };
    const job = await jobs.createJob({
      kind: 'batch_adjustment_sync',
      payload,
    });
    await jobs.claimJob('worker-a', 60000);
    const ctx = await context(job._id);
    const save = ctx.saveCheckpoint!;
    ctx.saveCheckpoint = async (ledger) => {
      if ((ledger.applied as string[]).length) throw new Error('lost acknowledgement');
      await save(ledger);
    };
    await expect(batchAdjustmentSyncHandler.run(payload, ctx)).rejects.toThrow(
      'lost acknowledgement',
    );
    const written = await readFile(xmpSidecarPath(targetPath), 'utf8');
    expect(written).toContain('crs:Temperature="6250"');
    expect(written).toContain('crs:Tint="48"');
    expect(written).toContain('custom:Keep="&#65;"');
    const before = await stat(xmpSidecarPath(targetPath));
    const ledger = (await jobs.getJob(job._id))!.checkpoint!.entries as {
      patch: { attributes: Record<string, string> };
    }[];
    expect(ledger[0].patch.attributes['crs:Temperature']).toBe('6250');
    const replay = await batchAdjustmentSyncHandler.run(payload, await context(job._id));
    expect(replay.result.applied).toEqual(['batch:paired-target.dng']);
    expect((await stat(xmpSidecarPath(targetPath))).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
    expect(await readFile(targetPath)).toEqual(targetBytes);
  });

  it('reuses a client-generated job identity after a lost creation response', async () => {
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
    const payload = { targets: [await target('request-id')], patch };
    const requestId = new ObjectId().toHexString();
    const one = await jobs.createJob({
      kind: 'batch_adjustment_sync',
      payload,
      requestId,
    });
    const two = await jobs.createJob({
      kind: 'batch_adjustment_sync',
      payload,
      requestId,
    });
    expect(two._id).toEqual(one._id);
    expect(
      scalar(live.db, 'SELECT COUNT(*) AS n FROM jobs WHERE id = ?', one._id.toHexString()),
    ).toBe(1);
    await expect(
      jobs.createJob({
        kind: 'batch_adjustment_sync',
        payload: {
          ...payload,
          patch: { attributes: { 'crs:Exposure2012': '2' }, elements: {} },
        },
        requestId,
      }),
    ).rejects.toThrow('different job');
  });

  it('returns 409 for conflicting create and retry identities without changing either job', async () => {
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
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
    expect(scalar(live.db, 'SELECT COUNT(*) AS n FROM jobs')).toBe(2);
  });

  it.skipIf(process.env.MAPLE_BATCH_BENCHMARK !== '1')(
    'measures a 2,000-sidecar run when MAPLE_BATCH_BENCHMARK=1',
    async () => {
      if (process.env.MAPLE_BATCH_BENCHMARK !== '1') return;
      using live = await createLiveTestDatabase();
      seedLibrary(live.db);
      const targets = [];
      for (let i = 0; i < 2000; i++) targets.push(await target(`bench-${i}`));
      const job = await claimed(targets);
      const baseline = process.memoryUsage().rss;
      let peak = baseline;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 50);
      const started = performance.now();
      const ctx = await context(job._id);
      const report = ctx.reportProgress;
      ctx.reportProgress = async (current, total) => {
        await report(current, total);
        if (current % 250 === 0)
          console.log(
            JSON.stringify({
              processed: current,
              total,
              elapsedMs: Math.round(performance.now() - started),
            }),
          );
      };
      try {
        const out = await batchAdjustmentSyncHandler.run(job.payload, ctx);
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
    },
    600000,
  );

  it('continues after a malformed sidecar and retries only failed photos through HTTP', async () => {
    using live = await createLiveTestDatabase();
    seedLibrary(live.db);
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
      new Request(`http://localhost/api/jobs/${job._id}/retry-failed`, {
        method: 'POST',
      }),
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
