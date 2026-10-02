/** #1472: real SQLite export jobs and native children reproduce durable removals. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from '../fs/mirrored.ts';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { maple } from 'maple';
import type { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { batchRecipeExportHandler } from '../job-runner/handlers/batch-recipe-export.ts';
import type { JobHandlerContext } from '../job-runner/handlers/index.ts';
import * as jobs from '../job-runner/jobs.repo.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { nativeLibAvailable } from '../ffi/raw_ffi.ts';
import type { ExportEntry } from './export-files.ts';

const fixture = resolve(import.meta.dir, '../../../../test-fixtures/removal/calibration');
describe.skipIf(!nativeLibAvailable())('saved-removal durable export jobs (#1472)', () => {
  let root: string;
  let live: LiveTestDatabase;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'maple-removal-export-')));
    await mkdir(join(root, 'exports'));
    registerRoot(root);
    live = await createLiveTestDatabase();
    insertFolder(live.db, { path: root, slug: 'removal' });
    invalidateLibraryRoots();
  });
  afterEach(async () => {
    live?.close();
    unregisterRoot(root);
    await rm(root, { recursive: true, force: true });
    invalidateLibraryRoots();
  });
  afterAll(() => ffiPool().shutdown());

  async function target(name: string, index = 0) {
    const folder = join(root, name);
    const assets = join(folder, '.maple/inpaint');
    await mkdir(assets, { recursive: true });
    const path = join(folder, `${name}.dng`);
    const sidecar = join(folder, `${name}.xmp`);
    const xmp = await readFile(join(fixture, 'saved.xmp'), 'utf8');
    const [record] = JSON.parse(await readFile(join(fixture, 'records.txt'), 'utf8'));
    const mask = join(assets, `${record.accepted.mask.slice(7)}.mask`);
    const patch = join(assets, `${record.patch.slice(7)}.f16`);
    await copyFile(join(fixture, 'source.dng'), path);
    await writeFile(sidecar, xmp);
    await copyFile(join(fixture, 'mask.mimf'), mask);
    await copyFile(join(fixture, 'patch.f16'), patch);
    return {
      target: { id: `removal:${name}`, path, xmp, index, capturedAt: null },
      sidecar,
      mask,
      patch,
    };
  }

  async function claimed(targets: Awaited<ReturnType<typeof target>>['target'][]) {
    const job = await jobs.createJob({
      kind: 'batch_recipe_export',
      payload: {
        targets,
        recipe: {
          ...DEFAULT_EXPORT_RECIPE,
          format: 'png',
          quality: null,
          destination: 'directory',
          directory: join(root, 'exports'),
          overwritePolicy: 'error',
          namingTemplate: '{original}.{ext}',
        },
      },
    });
    expect((await jobs.claimJob('removal-worker', 60000))?._id.toHexString()).toBe(
      job._id.toHexString(),
    );
    return job;
  }

  async function context(jobId: ObjectId): Promise<JobHandlerContext> {
    return {
      jobId,
      checkpoint: (await jobs.getJob(jobId))?.checkpoint,
      saveCheckpoint: (value) => jobs.saveJobCheckpoint(jobId, 'removal-worker', value, 60000),
      reportProgress: (current, total) =>
        jobs.updateProgress(jobId, { current, total }, 60000, undefined, 'removal-worker'),
      shouldCancel: () => jobs.isCancelRequested(jobId),
    };
  }

  async function assertPixels(name: string) {
    const pixels = await maple(join(root, 'exports', `${name}.png`)).toRaw();
    expect([pixels.width, pixels.height]).toEqual([16, 8]);
    expect(Buffer.from(pixels.data)).toEqual(await readFile(join(fixture, 'preview-64.rgb')));
  }

  async function assertOriginalAndCompanions(photo: Awaited<ReturnType<typeof target>>) {
    expect(await readFile(photo.target.path)).toEqual(await readFile(join(fixture, 'source.dng')));
    expect(await readFile(photo.mask)).toEqual(await readFile(join(fixture, 'mask.mimf')));
    expect(await readFile(photo.patch)).toEqual(await readFile(join(fixture, 'patch.f16')));
  }

  it('exports the queued edit snapshot even after a later sidecar edit', async () => {
    const photo = await target('snapshot');
    const job = await claimed([photo.target]);
    // The snapshot is real persisted job data, not a live sidecar read.
    const later = '<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>';
    await writeFile(photo.sidecar, later);
    const saved = await jobs.getJob(job._id);
    const result = await batchRecipeExportHandler.run(saved!.payload, await context(job._id));
    expect(result.kind).toBe('done');
    expect(result.result.applied).toEqual([photo.target.id]);
    expect(result.result.failed).toEqual([]);
    await assertPixels('snapshot');
    expect(await readFile(photo.sidecar, 'utf8')).toBe(later);
    expect(await readdir(join(root, 'exports'))).toEqual(['snapshot.png']);
    await assertOriginalAndCompanions(photo);
  }, 30_000);

  it('records a missing companion as an item failure and continues with intact saved edits', async () => {
    const bad = await target('missing');
    const good = await target('intact', 1);
    const job = await claimed([bad.target, good.target]);
    await rm(bad.mask);
    const result = await batchRecipeExportHandler.run(job.payload, await context(job._id));
    expect(result.kind).toBe('done');
    expect(result.result.applied).toEqual([good.target.id]);
    expect(result.result.remaining).toEqual([]);
    const failed = result.result.failed as { id: string; reason: string }[];
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(bad.target.id);
    expect(failed[0].reason).toMatch(/saved companion .*\.mask/);
    expect(await readdir(join(root, 'exports'))).toEqual(['intact.png']);
    await assertPixels('intact');
    await assertOriginalAndCompanions(good);
    expect(await readFile(bad.target.path)).toEqual(await readFile(join(fixture, 'source.dng')));
    expect(await readFile(bad.patch)).toEqual(await readFile(join(fixture, 'patch.f16')));
    expect(await readFile(bad.sidecar, 'utf8')).toBe(bad.target.xmp);
    expect(await readFile(good.sidecar, 'utf8')).toBe(good.target.xmp);
  }, 30_000);

  it('reconciles a published removal export after lost acknowledgement without rendering again', async () => {
    const photo = await target('recovery');
    const job = await claimed([photo.target]);
    const ctx = await context(job._id);
    const save = ctx.saveCheckpoint!;
    ctx.saveCheckpoint = async (value) => {
      if ((value['applied'] as string[]).length) throw new Error('simulated lost acknowledgement');
      await save(value);
    };
    await expect(batchRecipeExportHandler.run(job.payload, ctx)).rejects.toThrow(
      'lost acknowledgement',
    );
    const output = join(root, 'exports', 'recovery.png');
    const before = await stat(output);
    expect(((await jobs.getJob(job._id))!.checkpoint!['entries'] as ExportEntry[])[0].status).toBe(
      'prepared',
    );
    // Losing the model/companion after publication cannot change the bytes
    // already committed. A second RAW render would now fail this recovery.
    await rm(photo.mask);
    const result = await batchRecipeExportHandler.run(job.payload, await context(job._id));
    expect(result.result.applied).toEqual([photo.target.id]);
    expect(result.result.failed).toEqual([]);
    expect((await stat(output)).mtimeMs).toBe(before.mtimeMs);
    await assertPixels('recovery');
    expect(await readdir(join(root, 'exports'))).toEqual(['recovery.png']);
    expect(await readFile(photo.target.path)).toEqual(await readFile(join(fixture, 'source.dng')));
    expect(await readFile(photo.patch)).toEqual(await readFile(join(fixture, 'patch.f16')));
    expect(await readFile(photo.sidecar, 'utf8')).toBe(photo.target.xmp);
  }, 30_000);
});
