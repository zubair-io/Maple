/** Real HTTP, SQLite and native exports; all originals are disposable synthetic copies (#4111). */
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { symlink } from 'node:fs/promises';
import { setSqliteHandleForTests } from '../db/sqlite/index.ts';
import { parseExportPayload } from './export-payload.ts';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from '../fs/mirrored.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  testSqliteDb,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { registerRoot, unregisterRoot } from '../fs/root.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { createJobsRoutes } from '../routes/jobs.ts';
import { ObjectId } from '../db/object-id.ts';
import * as jobs from '../job-runner/jobs.repo.ts';
import { batchRecipeExportHandler } from '../job-runner/handlers/batch-recipe-export.ts';
import { _resetFfiPoolForTests, ffiPool } from '../ffi/ffi-pool.ts';
import type { JobHandlerContext } from '../job-runner/handlers/index.ts';

let live: LiveTestDatabase;
let root = '';
let original: Buffer<ArrayBuffer>;
let reopened: Database | undefined;
let api: ReturnType<typeof createJobsRoutes>;
const xml =
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="1.2"/></rdf:RDF>';
beforeAll(async () => {
  if (!ffiPool().available()) throw Error('Actual native export library is required');
  original = await readFile(
    resolve(import.meta.dir, '../../../../test-fixtures/batch-transfer/source.dng'),
  );
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-4111-')));
  await mkdir(join(root, 'exports'));
  registerRoot(root);
  live = await createLiveTestDatabase('file');
  insertFolder(live.db, { path: root, slug: 'retry-originals' });
  invalidateLibraryRoots();
  api = createJobsRoutes().listen({ hostname: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await api?.stop();
  _resetFfiPoolForTests();
  reopened?.close();
  live?.close();
  if (root) {
    unregisterRoot(root);
    await rm(root, { recursive: true, force: true });
  }
  invalidateLibraryRoots();
});
async function post(path: string, value: unknown): Promise<{ id: string }> {
  const response = await fetch(`http://127.0.0.1:${api.server!.port}/api/jobs${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}
async function run(id: string) {
  expect((await jobs.claimJob('retry-original-worker', 60000))?._id.toHexString()).toBe(id);
  const job = (await jobs.getJob(new ObjectId(id)))!;
  const ctx: JobHandlerContext = {
    jobId: job._id,
    checkpoint: job.checkpoint,
    saveCheckpoint: (value) =>
      jobs.saveJobCheckpoint(job._id, 'retry-original-worker', value, 60000),
    reportProgress: (current, total) =>
      jobs.updateProgress(job._id, { current, total }, 60000, undefined, 'retry-original-worker'),
    shouldCancel: () => jobs.isCancelRequested(job._id),
  };
  const result = await batchRecipeExportHandler.run(job.payload, ctx);
  await jobs.completeJob(job._id, result.result);
  return { job, result: result.result };
}
it('keeps the initially successful photo protected when only the failed photo retries', async () => {
  const a = {
    id: 'retry-originals:a.dng',
    path: join(root, 'a.dng'),
    xmp: xml,
    index: 0,
    capturedAt: null,
  };
  const b = {
    id: 'retry-originals:a_1.png',
    path: join(root, 'exports', 'a_1.png'),
    xmp: xml,
    index: 1,
    capturedAt: null,
  };
  await writeFile(a.path, original);
  await writeFile(b.path, original);
  const created = await post('', {
    kind: 'batch_recipe_export',
    payload: {
      targets: [a, b],
      recipe: {
        ...DEFAULT_EXPORT_RECIPE,
        format: 'png',
        quality: null,
        destination: 'directory',
        directory: join(root, 'exports'),
        overwritePolicy: 'replace',
        namingTemplate: '{original}_{n}.{ext}',
      },
    },
  });
  const first = await run(created.id);
  expect(first.result.applied).toEqual([b.id]);
  expect(first.result.failed).toEqual([
    expect.objectContaining({
      id: a.id,
      reason: expect.stringContaining('original'),
    }),
  ]);
  expect(await readFile(b.path)).toEqual(original);
  const retried = await post(`/${created.id}/retry-failed`, {
    requestId: new ObjectId().toHexString(),
  });
  const second = await run(retried.id);
  expect(second.job.payload.targets).toEqual([a]);
  const after = await readFile(b.path);
  console.log(
    JSON.stringify({
      baselineCommit: '404a6dd36be027a526528293556251fd5d8306a5',
      first: first.result,
      retry: second.result,
      beforeSHA256: createHash('sha256').update(original).digest('hex'),
      afterSHA256: createHash('sha256').update(after).digest('hex'),
      originalChanged: !after.equals(original),
    }),
  );
  if (!after.equals(original)) {
    await writeFile('/tmp/maple-4111-counterexample-before.dng', original);
    await writeFile('/tmp/maple-4111-counterexample-after.png', after);
  }
  expect(after.equals(original)).toBe(true);
  expect(second.job.payload.originalPaths).toEqual([a.path, b.path]);
  // Discard an accepted retry's response, restart the actual HTTP/SQLite handles,
  // and repeat its request identity; this must recover one durable child job.
  const requestId = new ObjectId().toHexString();
  await fetch(`http://127.0.0.1:${api.server!.port}/api/jobs/${retried.id}/retry-failed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
  }).then(async (response) => {
    expect(response.status).toBe(201);
    await response.arrayBuffer();
  });
  await api.stop();
  live.db.close();
  reopened = new Database(live.path);
  setSqliteHandleForTests(testSqliteDb(reopened));
  invalidateLibraryRoots();
  api = createJobsRoutes().listen({ hostname: '127.0.0.1', port: 0 });
  expect(await post(`/${retried.id}/retry-failed`, { requestId })).toEqual({
    id: requestId,
  });
  expect(await post(`/${retried.id}/retry-failed`, { requestId })).toEqual({
    id: requestId,
  });
  const third = await run(requestId);
  expect(third.job.payload.originalPaths).toEqual([a.path, b.path]);
  expect(third.job.payload.targets).toEqual([a]);
  expect(third.result.failed).toEqual([
    expect.objectContaining({
      id: a.id,
      reason: expect.stringContaining('original'),
    }),
  ]);
  expect((await readFile(a.path)).equals(original)).toBe(true);
  expect((await readFile(b.path)).equals(original)).toBe(true);
  expect(reopened.query('SELECT COUNT(*) AS n FROM jobs WHERE id = ?').get(requestId)).toEqual({
    n: 1,
  });
}, 60000);

