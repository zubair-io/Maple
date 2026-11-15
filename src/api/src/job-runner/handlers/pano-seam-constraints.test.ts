import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from '../../fs/mirrored.ts';
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
import { newPreviewDir } from '../../pano/pano-previews.ts';
import { probePanoCli } from '../../pano/pano-cli-probe.ts';
import { type SeamConstraintsRequest } from '../../pano/pano-seam-constraints.ts';
import { fakeCliRuns, TINY_PNG_B64, writeFakePanoCli } from './pano-fake-cli.test-helpers.ts';
import { panoPreviewHandler } from './pano-preview.ts';
import { panoStitchHandler } from './pano-stitch.ts';
import type { JobHandlerContext } from './index.ts';

let live: LiveTestDatabase;
let dir: string;
let root: string;
let libraryId: string;
let assetIds: string[];
const previewDirs: string[] = [];
const constraints = (): SeamConstraintsRequest => ({
  version: 1,
  canvas: { width: 2047, height: 722 },
  regions: [{ kind: 'exclude', frame: 0, x: 10, y: 20, width: 30, height: 40 }],
});
const context = (): JobHandlerContext => ({
  jobId: new ObjectId(),
  reportProgress: async () => {},
  shouldCancel: async () => false,
});
function payload(binary: string, outputDir: string, seamConstraints?: SeamConstraintsRequest) {
  return {
    assetIds,
    libraryId,
    outputDir,
    mapleCli: binary,
    retention: 'keep',
    localAlign: 'mesh',
    strategy: 'rotation',
    strategySupported: true,
    featuresEngine: 'classical',
    modelsDir: null,
    ortDylibPath: null,
    seamConstraints,
    seamConstraintsSupported: true,
  };
}
async function cli(refuses?: 'seam_constraints') {
  const binDir = await fs.mkdtemp(path.join(dir, 'bin-'));
  return writeFakePanoCli(binDir, { preview: true, seamConstraints: true, refuses });
}
const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
beforeEach(async () => {
  live = await createLiveTestDatabase();
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-seam-handler-')));
  root = path.join(dir, 'library');
  await fs.mkdir(root);
  libraryId = insertFolder(live.db, { path: root, slug: 'seams' });
  assetIds = await Promise.all(
    ['b.dng', 'a.dng'].map(async (filename) => {
      await fs.writeFile(path.join(root, filename), Buffer.from(TINY_PNG_B64, 'base64'));
      const assetId = insertAsset(live.db);
      insertLocation(live.db, { assetId, libraryId, path: '', filename });
      return assetId;
    }),
  );
  invalidateLibraryRoots();
});
afterEach(async () => {
  live.close();
  invalidateLibraryRoots();
  await Promise.all(previewDirs.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
  await fs.rm(dir, { recursive: true, force: true });
});

describe('constrained CLI jobs', () => {
  for (const kind of ['stitch', 'preview']) {
    it(`passes a job-owned JSON file and graph-cut before -- for ${kind}`, async () => {
      const binary = await cli();
      const outputDir = kind === 'preview' ? newPreviewDir() : path.join(dir, 'out');
      previewDirs.push(outputDir);
      const handler = kind === 'preview' ? panoPreviewHandler : panoStitchHandler;
      const outcome = await handler.run(payload(binary, outputDir, constraints()), context());
      expect(outcome.kind).toBe('done');
      expect(outcome.result).toMatchObject({ seamConstraints: constraints() });
      const [args] = await fakeCliRuns(binary);
      const file = args?.match(/--seam-constraints (\S+) --seam-strategy graph-cut -- /)?.[1];
      expect(file).toBeDefined();
      expect(path.dirname(file!)).toBe(outputDir);
      expect(path.basename(file!)).toMatch(/^seam-constraints-[a-f0-9-]+\.json$/);
      expect(await Bun.file(`${binary}.seams`).json()).toEqual(constraints());
      expect(await exists(file!)).toBe(false);
      expect((await fs.readFile(`${binary}.inputs`, 'utf8')).trim().split('\n')).toEqual([
        path.join(root, 'a.dng'),
        path.join(root, 'b.dng'),
      ]);
      if (kind === 'preview') {
        expect(outcome.result).toMatchObject({
          frames: [
            { assetId: assetIds[1], path: path.join(root, 'a.dng') },
            { assetId: assetIds[0], path: path.join(root, 'b.dng') },
          ],
        });
      }
    });
    it(`leaves legacy unconstrained argv unchanged for ${kind}`, async () => {
      const binary = await cli();
      const outputDir = kind === 'preview' ? newPreviewDir() : path.join(dir, 'out');
      previewDirs.push(outputDir);
      const handler = kind === 'preview' ? panoPreviewHandler : panoStitchHandler;
      await handler.run(payload(binary, outputDir), context());
      expect((await fakeCliRuns(binary))[0]).not.toContain('--seam-');
      expect(await exists(`${binary}.seams`)).toBe(false);
    });
    it(`surfaces a named constraint refusal and cleans up ${kind}`, async () => {
      const binary = await cli('seam_constraints');
      const outputDir = kind === 'preview' ? newPreviewDir() : path.join(dir, 'out');
      const handler = kind === 'preview' ? panoPreviewHandler : panoStitchHandler;
      await expect(
        handler.run(payload(binary, outputDir, constraints()), context()),
      ).rejects.toMatchObject({
        name: 'invalid_seam_constraints',
        message: 'invalid_seam_constraints: Conflicting regions',
      });
      expect(await exists(outputDir)).toBe(false);
    });
    it(`recovers a prior attempt's constraint file for ${kind}`, async () => {
      const binary = await cli();
      const outputDir = kind === 'preview' ? newPreviewDir() : path.join(dir, 'out');
      previewDirs.push(outputDir);
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, 'seam-constraints.json'), '{"stale":true}');
      const handler = kind === 'preview' ? panoPreviewHandler : panoStitchHandler;
      const outcome = await handler.run(payload(binary, outputDir, constraints()), context());
      expect(outcome.kind).toBe('done');
      expect(outcome.result).toMatchObject({ seamConstraints: constraints() });
      expect(await Bun.file(`${binary}.seams`).json()).toEqual(constraints());
    });
  }
  it('never reuses an unconstrained output, but reuses the identical constrained output', async () => {
    const binary = await cli();
    const first = await panoStitchHandler.run(payload(binary, path.join(dir, 'plain')), context());
    const constrained = await panoStitchHandler.run(
      payload(binary, path.join(dir, 'seams'), constraints()),
      context(),
    );
    const again = await panoStitchHandler.run(
      payload(binary, path.join(dir, 'again'), constraints()),
      context(),
    );
    const changed = constraints();
    changed.regions[0]!.x++;
    const different = await panoStitchHandler.run(
      payload(binary, path.join(dir, 'different'), changed),
      context(),
    );
    expect(first.result.outputPath).not.toBe(constrained.result.outputPath);
    expect(again.result.outputPath).toBe(constrained.result.outputPath);
    expect(again.result).toMatchObject({ seamConstraints: constraints() });
    expect(different.result.outputPath).not.toBe(constrained.result.outputPath);
    expect(await fakeCliRuns(binary)).toHaveLength(3);
  });
  it('invalidates a constrained output when renamed non-first frames exchange positions', async () => {
    const thirdId = insertAsset(live.db);
    insertLocation(live.db, { assetId: thirdId, libraryId, path: '', filename: 'c.dng' });
    await fs.writeFile(path.join(root, 'c.dng'), Buffer.from(TINY_PNG_B64, 'base64'));
    assetIds.push(thirdId);
    const binary = await cli();
    const request = constraints();
    request.regions[0]!.frame = 1;
    const before = await panoStitchHandler.run(
      payload(binary, path.join(dir, 'before'), request),
      context(),
    );
    await fs.rename(path.join(root, 'b.dng'), path.join(root, 'swap.dng'));
    await fs.rename(path.join(root, 'c.dng'), path.join(root, 'b.dng'));
    await fs.rename(path.join(root, 'swap.dng'), path.join(root, 'c.dng'));
    live.db.run('UPDATE asset_locations SET filename = ? WHERE asset_id = ?', [
      'swap.dng',
      assetIds[0]!,
    ]);
    live.db.run('UPDATE asset_locations SET filename = ? WHERE asset_id = ?', ['b.dng', thirdId]);
    live.db.run('UPDATE asset_locations SET filename = ? WHERE asset_id = ?', [
      'c.dng',
      assetIds[0]!,
    ]);
    const after = await panoStitchHandler.run(
      payload(binary, path.join(dir, 'after'), request),
      context(),
    );
    expect(after.result.outputPath).not.toBe(before.result.outputPath);
    expect(await fakeCliRuns(binary)).toHaveLength(2);
  });
  it('preserves preview alignment reuse when constraints are added', async () => {
    const binary = await cli();
    const previewDir = newPreviewDir();
    previewDirs.push(previewDir);
    await panoPreviewHandler.run(payload(binary, previewDir), context());
    const alignmentIn = path.join(previewDir, 'alignment.json');
    const outcome = await panoStitchHandler.run(
      {
        ...payload(binary, path.join(dir, 'constrained'), constraints()),
        alignmentIn,
      },
      context(),
    );
    expect(outcome.result.alignment).toMatchObject({ status: 'reused' });
    const runs = await fakeCliRuns(binary);
    expect(runs[1]).toContain(`--alignment-in ${alignmentIn}`);
    expect(runs[1]).toContain('--seam-strategy graph-cut');
  });
  it('numbers Unicode input paths in the CLI’s UTF-8 lexical order', async () => {
    assetIds = await Promise.all(
      ['\u{10000}.dng', '\uE000.dng'].map(async (filename) => {
        await fs.writeFile(path.join(root, filename), Buffer.from(TINY_PNG_B64, 'base64'));
        const assetId = insertAsset(live.db);
        insertLocation(live.db, { assetId, libraryId, path: '', filename });
        return assetId;
      }),
    );
    const binary = await cli();
    const previewDir = newPreviewDir();
    previewDirs.push(previewDir);
    const outcome = await panoPreviewHandler.run(
      payload(binary, previewDir, constraints()),
      context(),
    );
    expect(outcome.result.frames).toEqual([
      { assetId: assetIds[1], path: path.join(root, '\uE000.dng') },
      { assetId: assetIds[0], path: path.join(root, '\u{10000}.dng') },
    ]);
  });
  it('matches CLI component ordering for prefix sibling folders and Unicode filenames', async () => {
    const selected = [
      { folder: 'Pano 2', filename: '\uE000.dng' },
      { folder: 'Pano', filename: '\u{10000}.dng' },
      { folder: 'Pano', filename: '\uE000.dng' },
    ];
    await Promise.all(['Pano', 'Pano 2'].map((folder) => fs.mkdir(path.join(root, folder))));
    assetIds = await Promise.all(
      selected.map(async ({ folder, filename }) => {
        await fs.writeFile(path.join(root, folder, filename), Buffer.from(TINY_PNG_B64, 'base64'));
        const assetId = insertAsset(live.db);
        insertLocation(live.db, { assetId, libraryId, path: folder, filename });
        return assetId;
      }),
    );
    const binary = await cli();
    const previewDir = newPreviewDir();
    previewDirs.push(previewDir);
    const outcome = await panoPreviewHandler.run(
      payload(binary, previewDir, constraints()),
      context(),
    );
    const expected = [2, 1, 0].map((index) => ({
      assetId: assetIds[index],
      path: path.join(root, selected[index]!.folder, selected[index]!.filename),
    }));
    expect(outcome.result.frames).toEqual(expected);
    expect((await fs.readFile(`${binary}.inputs`, 'utf8')).trim().split('\n')).toEqual(
      expected.map((frame) => frame.path),
    );
  });
  it('requires the version marker, not merely the old bare-array flag', async () => {
    const binary = await cli();
    const source = await fs.readFile(binary, 'utf8');
    await fs.writeFile(binary, source.replace('SeamConstraintsRequest v1', 'legacy bare array'));
    expect((await probePanoCli(binary)).seamConstraints).toBe(false);
  });
});
