/**
 * The `thumb` stage writing an edited RAW's preview from its own develop
 * (#6034), driven through the runner against real SQLite. The oracle for the
 * bytes is `generatePreview`; the oracle for the bookkeeping is that the
 * `preview` stage's own row moves only when the `preview` stage runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
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
} from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { _setFfiPoolForTests, ffiPool } from '../../ffi/ffi-pool.ts';
import { cachePathFor, resolveThumbPath, xmpSidecarPath } from '../../fs/xmp.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { generatePreview } from '../../indexer/previewer.ts';
import { generateThumb } from '../../indexer/thumbnailer.ts';
import { solidJpeg } from '../../test-support/synth-image.ts';
import {
  _resetBackgroundPreviewGateForTests,
  setInteractivePreviewActive,
} from '../background-preview-gate.ts';
import { stageRegistry } from '../registry.ts';
import { runOnce } from '../run-stage.ts';
import previewStage from './preview.ts';
import thumbStage from './thumb.ts';

const syntheticRaw = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../test-fixtures/batch-transfer/source.dng',
);
const nativeAvailable = ffiPool().available();
const editedXmp = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="-2" crs:Highlights2012="-65"/>
</rdf:RDF></x:xmpmeta>`;
const stageConfig = (stage: { targetVersion: number }) => ({
  concurrency: 2,
  maxAttempts: 5,
  paused: false,
  last_seen_target_version: stage.targetVersion,
});

describe('the thumb stage co-produces an edited RAW preview (#6034)', () => {
  let directory: string;
  let rawPath: string;
  let live: LiveTestDatabase;
  let libraryId: string;
  let assetId: string;
  let previewPaused: boolean;

  const thumbPath = () => resolveThumbPath(rawPath);
  const previewPath = () => cachePathFor(rawPath, 'previews', 'avif');
  const stageVersion = (stage: string) =>
    (
      live.db
        .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = ?`)
        .get(assetId, stage) as { version: number }
    ).version;

  function startPreviewStage(): void {
    stageRegistry.register('preview', {
      targetVersion: previewStage.targetVersion,
      dependsOn: [{ name: 'thumb', minVersion: 1 }],
      getInFlight: () => 0,
      getThroughput: () => 0,
      getPaused: () => previewPaused,
      reloadConfig: async () => undefined,
      pause: async () => undefined,
      resume: async () => undefined,
    });
  }

  function seedAsset(filename: string): void {
    assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId, path: '', filename });
    for (const [stage, version] of [
      ['exif', 99],
      ['thumb', 0],
      ['preview', 0],
    ] as const)
      run(
        live.db,
        `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, ?, ?)`,
        assetId,
        stage,
        version,
      );
  }

  async function separateRenders(): Promise<{ thumb: Buffer; preview: Buffer }> {
    const oracleDirectory = await realpath(
      await mkdtemp(join(tmpdir(), 'maple-companion-oracle-')),
    );
    try {
      const oracleRaw = join(oracleDirectory, 'photo.dng');
      await copyFile(rawPath, oracleRaw);
      await copyFile(xmpSidecarPath(rawPath), xmpSidecarPath(oracleRaw));
      const [thumb, preview] = [join(oracleDirectory, 't.avif'), join(oracleDirectory, 'p.avif')];
      expect(await generateThumb(oracleRaw, thumb)).toBe(true);
      expect(await generatePreview(oracleRaw, preview)).toBe(true);
      return { thumb: await readFile(thumb), preview: await readFile(preview) };
    } finally {
      await rm(oracleDirectory, { recursive: true, force: true });
    }
  }

  const runThumbStage = () => runOnce(thumbStage, stageConfig(thumbStage));
  const runPreviewStage = () => runOnce(previewStage, stageConfig(previewStage));
  const leftovers = async (tier: 'thumbs' | 'previews') =>
    (await readdir(join(directory, '.maple', tier)).catch(() => [])).filter((name) =>
      name.includes('.tmp.'),
    );

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-companion-stage-')));
    rawPath = join(directory, 'photo.dng');
    live = await createLiveTestDatabase();
    libraryId = insertFolder(live.db, { path: directory });
    invalidateLibraryRoots();
    previewPaused = false;
    if (!nativeAvailable) return;
    await copyFile(syntheticRaw, rawPath);
    await writeFile(xmpSidecarPath(rawPath), editedXmp);
    seedAsset('photo.dng');
  });

  afterEach(async () => {
    stageRegistry.unregister('preview');
    _resetBackgroundPreviewGateForTests();
    invalidateLibraryRoots();
    live.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.skipIf(!nativeAvailable)(
    'writes both files with the bytes of the separate renders, and leaves the preview row to its stage',
    async () => {
      startPreviewStage();
      const oracle = await separateRenders();

      expect(await runThumbStage()).toBe(1);

      expect((await readFile(thumbPath())).equals(oracle.thumb)).toBe(true);
      expect((await readFile(previewPath())).equals(oracle.preview)).toBe(true);
      expect(stageVersion('thumb')).toBe(thumbStage.targetVersion);
      expect(stageVersion('preview')).toBe(0);
      expect(await leftovers('thumbs')).toEqual([]);
      expect(await leftovers('previews')).toEqual([]);

      const coProduced = await stat(previewPath());
      const real = ffiPool();
      const renders: string[] = [];
      const counting = new Proxy(real, {
        get: (target, property) => {
          const value = Reflect.get(target, property, target) as unknown;
          if (typeof value !== 'function') return value;
          if (typeof property === 'string' && /^(export|render)/.test(property)) {
            return (...args: unknown[]) => {
              renders.push(property);
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value.bind(target);
        },
      });
      _setFfiPoolForTests(counting);
      try {
        expect(await runPreviewStage()).toBe(1);
      } finally {
        _setFfiPoolForTests(real);
      }
      expect(renders).toEqual([]);
      expect(stageVersion('preview')).toBe(previewStage.targetVersion);
      expect((await stat(previewPath())).mtimeMs).toBe(coProduced.mtimeMs);
      expect((await readFile(previewPath())).equals(oracle.preview)).toBe(true);
    },
    120_000,
  );

  for (const blocked of [
    {
      name: 'the preview stage is paused',
      arrange: () => {
        previewPaused = true;
        startPreviewStage();
      },
    },
    { name: 'the preview stage has not started', arrange: () => undefined },
    {
      name: 'background previews are holding back for an on-demand request',
      arrange: () => {
        startPreviewStage();
        setInteractivePreviewActive(true);
      },
    },
  ]) {
    it.skipIf(!nativeAvailable)(
      `writes only the thumbnail while ${blocked.name}`,
      async () => {
        blocked.arrange();
        const oracle = await separateRenders();

        expect(await runThumbStage()).toBe(1);

        expect((await readFile(thumbPath())).equals(oracle.thumb)).toBe(true);
        await expect(stat(previewPath())).rejects.toThrow();
        expect(await leftovers('previews')).toEqual([]);
        expect(stageVersion('thumb')).toBe(thumbStage.targetVersion);
        expect(stageVersion('preview')).toBe(0);

        previewPaused = false;
        _resetBackgroundPreviewGateForTests();
        expect(await runPreviewStage()).toBe(1);
        expect((await readFile(previewPath())).equals(oracle.preview)).toBe(true);
        expect(stageVersion('preview')).toBe(previewStage.targetVersion);
      },
      120_000,
    );
  }

  it.skipIf(!nativeAvailable)(
    'a pause that lands during the render stops the preview being published',
    async () => {
      startPreviewStage();
      const real = ffiPool();
      const pausing = new Proxy(real, {
        get: (target, property) => {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === 'exportRecipePairToFiles') {
            return async (...args: Parameters<typeof real.exportRecipePairToFiles>) => {
              const result = await real.exportRecipePairToFiles(...args);
              previewPaused = true;
              return result;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      _setFfiPoolForTests(pausing);
      try {
        expect(await runThumbStage()).toBe(1);
      } finally {
        _setFfiPoolForTests(real);
      }
      expect((await stat(thumbPath())).size).toBeGreaterThan(0);
      await expect(stat(previewPath())).rejects.toThrow();
      expect(await leftovers('previews')).toEqual([]);
      expect(stageVersion('thumb')).toBe(thumbStage.targetVersion);
    },
    120_000,
  );

  it.skipIf(!nativeAvailable)(
    'leaves a fresh preview untouched',
    async () => {
      startPreviewStage();
      await mkdir(dirname(previewPath()), { recursive: true });
      await writeFile(previewPath(), 'already rendered');
      expect(await runThumbStage()).toBe(1);
      expect(await readFile(previewPath(), 'utf8')).toBe('already rendered');
      expect(await leftovers('previews')).toEqual([]);
      expect(stageVersion('thumb')).toBe(thumbStage.targetVersion);
    },
    120_000,
  );

  it.skipIf(!nativeAvailable)(
    'a preview half that cannot be written does not fail or defer the thumbnail',
    async () => {
      startPreviewStage();
      const oracle = await separateRenders();
      await mkdir(join(directory, '.maple'), { recursive: true });
      await writeFile(join(directory, '.maple', 'previews'), 'not a directory');

      expect(await runThumbStage()).toBe(1);

      expect((await readFile(thumbPath())).equals(oracle.thumb)).toBe(true);
      expect(stageVersion('thumb')).toBe(thumbStage.targetVersion);
      expect(stageVersion('preview')).toBe(0);
      expect(
        live.db
          .query(
            `SELECT attempts, last_error, next_attempt_at FROM stage_state WHERE asset_id = ? AND stage = 'thumb'`,
          )
          .get(assetId),
      ).toEqual({ attempts: 0, last_error: null, next_attempt_at: null });
    },
    120_000,
  );

  it.skipIf(!nativeAvailable)(
    'writes no preview for a RAW without authored edits or for a bitmap',
    async () => {
      startPreviewStage();
      await rm(xmpSidecarPath(rawPath));
      expect(await runThumbStage()).toBe(1);
      expect(stageVersion('thumb')).toBe(thumbStage.targetVersion);
      await expect(stat(previewPath())).rejects.toThrow();

      await writeFile(join(directory, 'plain.jpg'), await solidJpeg(800, 600, [100, 150, 200]));
      seedAsset('plain.jpg');
      expect(await runThumbStage()).toBe(1);
      expect(stageVersion('thumb')).toBe(thumbStage.targetVersion);
      expect(await readdir(join(directory, '.maple', 'thumbs'))).toContain('plain.jpg.avif');
      await expect(stat(join(directory, '.maple', 'previews'))).rejects.toThrow();
    },
    120_000,
  );
});