function recipe(directory = join(root, 'exports')) {
  return {
    ...DEFAULT_EXPORT_RECIPE,
    format: 'png',
    quality: null,
    destination: 'directory',
    directory,
    overwritePolicy: 'replace',
    namingTemplate: '{original}_{n}.{ext}',
  };
}
async function photo(name: string, index = 0) {
  const path = join(root, `${name}.dng`);
  await writeFile(path, original);
  return {
    id: `retry-originals:${name}.dng`,
    path,
    xmp: xml,
    index,
    capturedAt: null,
  };
}
it('captures trusted initial identities even when the client submits an empty identity list', async () => {
  const a = await photo('trusted');
  const created = await post('', {
    kind: 'batch_recipe_export',
    payload: { targets: [a], originalPaths: [], recipe: recipe() },
  });
  const result = await run(created.id);
  expect(result.job.payload.originalPaths).toEqual([a.path]);
  expect(result.result.applied).toEqual([a.id]);
  expect((await readFile(a.path)).equals(original)).toBe(true);
}, 60000);
it('allows retry to replace unrelated outputs with the captured XMP and fixed sequence', async () => {
  const a = await photo('unrelated', 11);
  await writeFile(a.path, 'not a RAW');
  await writeFile(join(root, 'exports', 'unrelated_12.png'), 'previous unrelated output');
  const created = await post('', {
    kind: 'batch_recipe_export',
    payload: { targets: [a], recipe: recipe() },
  });
  expect((await run(created.id)).result.failed).toHaveLength(1);
  await writeFile(a.path, original); // Repair only this deliberately invalid disposable fixture.
  const retry = await post(`/${created.id}/retry-failed`, {
    requestId: new ObjectId().toHexString(),
  });
  const result = await run(retry.id);
  expect(result.job.payload.targets).toEqual([a]);
  expect(result.result.applied).toEqual([a.id]);
  expect(result.result.outputs).toEqual([
    { id: a.id, path: join(root, 'exports', 'unrelated_12.png') },
  ]);
  expect((await readFile(a.path)).equals(original)).toBe(true);
}, 60000);
it('keeps canonical original aliases protected after filtering the retry', async () => {
  const a = await photo('alias-a');
  const b = await photo('alias-b', 1);
  await symlink(b.path, join(root, 'exports', 'alias-a_1.png'));
  const created = await post('', {
    kind: 'batch_recipe_export',
    payload: { targets: [a, b], recipe: recipe() },
  });
  expect((await run(created.id)).result.failed).toEqual([
    expect.objectContaining({
      id: a.id,
      reason: expect.stringContaining('original'),
    }),
  ]);
  const retry = await post(`/${created.id}/retry-failed`, {
    requestId: new ObjectId().toHexString(),
  });
  expect((await run(retry.id)).result.failed).toEqual([
    expect.objectContaining({
      id: a.id,
      reason: expect.stringContaining('original'),
    }),
  ]);
  expect((await readFile(b.path)).equals(original)).toBe(true);
}, 60000);
it('refuses legacy replacement with missing complete identities but permits a new destination', async () => {
  const a = await photo('legacy-unknown');
  const destination = join(root, 'exports', 'legacy-unknown_1.png');
  await writeFile(destination, 'untracked original or output');
  const value = { targets: [a], recipe: recipe() };
  const legacy = await jobs.createJob({
    kind: 'batch_recipe_export',
    payload: value,
  });
  const first = await run(legacy._id.toHexString());
  expect(first.result.failed).toEqual([
    expect.objectContaining({
      reason: expect.stringContaining('Original identity unavailable'),
    }),
  ]);
  const retry = await post(`/${legacy._id}/retry-failed`, {
    requestId: new ObjectId().toHexString(),
  });
  const second = await run(retry.id);
  expect(second.job.payload.originalPaths).toBeUndefined();
  expect(second.result.failed).toHaveLength(1);
  expect(await readFile(destination, 'utf8')).toBe('untracked original or output');
  const fresh = await photo('legacy-new');
  const job = await jobs.createJob({
    kind: 'batch_recipe_export',
    payload: { targets: [fresh], recipe: recipe() },
  });
  expect((await run(job._id.toHexString())).result.applied).toEqual([fresh.id]);
}, 60000);
it('bounds retained identities in the complete payload and rejects missing selected identities', async () => {
  const a = await photo('payload-size');
  const value = {
    targets: [{ ...a, xmp: 'x'.repeat(11_998_000) }],
    recipe: recipe(),
  };
  expect(() => parseExportPayload({ ...value, originalPaths: [a.path] })).not.toThrow();
  expect(() =>
    parseExportPayload({
      ...value,
      originalPaths: [a.path, '/' + 'x'.repeat(8190)],
    }),
  ).toThrow('too many edit snapshots');
  expect(() =>
    parseExportPayload({
      ...value,
      originalPaths: [join(root, 'another.dng')],
    }),
  ).toThrow('every selected photo');
});

