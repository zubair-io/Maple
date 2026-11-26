/**
 * One develop feeding two derivative sizes (#6034). The oracle throughout is
 * the pair of separate renders, `generateThumb` and `generatePreview`: the
 * companion path must write exactly their bytes, and must never change what
 * the requested size does when its own half is unavailable or fails.
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
} from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _setFfiPoolForTests, ffiPool, type FfiWorkerPool } from '../ffi/ffi-pool.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import {
  generatePreview,
  PREVIEW_AVIF_QUALITY,
  PREVIEW_LONG_EDGE_PX,
} from '../indexer/previewer.ts';
import { generateThumb } from '../indexer/thumbnailer.ts';
import type { CompanionDerivative } from './raw-sidecar-render.ts';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../test-fixtures');
const syntheticRaw = join(fixtures, 'batch-transfer/source.dng');
const cameraRaw = join(fixtures, 'raws/test_0017.dng');
const nativeAvailable = ffiPool().available();
const cameraAvailable = await stat(cameraRaw).then(
  () => true,
  () => false,
);
const editedXmp = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="-2" crs:Highlights2012="-65"/>
</rdf:RDF></x:xmpmeta>`;

/** The real pool with one method replaced, restored by the returned function. */
function overridePool(overrides: Partial<FfiWorkerPool>): () => void {
  const real = ffiPool();
  const proxy = new Proxy(real, {
    get: (target, property) => {
      const override = (overrides as Record<PropertyKey, unknown>)[property];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  _setFfiPoolForTests(proxy);
  return () => void _setFfiPoolForTests(real);
}

describe('an edited RAW develops both derivative sizes from one decode (#6034)', () => {
  let directory: string;
  let rawPath: string;
  let restorePool: () => void = () => undefined;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-companion-')));
    rawPath = join(directory, 'photo.dng');
  });

  afterEach(async () => {
    restorePool();
    restorePool = () => undefined;
    await rm(directory, { recursive: true, force: true });
  });

  const previewTier = (outPath: string): CompanionDerivative => ({
    outPath,
    maxPx: PREVIEW_LONG_EDGE_PX,
    quality: PREVIEW_AVIF_QUALITY,
  });

  async function separateRenders(): Promise<{ thumb: Buffer; preview: Buffer }> {
    const [thumb, preview] = [
      join(directory, 'oracle-thumb.avif'),
      join(directory, 'oracle-preview.avif'),
    ];
    expect(await generateThumb(rawPath, thumb)).toBe(true);
    expect(await generatePreview(rawPath, preview)).toBe(true);
    return { thumb: await readFile(thumb), preview: await readFile(preview) };
  }

  const intermediates = async () =>
    (await readdir(directory)).filter(
      (name) => name.includes('.tmp.') || name.includes('.develop.'),
    );

  for (const source of [
    { name: 'a synthetic RAW', path: syntheticRaw, available: true },
    { name: 'a camera RAW', path: cameraRaw, available: cameraAvailable },
  ]) {
    it.skipIf(!nativeAvailable || !source.available)(
      `${source.name}: both files hold the bytes of the two separate renders`,
      async () => {
        await copyFile(source.path, rawPath);
        await writeFile(xmpSidecarPath(rawPath), editedXmp);
        const original = await readFile(rawPath);
        const oracle = await separateRenders();

        const thumb = join(directory, 'thumb.avif');
        const preview = join(directory, 'preview.avif');
        expect(await generateThumb(rawPath, thumb, async () => previewTier(preview))).toBe(true);

        expect((await readFile(thumb)).equals(oracle.thumb)).toBe(true);
        expect((await readFile(preview)).equals(oracle.preview)).toBe(true);
        expect(await intermediates()).toEqual([]);
        expect((await readFile(rawPath)).equals(original)).toBe(true);
        expect(await readFile(xmpSidecarPath(rawPath), 'utf8')).toBe(editedXmp);
      },
      120_000,
    );
  }

  it.skipIf(!nativeAvailable)(
    'the paired render runs once and neither size is developed again',
    async () => {
      await copyFile(syntheticRaw, rawPath);
      await writeFile(xmpSidecarPath(rawPath), editedXmp);
      const real = ffiPool();
      const calls: string[] = [];
      restorePool = overridePool({
        exportRecipePairToFiles: (...args) => {
          calls.push('pair');
          return real.exportRecipePairToFiles(...args);
        },
        exportRecipeToFile: (...args) => {
          calls.push('single');
          return real.exportRecipeToFile(...args);
        },
      });
      const preview = join(directory, 'preview.avif');
      expect(
        await generateThumb(rawPath, join(directory, 'thumb.avif'), async () =>
          previewTier(preview),
        ),
      ).toBe(true);
      expect(calls).toEqual(['pair']);
      expect((await stat(preview)).size).toBeGreaterThan(0);
    },
    60_000,
  );

  it.skipIf(!nativeAvailable)(
    'a RAW without authored edits never asks for the companion',
    async () => {
      await copyFile(syntheticRaw, rawPath);
      const preview = join(directory, 'preview.avif');
      const offers: number[] = [];
      const offer = async () => {
        offers.push(1);
        return previewTier(preview);
      };
      expect(await generateThumb(rawPath, join(directory, 'thumb.avif'), offer)).toBe(true);
      await writeFile(xmpSidecarPath(rawPath), '');
      expect(await generateThumb(rawPath, join(directory, 'thumb-empty-sidecar.avif'), offer)).toBe(
        true,
      );
      expect(offers).toEqual([]);
      await expect(stat(preview)).rejects.toThrow();
    },
    60_000,
  );

  describe('the companion half never changes the thumbnail', () => {
    let oracle: Buffer;

    beforeEach(async () => {
      if (!nativeAvailable) return;
      await copyFile(syntheticRaw, rawPath);
      await writeFile(xmpSidecarPath(rawPath), editedXmp);
      const path = join(directory, 'oracle-thumb.avif');
      expect(await generateThumb(rawPath, path)).toBe(true);
      oracle = await readFile(path);
    });

    async function expectThumbOnly(
      offer: () => Promise<CompanionDerivative | null>,
      preview: string,
    ) {
      const thumb = join(directory, 'thumb.avif');
      expect(await generateThumb(rawPath, thumb, offer)).toBe(true);
      expect((await readFile(thumb)).equals(oracle)).toBe(true);
      await expect(stat(preview)).rejects.toThrow();
      expect(await intermediates()).toEqual([]);
    }

    it.skipIf(!nativeAvailable)(
      'when the paired render is unavailable or fails, the single render takes over',
      async () => {
        const preview = join(directory, 'preview.avif');
        restorePool = overridePool({
          exportRecipePairToFiles: () => Promise.reject(new Error('paired render unavailable')),
        });
        await expectThumbOnly(async () => previewTier(preview), preview);
      },
      60_000,
    );

    it.skipIf(!nativeAvailable)(
      'when only the first render lands, no companion is written',
      async () => {
        const preview = join(directory, 'preview.avif');
        const real = ffiPool();
        restorePool = overridePool({
          exportRecipePairToFiles: async (raw, xmp, film, first) => {
            await real.exportRecipeToFile(raw, xmp, first.recipeJson, film, first.outPath);
            return { second: false };
          },
        });
        await expectThumbOnly(async () => previewTier(preview), preview);
      },
      60_000,
    );

    it.skipIf(!nativeAvailable)(
      'when the companion cannot be encoded to its path',
      async () => {
        const preview = join(directory, 'absent-directory', 'preview.avif');
        await expectThumbOnly(async () => previewTier(preview), preview);
      },
      60_000,
    );

    it.skipIf(!nativeAvailable)(
      'when the offer declines or throws',
      async () => {
        const preview = join(directory, 'preview.avif');
        const real = ffiPool();
        const calls: string[] = [];
        restorePool = overridePool({
          exportRecipePairToFiles: (...args) => {
            calls.push('pair');
            return real.exportRecipePairToFiles(...args);
          },
        });
        await expectThumbOnly(async () => null, preview);
        await rm(join(directory, 'thumb.avif'));
        await expectThumbOnly(
          () => Promise.reject(new Error('preview directory is unsafe')),
          preview,
        );
        expect(calls).toEqual([]);
      },
      60_000,
    );

    it.skipIf(!nativeAvailable)(
      'a develop that fails still fails, and leaves no companion behind',
      async () => {
        await writeFile(rawPath, 'corrupt RAW');
        const preview = join(directory, 'preview.avif');
        const thumb = join(directory, 'thumb.avif');
        await expect(
          generateThumb(rawPath, thumb, async () => previewTier(preview)),
        ).rejects.toThrow();
        await expect(stat(thumb)).rejects.toThrow();
        await expect(stat(preview)).rejects.toThrow();
        expect(await intermediates()).toEqual([]);
      },
      60_000,
    );
  });

  it.skipIf(!nativeAvailable)(
    'on-demand renders pass no companion and write one file',
    async () => {
      await copyFile(syntheticRaw, rawPath);
      await writeFile(xmpSidecarPath(rawPath), editedXmp);
      const calls: string[] = [];
      const real = ffiPool();
      restorePool = overridePool({
        exportRecipePairToFiles: (...args) => {
          calls.push('pair');
          return real.exportRecipePairToFiles(...args);
        },
      });
      await mkdir(join(directory, 'out'));
      expect(await generateThumb(rawPath, join(directory, 'out', 'thumb.avif'))).toBe(true);
      expect(await generatePreview(rawPath, join(directory, 'out', 'preview.avif'))).toBe(true);
      expect(calls).toEqual([]);
      expect((await readdir(join(directory, 'out'))).sort()).toEqual([
        'preview.avif',
        'thumb.avif',
      ]);
    },
    60_000,
  );
});
