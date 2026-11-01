/**
 * pano_preview handler, the preview → stitch alignment hand-off, progress
 * parsing and preview-directory lifetime (#4580). A fake maple-cli stands in
 * for the binary, so nothing here needs models or fixtures.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  newPreviewDir,
  ownedPreviewDir,
  PREVIEW_FILES,
  PREVIEW_TTL_MS,
  sweepStalePreviews,
} from '../../pano/pano-previews.ts';
import type { JobHandlerContext } from './index.ts';
import { PANO_CLI_FAILURE_MESSAGE, progressFromLine, PROGRESS_TOTAL } from './pano-cli-process.ts';
import { fakeCliRuns, TINY_PNG_B64, writeFakePanoCli } from './pano-fake-cli.test-helpers.ts';
import { panoPreviewHandler } from './pano-preview.ts';
import { panoStitchHandler } from './pano-stitch.ts';
import { decodeMemoryBudget } from '../../ffi/decode-memory-budget.ts';

let live: LiveTestDatabase;
let tmpDir = '';
let folderId = '';
let assetIds: string[] = [];

beforeAll(async () => {
  tmpDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-preview-handler-')),
  );
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libPath = path.join(tmpDir, 'lib');
  await fs.mkdir(libPath, { recursive: true });
  folderId = insertFolder(live.db, { path: libPath, slug: 'pano-lib' });
  invalidateLibraryRoots();
  assetIds = await Promise.all(
    ['b.dng', 'a.dng'].map(async (filename) => {
      await fs.writeFile(path.join(libPath, filename), Buffer.from(TINY_PNG_B64, 'base64'));
      const assetId = insertAsset(live.db);
      insertLocation(live.db, { assetId, libraryId: folderId, path: '', filename });
      return assetId;
    }),
  );
});

afterEach(() => {
  live.close();
  invalidateLibraryRoots();
});

function context(cancel: () => boolean = () => false) {
  const reported: Array<[number, number]> = [];
  const ctx: JobHandlerContext = {
    jobId: new ObjectId(),
    reportProgress: async (current, total) => {
      reported.push([current, total]);
    },
    shouldCancel: async () => cancel(),
  };
  return { ctx, reported };
}

function payload(mapleCli: string, outputDir: string, extra: Record<string, unknown> = {}) {
  return {
    assetIds,
    libraryId: folderId,
    outputDir,
    retention: 'keep',
    localAlign: 'mesh',
    strategy: null,
    strategySupported: false,
    mapleCli,
    modelsDir: null,
    ortDylibPath: null,
    ...extra,
  };
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe('progressFromLine', () => {
  it('maps a stage and fraction onto 100 units per stage', () => {
    expect(progressFromLine('pano: progress 0 decode 0%')).toBe(0);
    expect(progressFromLine('pano: progress 2 match_graph 50%')).toBe(250);
    expect(progressFromLine('pano: progress 5 composite 100%')).toBe(PROGRESS_TOTAL);
  });

  it('ignores every other line', () => {
    expect(progressFromLine('pano: alignment — solved')).toBeNull();
    expect(progressFromLine('pano: solve — mean 0.9px')).toBeNull();
    expect(progressFromLine('pano: progress 2 0.500')).toBeNull();
  });

  it('clamps an out-of-range stage or fraction', () => {
    expect(progressFromLine('pano: progress 9 unknown 50%')).toBe(550);
    expect(progressFromLine('pano: progress 1 features 700%')).toBe(200);
  });
});

describe('panoPreviewHandler', () => {
  it('writes the preview and alignment, reports real progress, and keeps the directory', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true });
    const dir = newPreviewDir();
    const { ctx, reported } = context();

    const outcome = await panoPreviewHandler.run(payload(cli, dir), ctx);

    expect(outcome.kind).toBe('done');
    expect(outcome.result).toEqual({
      alignment: { status: 'solved', stale_reason: null },
      width: 2047,
      edges: null,
      height: 722,
      seconds: 1.5,
      matcher: 'ml',
      matcherNote: null,
    });
    expect(await exists(path.join(dir, PREVIEW_FILES.image))).toBe(true);
    expect(await exists(path.join(dir, PREVIEW_FILES.alignment))).toBe(true);
    const currents = reported.map(([current]) => current);
    expect(currents).toEqual([0, 50, 100, 150, 200, 250, 300, 600, 600]);
    expect(reported.every(([, total]) => total === PROGRESS_TOTAL)).toBe(true);
    const [run] = await fakeCliRuns(cli);
    expect(run).toContain(`--preview-out ${path.join(dir, PREVIEW_FILES.image)}`);
    expect(run).toContain(`--alignment-out ${path.join(dir, PREVIEW_FILES.alignment)}`);
    expect(run).not.toContain('--alignment-in');
    expect(
      run.endsWith(`-- ${path.join(tmpDir, 'lib', 'a.dng')} ${path.join(tmpDir, 'lib', 'b.dng')}`),
    ).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('passes Boundary Warp and Auto Crop to the CLI and returns its edges report unchanged', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true, edges: true });
    const dir = newPreviewDir();

    const outcome = await panoPreviewHandler.run(
      payload(cli, dir, { boundaryWarp: 40, autoCrop: true }),
      context().ctx,
    );

    expect(outcome.kind).toBe('done');
    expect(outcome.result.edges).toEqual({
      output: { width: 2047, height: 722 },
      uncovered_px: 0,
      boundary_warp: {
        requested: 40,
        applied: 40,
        status: 'applied',
        max_stretch: null,
        min_jacobian: null,
        predicted_coverage: null,
        solve_ms: null,
      },
      auto_crop: { requested: true, rect: null, invalid_px: null },
    });
    const run = (await fakeCliRuns(cli)).at(-1);
    expect(run).toContain('--boundary-warp 40');
    expect(run).toContain('--auto-crop');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('sends nothing new to the CLI at the defaults', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true, edges: true });
    const dir = newPreviewDir();

    await panoPreviewHandler.run(payload(cli, dir), context().ctx);

    const run = (await fakeCliRuns(cli)).at(-1);
    expect(run).not.toContain('--boundary-warp');
    expect(run).not.toContain('--auto-crop');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('ignores an out-of-range strength in a persisted payload', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true, edges: true });
    const dir = newPreviewDir();

    await panoPreviewHandler.run(payload(cli, dir, { boundaryWarp: 400 }), context().ctx);

    expect((await fakeCliRuns(cli)).at(-1)).not.toContain('--boundary-warp');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('skips a preview superseded while still queued and removes its directory', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true });
    const dir = newPreviewDir();
    await fs.mkdir(dir, { recursive: true });
    const before = (await fakeCliRuns(cli)).length;

    const outcome = await panoPreviewHandler.run(payload(cli, dir), context(() => true).ctx);

    expect(outcome.kind).toBe('cancelled');
    expect(await exists(dir)).toBe(false);
    expect((await fakeCliRuns(cli)).length).toBe(before);
  });

  it('fails with a plain message, not the CLI stderr, and removes its directory', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true, exitCode: 3 });
    const dir = newPreviewDir();

    await expect(panoPreviewHandler.run(payload(cli, dir), context().ctx)).rejects.toThrow(
      PANO_CLI_FAILURE_MESSAGE,
    );
    expect(await exists(dir)).toBe(false);
  });
});

describe('preview → stitch alignment hand-off', () => {
  it('passes the preview alignment, records the reuse, and removes the preview', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true });
    const previewDir = newPreviewDir();
    const preview = await panoPreviewHandler.run(payload(cli, previewDir), context().ctx);
    expect(preview.kind).toBe('done');
    const alignmentIn = path.join(previewDir, PREVIEW_FILES.alignment);

    const outputDir = path.join(tmpDir, `stitch-${process.pid}`);
    const stitch = await panoStitchHandler.run(
      payload(cli, outputDir, { alignmentIn }),
      context().ctx,
    );

    expect(stitch.kind).toBe('done');
    expect(stitch.result.alignment).toEqual({ status: 'reused', stale_reason: null });
    const runs = await fakeCliRuns(cli);
    expect(runs.at(-1)).toContain(`--alignment-in ${alignmentIn}`);
    expect(await exists(previewDir)).toBe(false);
    expect(await exists(outputDir)).toBe(false);
  });

  it('never hands the CLI an alignment outside the preview directories', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true });
    const outputDir = path.join(tmpDir, `stitch-jail-${process.pid}`);
    const stitch = await panoStitchHandler.run(
      payload(cli, outputDir, { alignmentIn: '/etc/passwd' }),
      context().ctx,
    );

    expect(stitch.kind).toBe('done');
    expect(stitch.result.alignment).toEqual({ status: 'solved', stale_reason: null });
    expect((await fakeCliRuns(cli)).at(-1)).not.toContain('--alignment-in');
  });
});

describe('stitch with Boundary Warp and Auto Crop (#5576)', () => {
  it('passes both options, returns the edges report, and names the panorama apart from the plain one', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true, edges: true });
    const plain = await panoStitchHandler.run(
      payload(cli, path.join(tmpDir, `stitch-plain-${process.pid}`)),
      context().ctx,
    );
    const edged = await panoStitchHandler.run(
      payload(cli, path.join(tmpDir, `stitch-edged-${process.pid}`), {
        boundaryWarp: 25,
        autoCrop: true,
      }),
      context().ctx,
    );

    expect(plain.kind).toBe('done');
    expect(plain.result.edges).toMatchObject({ boundary_warp: { status: 'off' } });
    expect(edged.kind).toBe('done');
    expect(edged.result.edges).toMatchObject({
      boundary_warp: { requested: 25, status: 'applied' },
      auto_crop: { requested: true },
    });
    expect(edged.result.outputPath).not.toBe(plain.result.outputPath);
    const runs = await fakeCliRuns(cli);
    expect(runs.at(-1)).toContain('--boundary-warp 25');
    expect(runs.at(-1)).toContain('--auto-crop');
    expect(runs.at(-2)).not.toContain('--boundary-warp');
  });
});

describe('stitch with Auto Crop (#5608)', () => {
  it('records the reported rectangle as a crop in the panorama sidecar and leaves the pixels whole', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true, edges: true });
    await fs.writeFile(`${cli}.rect`, '{"x":47,"y":22,"width":1800,"height":600}');
    try {
      const withCrop = await panoStitchHandler.run(
        payload(cli, path.join(tmpDir, `stitch-crop-${process.pid}`), { autoCrop: true }),
        context().ctx,
      );
      const plain = await panoStitchHandler.run(
        payload(cli, path.join(tmpDir, `stitch-nocrop-${process.pid}`)),
        context().ctx,
      );

      expect(withCrop.kind).toBe('done');
      const png = withCrop.result.outputPath as string;
      expect(await fs.readFile(png, 'base64')).toBe(TINY_PNG_B64);
      const sidecar = await fs.readFile(png.replace(/\.png$/, '.xmp'), 'utf8');
      expect(sidecar).toContain('crs:HasCrop="True"');
      expect(sidecar).toContain('crs:CropLeft="0.022960"');
      expect(sidecar).toContain('crs:CropTop="0.030471"');
      expect(sidecar).toContain('crs:CropRight="0.902296"');
      expect(sidecar).toContain('crs:CropBottom="0.861496"');
      const plainPng = plain.result.outputPath as string;
      expect(await exists(plainPng.replace(/\.png$/, '.xmp'))).toBe(false);
    } finally {
      await fs.rm(`${cli}.rect`, { force: true });
    }
  });
});

describe('preview directories', () => {
  it('only owns direct children of the previews root', () => {
    const dir = newPreviewDir();
    expect(ownedPreviewDir(dir)).toBe(dir);
    expect(ownedPreviewDir(path.join(dir, 'nested'))).toBeNull();
    expect(ownedPreviewDir(path.join(dir, '..', '..'))).toBeNull();
    expect(ownedPreviewDir('/tmp')).toBeNull();
    expect(ownedPreviewDir(42)).toBeNull();
  });

  it('sweeps directories older than the TTL and keeps fresh ones', async () => {
    const stale = newPreviewDir();
    const fresh = newPreviewDir();
    await Promise.all([fs.mkdir(stale, { recursive: true }), fs.mkdir(fresh, { recursive: true })]);
    const old = new Date(Date.now() - PREVIEW_TTL_MS - 60_000);
    await fs.utimes(stale, old, old);

    await sweepStalePreviews();

    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    await fs.rm(fresh, { recursive: true, force: true });
  });

  it('keeps a stale directory whose alignment the sweeping job is about to read', async () => {
    const inUse = newPreviewDir();
    const other = newPreviewDir();
    await Promise.all([fs.mkdir(inUse, { recursive: true }), fs.mkdir(other, { recursive: true })]);
    const old = new Date(Date.now() - PREVIEW_TTL_MS - 60_000);
    await Promise.all([fs.utimes(inUse, old, old), fs.utimes(other, old, old)]);

    await sweepStalePreviews(inUse);

    expect(await exists(inUse)).toBe(true);
    expect(await exists(other)).toBe(false);
    await fs.rm(inUse, { recursive: true, force: true });
  });

  it('a superseded preview sweeps nothing, so a queued stitch keeps its alignment', async () => {
    const stitchAlignment = newPreviewDir();
    await fs.mkdir(stitchAlignment, { recursive: true });
    const old = new Date(Date.now() - PREVIEW_TTL_MS - 60_000);
    await fs.utimes(stitchAlignment, old, old);
    const cli = await writeFakePanoCli(tmpDir, { preview: true });

    const outcome = await panoPreviewHandler.run(
      payload(cli, newPreviewDir()),
      context(() => true).ctx,
    );

    expect(outcome.kind).toBe('cancelled');
    expect(await exists(stitchAlignment)).toBe(true);
    await fs.rm(stitchAlignment, { recursive: true, force: true });
  });
});

describe('pano and the decode memory budget (#5467)', () => {
  afterEach(() => decodeMemoryBudget().configure(null));

  it('waits for an in-flight decode, then holds the whole budget while it stitches', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true });
    const budget = decodeMemoryBudget();
    budget.configure(10 * 1024 ** 3);
    const releaseDecode = await budget.acquire(3 * 1024 ** 3);
    const runsBefore = (await fakeCliRuns(cli)).length;

    const preview = panoPreviewHandler.run(payload(cli, newPreviewDir()), context().ctx);
    await Bun.sleep(50);
    expect(await fakeCliRuns(cli)).toHaveLength(runsBefore);
    expect(budget.snapshot().waiting).toBe(1);

    let decodeAdmittedDuringStitch = false;
    const nextDecode = budget.acquire(1024 ** 3).then((release) => {
      decodeAdmittedDuringStitch = budget.snapshot().reservedBytes > 1024 ** 3;
      release();
    });
    releaseDecode();
    expect((await preview).kind).toBe('done');
    await nextDecode;
    expect(decodeAdmittedDuringStitch).toBe(false);
    expect(budget.snapshot()).toMatchObject({ reservedBytes: 0, running: 0, waiting: 0 });
  });

  it('does not spawn a stitch cancelled while it waited for the budget', async () => {
    const cli = await writeFakePanoCli(tmpDir, { preview: true });
    const budget = decodeMemoryBudget();
    budget.configure(10 * 1024 ** 3);
    const releaseDecode = await budget.acquire(3 * 1024 ** 3);
    const runsBefore = (await fakeCliRuns(cli)).length;
    const cancel = { value: false };
    const preview = panoPreviewHandler.run(
      payload(cli, newPreviewDir()),
      context(() => cancel.value).ctx,
    );
    await Bun.sleep(20);
    cancel.value = true;
    releaseDecode();
    expect((await preview).kind).toBe('cancelled');
    expect(await fakeCliRuns(cli)).toHaveLength(runsBefore);
    expect(budget.snapshot().reservedBytes).toBe(0);
  });
});
