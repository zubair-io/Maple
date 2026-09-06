/** Real Mongo ledger, child-process encoder and temporary synthetic RAWs. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from '../fs/mirrored.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObjectId } from 'mongodb';
import { getDb, closeDb } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { batchJpegExportHandler } from '../job-runner/handlers/batch-jpeg-export.ts';
import { batchSyncJobRoutes } from '../routes/jobs-batch-sync.ts';
import { batchRecipeExportHandler } from '../job-runner/handlers/batch-recipe-export.ts';
import type { JobHandlerContext } from '../job-runner/handlers/index.ts';
import * as jobs from '../job-runner/jobs.repo.ts';
import { _resetFfiPoolForTests } from '../ffi/ffi-pool.ts';
import { parseExportPayload } from './export-payload.ts';
import type { ExportEntry } from './export-files.ts';

withTestDb(`maple_test_export_recipe_${process.pid}`);
const enabled = !!process.env['MAPLE_EXPORT_FIXTURE'] && !!process.env['MAPLE_MONGO_URI'];
let root = '';
let original: Buffer<ArrayBuffer>;
const xml =
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="1.2"/></rdf:RDF>';
beforeAll(async () => {
  if (!enabled) return;
  original = await readFile(process.env['MAPLE_EXPORT_FIXTURE']!);
  root = await mkdtemp(join(tmpdir(), 'maple-recipe-'));
  await mkdir(join(root, 'exports'));
  registerRoot(root);
  await closeDb();
  await (await getDb()).collection('folders').insertOne({ path: root, slug: 'recipe' });
  invalidateLibraryRoots();
});
beforeEach(async () => {
  if (enabled) await (await getDb()).collection('jobs').deleteMany({});
});
afterAll(async () => {
  _resetFfiPoolForTests();
  await closeDb();
  if (root) {
    unregisterRoot(root);
    await rm(root, { recursive: true, force: true });
  }
  invalidateLibraryRoots();
});
async function target(name: string, index = 0) {
  const path = join(root, `${name}.dng`);
  await writeFile(path, original);
  return { id: `recipe:${name}.dng`, path, xmp: xml, index, capturedAt: null };
}
function payload(targets: Awaited<ReturnType<typeof target>>[], overwritePolicy = 'error') {
  return {
    targets,
    recipe: {
      ...DEFAULT_EXPORT_RECIPE,
      format: 'png',
      quality: null,
      destination: 'directory',
      directory: join(root, 'exports'),
      overwritePolicy,
      namingTemplate: '{original}_{n}.{ext}',
    },
  };
}
async function claimed(value: Record<string, unknown>) {
  const job = await jobs.createJob({
    kind: 'batch_recipe_export',
    payload: value,
  });
  expect((await jobs.claimJob('recipe-worker', 60000))?._id.toHexString()).toBe(
    job._id.toHexString(),
  );
  return job;
}
async function context(jobId: ObjectId): Promise<JobHandlerContext> {
  return {
    jobId,
    checkpoint: (await jobs.getJob(jobId))?.checkpoint,
    saveCheckpoint: (checkpoint) =>
      jobs.saveJobCheckpoint(jobId, 'recipe-worker', checkpoint, 60000),
    reportProgress: (current, total) =>
      jobs.updateProgress(jobId, { current, total }, 60000, undefined, 'recipe-worker'),
    shouldCancel: () => jobs.isCancelRequested(jobId),
  };
}

const integration = enabled ? describe : describe.skip;
integration('persisted developed-image recipe export', () => {
  it('renders with authored adjustments through the real child encoder without changing the original', async () => {
    const photo = await target('actual');
    const job = await claimed(payload([photo]));
    const result = await batchRecipeExportHandler.run(job.payload, await context(job._id));
    expect(result.result.applied).toEqual([photo.id]);
    const output = await readFile(join(root, 'exports', 'actual_1.png'));
    expect(output.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(await readFile(photo.path)).toEqual(original);
    const unedited = await target('unedited');
    unedited.xmp = '';
    await jobs.completeJob(job._id, result.result);
    const next = await claimed(payload([unedited]));
    await batchRecipeExportHandler.run(next.payload, await context(next._id));
    expect(await readFile(join(root, 'exports', 'unedited_1.png'))).not.toEqual(output);
  }, 60000);

  it('reconciles a committed output after process loss without writing it twice', async () => {
    const photo = await target('crash');
    const job = await claimed(payload([photo]));
    const ctx = await context(job._id);
    const save = ctx.saveCheckpoint!;
    ctx.saveCheckpoint = async (ledger) => {
      if ((ledger['applied'] as string[]).length) throw new Error('simulated process loss');
      await save(ledger);
    };
    await expect(batchRecipeExportHandler.run(job.payload, ctx)).rejects.toThrow('process loss');
    const output = join(root, 'exports', 'crash_1.png');
    const before = await stat(output);
    expect(((await jobs.getJob(job._id))!.checkpoint!['entries'] as ExportEntry[])[0].status).toBe(
      'prepared',
    );
    const result = await batchRecipeExportHandler.run(job.payload, await context(job._id));
    expect(result.result.applied).toEqual([photo.id]);
    expect((await stat(output)).mtimeMs).toBe(before.mtimeMs);
  }, 60000);

  it('cancels between photos, resumes the saved selection and honors skip collisions', async () => {
    const photos = [await target('cancel-one'), await target('cancel-two', 7)];
    const job = await claimed(payload(photos, 'skip'));
    const ctx = await context(job._id);
    const save = ctx.saveCheckpoint!;
    ctx.saveCheckpoint = async (ledger) => {
      await save(ledger);
      if ((ledger['applied'] as string[]).length === 1) await jobs.requestCancel(job._id);
    };
    const partial = await batchRecipeExportHandler.run(job.payload, ctx);
    expect(partial.kind).toBe('cancelled');
    await jobs.markCancelled(job._id, partial.result);
    await writeFile(join(root, 'exports', 'cancel-two_8.png'), 'existing output');
    expect(await jobs.resumeBatchJob(job._id)).toBe(true);
    await jobs.claimJob('recipe-worker', 60000);
    const result = await batchRecipeExportHandler.run(job.payload, await context(job._id));
    expect(result.result.skipped).toEqual([photos[1].id]);
    expect(await readFile(join(root, 'exports', 'cancel-two_8.png'), 'utf8')).toBe(
      'existing output',
    );
  }, 60000);

  it('records filename and native decoder failures per photo while continuing', async () => {
    const bad = await target('broken');
    await writeFile(bad.path, 'invalid RAW');
    const good = await target('after-bad', 3);
    const job = await claimed(payload([bad, good]));
    const result = await batchRecipeExportHandler.run(job.payload, await context(job._id));
    expect(result.result.applied).toEqual([good.id]);
    expect((result.result.failed as { id: string; reason: string }[])[0].id).toBe(bad.id);
    expect(await readFile(good.path)).toEqual(original);
  }, 60000);
});
integration('export recovery boundaries', () => {
  it('stops before native rendering when the durable staging checkpoint fails', async () => {
    const photo = await target('checkpoint');
    const job = await claimed(payload([photo]));
    const ctx = await context(job._id);
    const save = ctx.saveCheckpoint!;
    ctx.saveCheckpoint = async (ledger) => {
      if ((ledger['entries'] as (ExportEntry | null)[])[0]?.status === 'rendering')
        throw new Error('checkpoint unavailable');
      await save(ledger);
    };
    await expect(batchRecipeExportHandler.run(job.payload, ctx)).rejects.toThrow(
      'checkpoint unavailable',
    );
    await expect(stat(join(root, 'exports', 'checkpoint_1.png'))).rejects.toThrow();
    expect((await jobs.getJob(job._id))?.checkpoint?.['entries']).toEqual([null]);
  });

  it('protects every selected original from an earlier export using replace', async () => {
    const first = await target('protect');
    const second = await target('alias');
    second.path = join(root, 'protect_1.png');
    await writeFile(second.path, original);
    const value = payload([first, second], 'replace');
    value.recipe.directory = root;
    const job = await claimed(value);
    const result = await batchRecipeExportHandler.run(job.payload, await context(job._id));
    expect((result.result.failed as { reason: string }[])[0].reason).toContain('original');
    expect(await readFile(first.path)).toEqual(original);
    expect(await readFile(second.path)).toEqual(original);
  }, 60000);

  it('retries only failed photos over HTTP with the same XMP and stable sequence', async () => {
    const bad = await target('retry-bad', 11);
    await writeFile(bad.path, 'invalid RAW');
    const good = await target('retry-good', 19);
    const job = await claimed(payload([bad, good]));
    const result = await batchRecipeExportHandler.run(job.payload, await context(job._id));
    await jobs.completeJob(job._id, result.result);
    const requestId = new ObjectId().toHexString();
    const request = () =>
      new Request(`http://localhost/${job._id}/retry-failed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      });
    const response = await batchSyncJobRoutes.handle(request());
    expect(response.status).toBe(201);
    const retry = await jobs.getJob(new ObjectId(requestId));
    expect(retry?.payload.targets).toEqual([bad]);
    expect((await batchSyncJobRoutes.handle(request())).status).toBe(201);
    expect(
      await (await getDb()).collection('jobs').countDocuments({ _id: new ObjectId(requestId) }),
    ).toBe(1);
  }, 60000);

  it('migrates the legacy JPEG job onto an immutable developed-image recipe ledger', async () => {
    const photo = await target('legacy');
    const db = await getDb();
    const library = await db.collection('folders').findOne({ slug: 'recipe' });
    const asset = await db
      .collection('assets')
      .insertOne({ fileinfo: [{ library_id: library!._id, path: '', filename: 'legacy.dng' }] });
    await writeFile(join(root, 'legacy.xmp'), xml);
    const job = await jobs.createJob({
      kind: 'batch_jpeg_export',
      payload: {
        assetIds: [asset.insertedId.toHexString()],
        outputDir: join(root, 'exports'),
        quality: 91,
        maxPx: 32,
      },
    });
    await jobs.claimJob('recipe-worker', 60000);
    const ctx = await context(job._id);
    ctx.shouldCancel = async () => true;
    const stopped = await batchJpegExportHandler.run(job.payload, ctx);
    await jobs.markCancelled(job._id, stopped.result);
    const snapshot = (await jobs.getJob(job._id))?.checkpoint?.['exportPayload'] as {
      targets: { xmp: string }[];
    };
    expect(snapshot.targets[0].xmp).toBe(xml);
    await writeFile(join(root, 'legacy.xmp'), 'later edit must not change this export');
    expect(await jobs.resumeBatchJob(job._id)).toBe(true);
    await jobs.claimJob('recipe-worker', 60000);
    const completed = await batchJpegExportHandler.run(job.payload, await context(job._id));
    expect(completed.result.applied).toEqual([asset.insertedId.toHexString()]);
    expect((await readFile(join(root, 'exports', 'legacy.jpg'))).subarray(0, 2)).toEqual(
      Buffer.from([255, 216]),
    );
    expect(await readFile(photo.path)).toEqual(original);
  }, 60000);
});

describe('recipe boundary validation', () => {
  it('preserves camera wall-clock digits from ISO capture metadata for shared filename rendering', () => {
    const result = parseExportPayload({
      targets: [
        {
          id: 'clock',
          path: join(tmpdir(), 'clock.dng'),
          xmp: '',
          index: 4,
          capturedAt: '2026-07-02T23:58:59+12:00',
        },
      ],
      recipe: {
        ...DEFAULT_EXPORT_RECIPE,
        destination: 'directory',
        directory: tmpdir(),
        overwritePolicy: 'error',
      },
    });
    expect(result.targets[0].capturedAt).toBe('2026:07:02 23:58:59');
  });
  it('rejects unimplemented format, metadata, profile and watermark choices without queuing them', () => {
    for (const patch of [
      { format: 'heic' },
      { metadataPolicy: 'all' },
      { outputProfile: 'adobe-rgb' },
      { watermark: 'copyright' },
      { renderingIntent: 'perceptual' },
    ]) {
      expect(() =>
        parseExportPayload({
          targets: [],
          recipe: { ...DEFAULT_EXPORT_RECIPE, ...patch },
        }),
      ).toThrow();
    }
  });
});
