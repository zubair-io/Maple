import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import fs from '../fs/mirrored.ts';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { getJob } from '../job-runner/jobs.repo.ts';
import { writeFakePanoCli } from '../job-runner/handlers/pano-fake-cli.test-helpers.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { panoRoutes } from './pano.ts';
import { panoPreviewRoutes } from './pano-preview.ts';

const app = new Elysia().use(fakeAuth()).use(panoRoutes).use(panoPreviewRoutes);
let live: LiveTestDatabase;
let dir: string;
let libraryId: string;
let ambientCli: string | undefined;
const constraints = () => ({
  version: 1,
  canvas: { width: 2047, height: 722 },
  regions: [{ kind: 'include', frame: 1, x: 20, y: 30, width: 40, height: 50 }],
});
const body = () => ({
  assetIds: [new ObjectId().toHexString(), new ObjectId().toHexString()],
  libraryId,
  options: { retention: 'keep', localAlign: 'mesh' },
  seamConstraints: constraints(),
});
function send(method: string, route: string, request?: unknown) {
  return app.handle(
    new Request(`http://localhost/api/pano/${route}`, {
      method,
      ...(request === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          }),
    }),
  );
}
async function configure(seamConstraints = true) {
  const cli = await writeFakePanoCli(dir, { preview: true, seamConstraints });
  expect((await send('PUT', 'config', { maple_cli_path: cli, enabled: true })).status).toBe(200);
}
beforeEach(async () => {
  ambientCli = process.env.MAPLE_PANO_CLI;
  delete process.env.MAPLE_PANO_CLI;
  live = await createLiveTestDatabase();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-seam-routes-'));
  const root = path.join(dir, 'library');
  await fs.mkdir(root);
  libraryId = insertFolder(live.db, { path: root, slug: 'seams' });
  invalidateLibraryRoots();
  await configure();
});
afterEach(async () => {
  if (ambientCli === undefined) delete process.env.MAPLE_PANO_CLI;
  else process.env.MAPLE_PANO_CLI = ambientCli;
  live.close();
  invalidateLibraryRoots();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('versioned top-level seamConstraints', () => {
  for (const route of ['preview', 'stitch']) {
    it(`persists the exact normalized request for ${route}`, async () => {
      const response = await send('POST', route, body());
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      const job = await getJob(new ObjectId(id));
      expect(job?.payload.seamConstraints).toEqual(constraints());
      expect(job?.payload.seamConstraintsSupported).toBe(true);
    });
    const invalids: Array<[string, unknown]> = [
      ['null', null],
      ['version', { ...constraints(), version: 2 }],
      ['extra field', { ...constraints(), extra: true }],
      ['canvas extra', { ...constraints(), canvas: { width: 2047, height: 722, extra: 1 } }],
      ['zero canvas', { ...constraints(), canvas: { width: 0, height: 722 } }],
      ['overflow canvas', { ...constraints(), canvas: { width: 4294967296, height: 722 } }],
      ...[
        { frame: 2 },
        { frame: -1 },
        { frame: 0.5 },
        { x: -1 },
        { x: 2047 },
        { y: 722 },
        { width: 0 },
        { height: 0 },
        { width: 0.5 },
        { width: 4294967296 },
        { kind: 'unknown' },
        { extra: true },
      ].map((patch): [string, unknown] => [
        JSON.stringify(patch),
        {
          ...constraints(),
          regions: [{ ...constraints().regions[0], ...patch }],
        },
      ]),
    ];
    for (const [label, seamConstraints] of invalids) {
      it(`rejects ${label} for ${route} with a named failure`, async () => {
        const response = await send('POST', route, { ...body(), seamConstraints });
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ error: 'invalid_seam_constraints' });
      });
    }
    it(`rejects explicit tile for ${route}`, async () => {
      const request = body();
      const response = await send('POST', route, {
        ...request,
        options: { ...request.options, strategy: 'tile' },
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: 'invalid_seam_constraints' });
    });
    it(`refuses an unsupported binary for ${route}`, async () => {
      await configure(false);
      const response = await send('POST', route, body());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'pano_seam_constraints_unsupported' });
    });
  }
  it('advertises versioned support', async () => {
    expect(await (await send('GET', 'config')).json()).toMatchObject({
      seamConstraintsSupported: true,
    });
    await configure(false);
    expect(await (await send('GET', 'config')).json()).toMatchObject({
      seamConstraintsSupported: false,
    });
  });
  it('rejoins only the same normalized constraints', async () => {
    const request = body();
    const first = await send('POST', 'stitch', request);
    const { id } = (await first.json()) as { id: string };
    const repeated = await send('POST', 'stitch', {
      ...request,
      seamConstraints: {
        regions: request.seamConstraints.regions,
        canvas: { height: 722, width: 2047 },
        version: 1,
      },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ id });
    const changed = constraints();
    changed.regions[0]!.x++;
    const refused = await send('POST', 'stitch', { ...request, seamConstraints: changed });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'pano_job_running' });
    expect((await send('POST', 'stitch', { ...request, seamConstraints: undefined })).status).toBe(
      409,
    );
  });
  it('validates frame indices against the deduplicated union of IDs and resolved paths', async () => {
    const root = path.join(dir, 'library');
    const ids = await Promise.all(
      ['a.dng', 'b.dng', 'c.dng'].map(async (filename) => {
        await fs.writeFile(path.join(root, filename), 'photo');
        const assetId = insertAsset(live.db);
        insertLocation(live.db, { assetId, libraryId, path: '', filename });
        return assetId;
      }),
    );
    const seams = constraints();
    seams.regions[0]!.frame = 2;
    const request = {
      ...body(),
      assetIds: [ids[0]],
      assetPaths: [path.join(root, 'b.dng'), path.join(root, 'c.dng')],
      seamConstraints: seams,
    };
    const response = await send('POST', 'preview', request);
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const job = await getJob(new ObjectId(id));
    expect(job?.payload.assetIds).toEqual([ids[1], ids[2], ids[0]]);
    expect(job?.payload.seamConstraints).toEqual(seams);
    const duplicate = await send('POST', 'preview', {
      ...request,
      assetPaths: [path.join(root, 'a.dng'), path.join(root, 'b.dng')],
    });
    expect(duplicate.status).toBe(422);
    expect(await duplicate.json()).toMatchObject({ error: 'invalid_seam_constraints' });
  });
});