it('does not trust originalPaths persisted by the legacy raw-body create route', async () => {
  const a = await photo('legacy-forged');
  const b = join(root, 'exports', 'legacy-forged_1.png');
  await writeFile(b, original);
  const payload = { targets: [a], originalPaths: [a.path], recipe: recipe() };
  // Exact pre-upgrade order: validate normalized data, then persist the raw request.
  parseExportPayload(payload);
  const legacy = await jobs.createJob({ kind: 'batch_recipe_export', payload });
  expect((await run(legacy._id.toHexString())).result.failed).toEqual([
    expect.objectContaining({
      reason: expect.stringContaining('Original identity unavailable'),
    }),
  ]);
  const retried = await post(`/${legacy._id}/retry-failed`, {
    requestId: new ObjectId().toHexString(),
  });
  expect((await run(retried.id)).result.failed).toHaveLength(1);
  expect((await readFile(b)).equals(original)).toBe(true);
}, 60000);
it('ignores a forged top-level checkpoint on HTTP creation', async () => {
  const a = await photo('http-forged');
  const created = await post('', {
    kind: 'batch_recipe_export',
    payload: { targets: [a], recipe: recipe() },
    checkpoint: { originalPaths: [] },
  });
  const result = await run(created.id);
  expect(result.job.checkpoint?.['originalPaths']).toEqual([a.path]);
  expect(result.result.applied).toEqual([a.id]);
});
it('authorizes retained original paths before querying them on retry', async () => {
  const a = await photo('authorization');
  const outside = join(tmpdir(), `unregistered-${new ObjectId()}.dng`);
  const payload = {
    targets: [a],
    originalPaths: [a.path, outside],
    recipe: recipe(),
  };
  const job = await jobs.createJob({
    kind: 'batch_recipe_export',
    payload,
    checkpoint: { originalPaths: payload.originalPaths },
  });
  await expect(run(job._id.toHexString())).rejects.toThrow();
  await jobs.failJob(job._id, 'Unauthorized retained original');
  expect((await readFile(a.path)).equals(original)).toBe(true);
});

it('never writes or reuses an existing restored legacy staging file without complete identities', async () => {
  const a = await photo('legacy-stage');
  const requestId = new ObjectId().toHexString();
  const tempPath = join(
    root,
    'exports',
    `.maple-export-${requestId}-00000000-0000-0000-0000-000000000000.tmp`,
  );
  await writeFile(tempPath, original);
  const outputPath = join(root, 'exports', 'legacy-stage_1.png');
  const job = await jobs.createJob({
    kind: 'batch_recipe_export',
    requestId,
    payload: { targets: [a], recipe: recipe() },
    checkpoint: {
      entries: [
        {
          id: a.id,
          status: 'prepared',
          tempPath,
          outputPath,
          beforeHash: null,
          afterHash: createHash('sha256').update(original).digest('hex'),
        },
      ],
    },
  });
  expect((await run(job._id.toHexString())).result.failed).toEqual([
    expect.objectContaining({
      reason: expect.stringContaining('Original identity unavailable'),
    }),
  ]);
  expect((await readFile(tempPath)).equals(original)).toBe(true);
  expect(await Bun.file(outputPath).exists()).toBe(false);
  expect((await readFile(a.path)).equals(original)).toBe(true);
});
