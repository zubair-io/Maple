/**
 * The server stitch against the real `maple-cli`, on frames `pano-gen-fixture`
 * writes into a temp library (#5835). Opt-in, because the API's own test run
 * builds neither binary:
 *
 *   cd src/raw-pipeline
 *   cargo build --release -p maple-cli --features pano-classical
 *   cargo build --release -p maple-pano --bin pano-gen-fixture
 *   cd ../api
 *   MAPLE_PANO_REAL_CLI=<target>/release/maple-cli \
 *   MAPLE_PANO_FIXTURE_GEN=<target>/release/pano-gen-fixture \
 *     bun test src/job-runner/handlers/pano-real-cli.test.ts
 *
 * Three 640 × 480 frames cost the model 0.26 GB for decode and matching and
 * about 0.31 GB to composite, so a 270 MiB budget passes the first check and
 * fails the second.
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
import { probePanoCli } from '../../pano/pano-cli-probe.ts';
import type { JobHandlerContext } from './index.ts';
import { panoStitchHandler } from './pano-stitch.ts';

const realCli = process.env.MAPLE_PANO_REAL_CLI ?? '';
const fixtureGen = process.env.MAPLE_PANO_FIXTURE_GEN ?? '';

const MIB = 1024 ** 2;
const FRAME_WIDTH = 640;
const STITCH_TIMEOUT_MS = 30 * 60_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Library {
  path: string;
  folderId: string;
  assetIds: string[];
}

describe.skipIf(realCli === '' || fixtureGen === '')(
  'the real maple-cli on generated frames',
  () => {
    let live: LiveTestDatabase;
    let tmpDir = '';
    let framesDir = '';
    let memoryLimitSupported = false;

    beforeAll(async () => {
      tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-real-cli-')));
      framesDir = path.join(tmpDir, 'frames');
      const generated = Bun.spawn(
        [
          fixtureGen,
          '--out-dir',
          framesDir,
          '--cameras',
          '3',
          '--width',
          String(FRAME_WIDTH),
          '--height',
          '480',
          '--source-width',
          '2048',
        ],
        { stdout: 'ignore', stderr: 'inherit' },
      );
      expect(await generated.exited).toBe(0);
      memoryLimitSupported = (await probePanoCli(realCli)).memoryLimit;
      expect(memoryLimitSupported).toBe(true);
    }, STITCH_TIMEOUT_MS);

    afterAll(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      live = await createLiveTestDatabase();
    });

    afterEach(() => {
      live.close();
      invalidateLibraryRoots();
      decodeMemoryBudget().configure(null);
    });

    async function library(slug: string): Promise<Library> {
      const libPath = path.join(tmpDir, slug);
      await fs.mkdir(libPath);
      const folderId = insertFolder(live.db, { path: libPath, slug });
      invalidateLibraryRoots();
      const frames = (await fs.readdir(framesDir)).filter((name) => name.endsWith('.dng'));
      const assetIds = await Promise.all(
        frames.map(async (filename) => {
          await fs.copyFile(path.join(framesDir, filename), path.join(libPath, filename));
          const assetId = insertAsset(live.db);
          insertLocation(live.db, { assetId, libraryId: folderId, path: '', filename });
          return assetId;
        }),
      );
      return { path: libPath, folderId, assetIds };
    }

    function stitch(lib: Library) {
      const reported: number[] = [];
      const ctx: JobHandlerContext = {
        jobId: new ObjectId(),
        reportProgress: async (current) => {
          reported.push(current);
        },
        shouldCancel: async () => false,
      };
      const run = panoStitchHandler.run(
        {
          assetIds: lib.assetIds,
          libraryId: lib.folderId,
          outputDir: path.join(tmpDir, `out-${path.basename(lib.path)}`),
          retention: 'keep',
          localAlign: 'mesh',
          strategy: null,
          strategySupported: false,
          mapleCli: realCli,
          featuresEngine: 'classical',
          modelsDir: null,
          ortDylibPath: null,
          memoryLimitSupported,
        },
        ctx,
      );
      return { run, reported };
    }

    async function panoramas(lib: Library): Promise<string[]> {
      const dir = path.join(lib.path, 'Panoramas');
      const names = await fs.readdir(dir).catch(() => []);
      return names.filter((name) => name.endsWith('.png')).map((name) => path.join(dir, name));
    }

    it(
      'refuses, before decoding anything, frames the budget cannot hold',
      async () => {
        decodeMemoryBudget().configure(64 * MIB);
        const lib = await library('too-many-frames');
        const { run, reported } = stitch(lib);

        await expect(run).rejects.toThrow(
          /^This panorama needs about 0\.3 GB of memory to merge, and the server allows 0\.0 GB\./,
        );
        expect(reported.every((units) => units === 0)).toBe(true);
        expect(await panoramas(lib)).toEqual([]);
      },
      STITCH_TIMEOUT_MS,
    );

    it(
      'refuses, once the canvas is solved, a composite the budget cannot hold',
      async () => {
        decodeMemoryBudget().configure(270 * MIB);
        const lib = await library('canvas-too-wide');
        const { run, reported } = stitch(lib);

        await expect(run).rejects.toThrow(
          /^This panorama needs about 0\.[34] GB of memory to merge, and the server allows 0\.2 GB\./,
        );
        expect(Math.max(...reported)).toBeGreaterThanOrEqual(400);
        expect(await panoramas(lib)).toEqual([]);
      },
      STITCH_TIMEOUT_MS,
    );

    it(
      'stitches the same frames to the same bytes with a budget that fits and with none',
      async () => {
        decodeMemoryBudget().configure(8 * 1024 * MIB);
        const capped = await library('fits');
        const cappedOutcome = await stitch(capped).run;
        decodeMemoryBudget().configure(null);
        const uncapped = await library('uncapped');
        const uncappedOutcome = await stitch(uncapped).run;

        expect(cappedOutcome.kind).toBe('done');
        expect(uncappedOutcome.kind).toBe('done');
        const [cappedPng] = await panoramas(capped);
        const [uncappedPng] = await panoramas(uncapped);
        const bytes = await fs.readFile(cappedPng ?? '');
        expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
        expect(bytes.readUInt32BE(16)).toBeGreaterThan(FRAME_WIDTH);
        expect(bytes.equals(await fs.readFile(uncappedPng ?? ''))).toBe(true);
      },
      STITCH_TIMEOUT_MS,
    );
  },
);
