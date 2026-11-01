/**
 * Quick panorama preview routes (#4580): creating and superseding preview
 * jobs, serving the image, the older-binary degradation, and a stitch that
 * names a finished preview in `alignmentFrom`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { getJob } from '../job-runner/jobs.repo.ts';
import {
  TINY_PNG_B64,
  writeFakePanoCli,
} from '../job-runner/handlers/pano-fake-cli.test-helpers.ts';
import { newPreviewDir, PREVIEW_FILES } from '../pano/pano-previews.ts';
import { panoPreviewRoutes } from './pano-preview.ts';
import { panoRoutes } from './pano.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

const app = new Elysia().use(fakeAuth()).use(panoRoutes).use(panoPreviewRoutes);

let live: LiveTestDatabase;
let tmpDir = '';
let previewCli = '';
let legacyCli = '';
let edgesCli = '';
let folderId = '';

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-preview-routes-'));
  previewCli = await writeFakePanoCli(tmpDir, { preview: true });
  legacyCli = await writeFakePanoCli(tmpDir, { preview: false });
  edgesCli = await writeFakePanoCli(tmpDir, { preview: true, edges: true });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let ambientPanoCli: string | undefined;

beforeEach(async () => {
  // An image that bundles maple-cli exports MAPLE_PANO_CLI; these tests assume no bundled binary.
  ambientPanoCli = process.env.MAPLE_PANO_CLI;
  delete process.env.MAPLE_PANO_CLI;
  live = await createLiveTestDatabase();
  const libPath = path.join(tmpDir, 'lib');
  await fs.mkdir(libPath, { recursive: true });
  folderId = insertFolder(live.db, { path: libPath, slug: 'pano-lib' });
  invalidateLibraryRoots();
});

afterEach(() => {
  if (ambientPanoCli !== undefined) process.env.MAPLE_PANO_CLI = ambientPanoCli;
  live.close();
  invalidateLibraryRoots();
});

function send(method: string, url: string, body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );
}

const BODY = () => ({
  assetIds: [new ObjectId().toHexString(), new ObjectId().toHexString()],
  libraryId: folderId,
  options: { retention: 'keep', localAlign: 'mesh' },
});

function insertJob(kind: string, status: string, params: Record<string, unknown> = {}): string {
  const id = new ObjectId().toHexString();
  const now = new Date().toISOString();
  run(
    live.db,
    `INSERT INTO jobs
       (id, kind, status, locked_by, lease_expires_at, cancel_requested,
        progress_current, progress_total, error, created_at, updated_at, params)
     VALUES (?, ?, ?, NULL, NULL, 0, 0, 0, NULL, ?, ?, ?)`,
    id,
    kind,
    status,
    now,
    now,
    JSON.stringify(params),
  );
  return id;
}

async function donePreview(): Promise<{ id: string; dir: string }> {
  const dir = newPreviewDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, PREVIEW_FILES.image), Buffer.from(TINY_PNG_B64, 'base64'));
  await fs.writeFile(path.join(dir, PREVIEW_FILES.alignment), '{}');
  return { id: insertJob('pano_preview', 'done', { outputDir: dir }), dir };
}

async function configure(cli: string): Promise<void> {
  await send('PUT', '/api/pano/config', { maple_cli_path: cli, enabled: true });
}

describe('preview_supported', () => {
  it('is true only for a binary whose help lists the preview flags', async () => {
    await configure(previewCli);
    expect(
      ((await (await send('GET', '/api/pano/config')).json()) as Record<string, unknown>)
        .preview_supported,
    ).toBe(true);
    await configure(legacyCli);
    const body = (await (await send('GET', '/api/pano/config')).json()) as Record<string, unknown>;
    expect(body.preview_supported).toBe(false);
    expect(body.strategy_supported).toBe(true);
  });
});

describe('POST /api/pano/preview', () => {
  it('returns 409 pano_not_provisioned without a configured binary', async () => {
    const res = await send('POST', '/api/pano/preview', BODY());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('pano_not_provisioned');
  });

  it('degrades to 409 pano_preview_unsupported on an older binary', async () => {
    await configure(legacyCli);
    const res = await send('POST', '/api/pano/preview', BODY());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('pano_preview_unsupported');
  });

  it('queues a pano_preview job whose output lives in a preview directory', async () => {
    await configure(previewCli);
    const res = await send('POST', '/api/pano/preview', BODY());
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const job = await getJob(new ObjectId(id));
    expect(job?.kind).toBe('pano_preview');
    expect(job?.status).toBe('queued');
    expect(path.dirname(String(job?.payload.outputDir))).toBe(
      path.join(os.tmpdir(), 'maple-pano-previews'),
    );
  });

  it('supersedes a queued preview instead of refusing', async () => {
    await configure(previewCli);
    const first = (await (await send('POST', '/api/pano/preview', BODY())).json()) as {
      id: string;
    };
    const second = await send('POST', '/api/pano/preview', BODY());
    expect(second.status).toBe(201);
    expect((await getJob(new ObjectId(first.id)))?.cancel_requested).toBe(true);
  });

  it('refuses while a full stitch is queued or running', async () => {
    await configure(previewCli);
    insertJob('pano_stitch', 'running');
    const res = await send('POST', '/api/pano/preview', BODY());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('pano_job_running');
  });

  it('starts from the alignment of a finished preview named in alignmentFrom', async () => {
    await configure(previewCli);
    const previous = await donePreview();
    const res = await send('POST', '/api/pano/preview', { ...BODY(), alignmentFrom: previous.id });
    const job = await getJob(new ObjectId(((await res.json()) as { id: string }).id));
    expect(job?.payload.alignmentIn).toBe(path.join(previous.dir, PREVIEW_FILES.alignment));
    await fs.rm(previous.dir, { recursive: true, force: true });
  });
});

describe('GET /api/pano/jobs/:id/preview', () => {
  it('serves the PNG of a finished preview', async () => {
    const { id, dir } = await donePreview();
    const res = await send('GET', `/api/pano/jobs/${id}/preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(TINY_PNG_B64, 'base64'));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('404s for an unfinished preview, a stitch job, or an unowned directory', async () => {
    const running = insertJob('pano_preview', 'running', { outputDir: newPreviewDir() });
    const stitch = insertJob('pano_stitch', 'done', { outputDir: tmpDir });
    const escaped = insertJob('pano_preview', 'done', { outputDir: tmpDir });
    for (const id of [running, stitch, escaped, new ObjectId().toHexString()]) {
      expect((await send('GET', `/api/pano/jobs/${id}/preview`)).status).toBe(404);
    }
    expect((await send('GET', '/api/pano/jobs/nope/preview')).status).toBe(400);
  });

  it('exposes preview jobs through the shared status and cancel routes', async () => {
    const id = insertJob('pano_preview', 'running', { outputDir: newPreviewDir() });
    const status = await send('GET', `/api/pano/jobs/${id}`);
    expect(((await status.json()) as { kind: string }).kind).toBe('pano_preview');
    expect((await send('DELETE', `/api/pano/jobs/${id}`)).status).toBe(200);
    expect((await getJob(new ObjectId(id)))?.cancel_requested).toBe(true);
  });
});

describe('POST /api/pano/stitch with alignmentFrom', () => {
  it('hands a finished preview alignment to the stitch job', async () => {
    await configure(previewCli);
    const { id, dir } = await donePreview();
    const res = await send('POST', '/api/pano/stitch', { ...BODY(), alignmentFrom: id });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; alignmentReused: boolean };
    expect(body.alignmentReused).toBe(true);
    const job = await getJob(new ObjectId(body.id));
    expect(job?.payload.alignmentIn).toBe(path.join(dir, PREVIEW_FILES.alignment));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stitches without one when the preview is unfinished, unknown or malformed', async () => {
    await configure(previewCli);
    const unfinished = insertJob('pano_preview', 'running', { outputDir: newPreviewDir() });
    for (const alignmentFrom of [unfinished, new ObjectId().toHexString(), 'not-an-id']) {
      const res = await send('POST', '/api/pano/stitch', { ...BODY(), alignmentFrom });
      const body = (await res.json()) as { id: string; alignmentReused: boolean };
      expect(body.alignmentReused).toBe(false);
      run(live.db, `UPDATE jobs SET status = 'done' WHERE id = ?`, body.id);
    }
  });

  it('cancels the previews it supersedes so they do not hold the runner', async () => {
    await configure(previewCli);
    const queued = insertJob('pano_preview', 'queued', { outputDir: newPreviewDir() });
    const running = insertJob('pano_preview', 'running', { outputDir: newPreviewDir() });
    const res = await send('POST', '/api/pano/stitch', BODY());
    expect(res.status).toBe(201);
    for (const id of [queued, running]) {
      expect((await getJob(new ObjectId(id)))?.cancel_requested).toBe(true);
    }
  });

  it('keeps the previews when the stitch is refused', async () => {
    await configure(previewCli);
    insertJob('pano_stitch', 'running', { assetIds: ['other'] });
    const preview = insertJob('pano_preview', 'queued', { outputDir: newPreviewDir() });
    expect((await send('POST', '/api/pano/stitch', BODY())).status).toBe(409);
    expect((await getJob(new ObjectId(preview)))?.cancel_requested).toBe(false);
  });

  it('never offers an alignment to a binary without the preview flags', async () => {
    await configure(legacyCli);
    const { id, dir } = await donePreview();
    const res = await send('POST', '/api/pano/stitch', { ...BODY(), alignmentFrom: id });
    expect(((await res.json()) as { alignmentReused: boolean }).alignmentReused).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('Boundary Warp and Auto Crop options (#5576)', () => {
  const withEdges = (options: Record<string, unknown>) => ({
    ...BODY(),
    options: { ...BODY().options, ...options },
  });

  it('reports edges_supported from the binary help', async () => {
    await configure(edgesCli);
    const supported = (await (await send('GET', '/api/pano/config')).json()) as Record<
      string,
      unknown
    >;
    expect(supported.edges_supported).toBe(true);
    await configure(previewCli);
    const plain = (await (await send('GET', '/api/pano/config')).json()) as Record<string, unknown>;
    expect(plain.edges_supported).toBe(false);
  });

  it('queues a preview and a stitch carrying the chosen strength and crop', async () => {
    await configure(edgesCli);
    const options = { boundaryWarp: 62.5, autoCrop: true };
    const preview = await send('POST', '/api/pano/preview', withEdges(options));
    expect(preview.status).toBe(201);
    const previewJob = await getJob(new ObjectId(((await preview.json()) as { id: string }).id));
    expect(previewJob?.payload).toMatchObject({ boundaryWarp: 62.5, autoCrop: true });
    const stitch = await send('POST', '/api/pano/stitch', withEdges(options));
    expect(stitch.status).toBe(201);
    const stitchJob = await getJob(new ObjectId(((await stitch.json()) as { id: string }).id));
    expect(stitchJob?.payload).toMatchObject({ boundaryWarp: 62.5, autoCrop: true });
  });

  it('defaults to no warp and no crop when the options are absent', async () => {
    await configure(edgesCli);
    const res = await send('POST', '/api/pano/preview', BODY());
    const job = await getJob(new ObjectId(((await res.json()) as { id: string }).id));
    expect(job?.payload).toMatchObject({ boundaryWarp: 0, autoCrop: false });
  });

  it('rejects a strength outside 0 to 100 and a wrong type', async () => {
    await configure(edgesCli);
    const bad: Record<string, unknown>[] = [
      { boundaryWarp: -1 },
      { boundaryWarp: 100.5 },
      { boundaryWarp: '50' },
      { autoCrop: 'yes' },
    ];
    for (const options of bad) {
      for (const url of ['/api/pano/preview', '/api/pano/stitch']) {
        expect((await send('POST', url, withEdges(options))).status).toBe(422);
      }
    }
  });

  it('refuses a request that asks for edges from a binary without them', async () => {
    await configure(previewCli);
    for (const options of [{ boundaryWarp: 10 }, { autoCrop: true }]) {
      for (const url of ['/api/pano/preview', '/api/pano/stitch']) {
        const res = await send('POST', url, withEdges(options));
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toBe('pano_edges_unsupported');
      }
    }
    expect((await send('POST', '/api/pano/preview', withEdges({ boundaryWarp: 0 }))).status).toBe(
      201,
    );
  });
});
