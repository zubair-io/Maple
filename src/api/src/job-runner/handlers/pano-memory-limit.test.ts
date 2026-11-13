/**
 * The stitch's memory limit on the server (#5835): a capped decode memory
 * budget reaches a `maple-cli` that takes a limit, and a run the CLI refuses
 * fails its job with what the panorama needs and what the server has. A fake
 * maple-cli stands in for the binary here; `pano-real-cli.test.ts` runs the
 * real one on generated frames.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
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
import { decodeMemoryBudget } from '../../ffi/decode-memory-budget.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { newPreviewDir } from '../../pano/pano-previews.ts';
import type { JobHandlerContext } from './index.ts';
import { PANO_CLI_FAILURE_MESSAGE } from './pano-cli-process.ts';
import {
  fakeCliRuns,
  TINY_PNG_B64,
  writeFakePanoCli,
  type FakeCliOptions,
} from './pano-fake-cli.test-helpers.ts';
import { panoPreviewHandler } from './pano-preview.ts';
import { panoStitchHandler } from './pano-stitch.ts';

const GIB = 1024 ** 3;

let live: LiveTestDatabase;
let tmpDir = '';
let libPath = '';
let folderId = '';
let assetIds: string[] = [];

beforeAll(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-memory-limit-')));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libPath = await fs.mkdtemp(path.join(tmpDir, 'lib-'));
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
  decodeMemoryBudget().configure(null);
});

function context(): JobHandlerContext {
  return {
    jobId: new ObjectId(),
    reportProgress: async () => {},
    shouldCancel: async () => false,
  };
}

function payload(mapleCli: string, outputDir: string, memoryLimitSupported = true) {
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
    memoryLimitSupported,
  };
}

/** Each test gets its own binary, so `<cli>.args` holds only its runs. */
async function fakeCli(opts: Omit<FakeCliOptions, 'preview'> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpDir, 'cli-'));
  return writeFakePanoCli(dir, { preview: true, ...opts });
}

async function previewRun(memoryLimitSupported: boolean): Promise<string> {
  const cli = await fakeCli();
  const dir = newPreviewDir();
  await panoPreviewHandler.run(payload(cli, dir, memoryLimitSupported), context());
  await fs.rm(dir, { recursive: true, force: true });
  const [run] = await fakeCliRuns(cli);
  return run ?? '';
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe('the limit the CLI is given', () => {
  it('is the capped decode memory budget, ahead of the inputs', async () => {
    decodeMemoryBudget().configure(3 * GIB);
    const run = await previewRun(true);

    expect(run).toContain(`--memory-limit-bytes ${3 * GIB} -- ${path.join(libPath, 'a.dng')}`);
  });

  it('is absent while the budget is uncapped', async () => {
    const run = await previewRun(true);

    expect(run).toContain('--preview-out');
    expect(run).not.toContain('--memory-limit-bytes');
  });

  it('is absent for a job whose binary predates the flag', async () => {
    decodeMemoryBudget().configure(3 * GIB);
    const run = await previewRun(false);

    expect(run).toContain('--preview-out');
    expect(run).not.toContain('--memory-limit-bytes');
  });

  it('reaches a full stitch too', async () => {
    decodeMemoryBudget().configure(3 * GIB);
    const cli = await fakeCli();

    const outcome = await panoStitchHandler.run(
      payload(cli, path.join(tmpDir, 'out-limited')),
      context(),
    );

    expect(outcome.kind).toBe('done');
    const [run] = await fakeCliRuns(cli);
    expect(run).toContain(`--memory-limit-bytes ${3 * GIB} -- `);
  });
});

describe('a run the CLI refused', () => {
  it('fails the stitch with what it needs and what the server allows, importing nothing', async () => {
    const cli = await fakeCli({ refuses: 'memory' });

    await expect(
      panoStitchHandler.run(payload(cli, path.join(tmpDir, 'out-memory')), context()),
    ).rejects.toThrow(
      'This panorama needs about 3.2 GB of memory to merge, and the server allows 2.0 GB. ' +
        'Merge fewer photos, or ask the server’s owner to raise “Decode memory budget” in Settings → Workers.',
    );
    expect(await exists(path.join(libPath, 'Panoramas'))).toBe(false);
    expect(await exists(path.join(tmpDir, 'out-memory'))).toBe(false);
  });

  it('fails the preview the same way and removes its directory', async () => {
    const cli = await fakeCli({ refuses: 'memory' });
    const dir = newPreviewDir();

    await expect(panoPreviewHandler.run(payload(cli, dir), context())).rejects.toThrow(
      'This panorama needs about 3.2 GB of memory to merge, and the server allows 2.0 GB.',
    );
    expect(await exists(dir)).toBe(false);
  });

  it('says the server is short of temporary disk space when that is the reason', async () => {
    const cli = await fakeCli({ refuses: 'scratch_space' });

    await expect(
      panoStitchHandler.run(payload(cli, path.join(tmpDir, 'out-scratch')), context()),
    ).rejects.toThrow(
      'This panorama needs about 3.2 GB of temporary disk space on the server, and 2.0 GB is free. ' +
        'Merge fewer photos, or ask the server’s owner to free up space.',
    );
  });

  it('keeps the general failure for a run that died any other way', async () => {
    const cli = await fakeCli({ exitCode: 3 });

    await expect(
      panoStitchHandler.run(payload(cli, path.join(tmpDir, 'out-crashed')), context()),
    ).rejects.toThrow(PANO_CLI_FAILURE_MESSAGE);
  });
});
