import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
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
import { maple } from 'maple';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { cachePathFor, resolveThumbPath, xmpSidecarPath } from '../fs/xmp.ts';
import { PIPELINE_OUTPUT_VERSION } from '../generated/adjustment-fields.generated.ts';
import { fsThumbsRoutes } from '../routes/fs-thumbs.ts';
import { generatePreview } from './previewer.ts';
import { generateThumb } from './thumbnailer.ts';

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../test-fixtures/batch-transfer/source.dng',
);
const nativeAvailable = ffiPool().available();
const cameraFixture = resolve(dirname(fixture), '../raws/test_0017.dng');
const cameraAvailable = await stat(cameraFixture).then(
  () => true,
  () => false,
);
const editedXmp = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="-2" crs:Highlights2012="-65"/>
</rdf:RDF></x:xmpmeta>`;

function withFilmLook(look: string): string {
  return editedXmp.replace(
    '<rdf:Description ',
    `<rdf:Description xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:FilmLook="${look}" papp:FilmStrength="100" `,
  );
}

describe('RAW derivatives preserve real XMP edits (#3971)', () => {
  let directory: string;
  let rawPath: string;
  let originalRoots: string | undefined;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-raw-sidecar-')));
    rawPath = join(directory, 'photo.dng');
    await copyFile(fixture, rawPath);
    originalRoots = process.env.MAPLE_ROOTS;
    process.env.MAPLE_ROOTS = directory;
  });

  afterEach(async () => {
    if (originalRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = originalRoots;
    await rm(directory, { recursive: true, force: true });
  });

  async function expectedPixels(maxPx: number, quality: number, xmp: string | null) {
    const jpeg = join(directory, `oracle-${maxPx}-${xmp ? 'edited' : 'default'}.jpg`);
    const avif = jpeg + '.avif';
    expect(await ffiPool().renderDevelopJpegToFile(rawPath, xmp, jpeg, maxPx, 90)).toBe(true);
    expect(await ffiPool().renderBitmapThumbToFile(jpeg, avif, maxPx, quality, 'jpg')).toEqual({
      ok: true,
    });
    return (await maple(avif).toRaw()).data;
  }

  async function filmExpectedPixels(maxPx: number, quality: number, xml: string) {
    const jpeg = join(directory, `film-oracle-${maxPx}.jpg`);
    const avif = jpeg + '.avif';
    expect(
      await ffiPool().exportRecipeToFile(
        rawPath,
        xml,
        JSON.stringify({ ...DEFAULT_EXPORT_RECIPE, quality: 90, maxLongEdge: maxPx }),
        resolve(dirname(fixture), '../../resources/film-luts'),
        jpeg,
      ),
    ).toBe(true);
    expect(await ffiPool().renderBitmapThumbToFile(jpeg, avif, maxPx, quality, 'jpg')).toEqual({
      ok: true,
    });
    return (await maple(avif).toRaw()).data;
  }

  for (const tier of [
    { name: 'thumbnail', maxPx: 512, quality: 55, generate: generateThumb },
    { name: 'preview', maxPx: 1280, quality: 70, generate: generatePreview },
  ]) {
    it.skipIf(!nativeAvailable)(
      `${tier.name}: ignores foreign cache versions and regenerates the authored film`,
      async () => {
        const xml = withFilmLook('color_negative_kodak_portra_400');
        await writeFile(xmpSidecarPath(rawPath), xml);
        const original = await readFile(rawPath);
        const expected = await filmExpectedPixels(tier.maxPx, tier.quality, xml);
        const output =
          tier.name === 'thumbnail'
            ? resolveThumbPath(rawPath)
            : cachePathFor(rawPath, 'previews', 'avif');
        await mkdir(dirname(output), { recursive: true });
        const cameraJpeg = join(directory, 'foreign.jpg');
        const cameraAvif = join(directory, 'foreign.avif');
        expect(
          await ffiPool().renderDevelopJpegToFile(rawPath, null, cameraJpeg, tier.maxPx, 90),
        ).toBe(true);
        expect(
          await ffiPool().renderBitmapThumbToFile(
            cameraJpeg,
            cameraAvif,
            tier.maxPx,
            tier.quality,
            'jpg',
          ),
        ).toEqual({ ok: true });
        const foreign = await readFile(cameraAvif);
        const paths = [0, PIPELINE_OUTPUT_VERSION - 1, PIPELINE_OUTPUT_VERSION + 1].map((version) =>
          output.replace(
            `.v${PIPELINE_OUTPUT_VERSION}.avif`,
            `${version === 0 ? '' : `.v${version}`}.avif`,
          ),
        );
        for (const path of paths) await writeFile(path, foreign);
        await tier.generate(rawPath);
        expect((await maple(output).toRaw()).data).toEqual(expected);
        const first = await stat(output);
        await tier.generate(rawPath);
        expect((await stat(output)).mtimeMs).toBe(first.mtimeMs);
        for (const path of paths) expect(await readFile(path)).toEqual(foreign);
        expect(await readFile(rawPath)).toEqual(original);
        expect(await readFile(xmpSidecarPath(rawPath), 'utf8')).toBe(xml);
      },
      30000,
    );

    it.skipIf(!nativeAvailable)(
      `${tier.name}: cold film regeneration matches the actual LUT render`,
      async () => {
        const xml = withFilmLook('color_negative_kodak_portra_400');
        const xmp = xmpSidecarPath(rawPath);
        await writeFile(xmp, xml);
        const original = await readFile(rawPath);
        const expected = await filmExpectedPixels(tier.maxPx, tier.quality, xml);
        const withoutFilm = await expectedPixels(tier.maxPx, tier.quality, xmp);
        expect(expected).not.toEqual(withoutFilm);
        const output = join(directory, `${tier.name}.avif`);
        await tier.generate(rawPath, output);
        expect((await maple(output).toRaw()).data).toEqual(expected);
        const first = await stat(output);
        await tier.generate(rawPath, output);
        expect((await stat(output)).mtimeMs).toBe(first.mtimeMs);
        await rm(output);
        await tier.generate(rawPath, output);
        expect((await maple(output).toRaw()).data).toEqual(expected);
        expect(await readFile(rawPath)).toEqual(original);
        expect(await readFile(xmp, 'utf8')).toBe(xml);
      },
      30000,
    );

    it.skipIf(!nativeAvailable)(
      `${tier.name}: an unresolved authored LUT fails without a cache or intermediates`,
      async () => {
        const xml = withFilmLook('maple_missing_test_lut');
        await writeFile(xmpSidecarPath(rawPath), xml);
        const output = join(directory, `${tier.name}.avif`);
        await expect(tier.generate(rawPath, output)).rejects.toThrow();
        await expect(stat(output)).rejects.toThrow();
        expect(
          (await readdir(directory)).filter(
            (name) => name.includes('.tmp.') || name.includes('.develop.'),
          ),
        ).toEqual([]);
        expect(await readFile(xmpSidecarPath(rawPath), 'utf8')).toBe(xml);
      },
      30000,
    );
  }

  for (const tier of [
    { name: 'thumbnail', maxPx: 512, quality: 55, generate: generateThumb },
    { name: 'preview', maxPx: 1280, quality: 70, generate: generatePreview },
  ]) {
    it.skipIf(!nativeAvailable)(
      `${tier.name}: cold regeneration matches developed XMP pixels and warm reuse preserves the file`,
      async () => {
        const original = await readFile(rawPath);
        const xmp = xmpSidecarPath(rawPath);
        await writeFile(xmp, editedXmp);
        const expected = await expectedPixels(tier.maxPx, tier.quality, xmp);
        const unedited = await expectedPixels(tier.maxPx, tier.quality, null);
        expect(expected).not.toEqual(unedited);
        const output = join(directory, `${tier.name}.avif`);
        await tier.generate(rawPath, output);
        expect((await maple(output).toRaw()).data).toEqual(expected);
        const first = await stat(output);
        await tier.generate(rawPath, output);
        expect((await stat(output)).mtimeMs).toBe(first.mtimeMs);
        await rm(output);
        await tier.generate(rawPath, output);
        expect((await maple(output).toRaw()).data).toEqual(expected);
        expect(await readFile(rawPath)).toEqual(original);
        expect(await readFile(xmp, 'utf8')).toBe(editedXmp);
        expect(
          (await readdir(directory)).filter(
            (name) => name.includes('.develop.') || name.includes('.tmp.'),
          ),
        ).toEqual([]);
      },
      30_000,
    );

    for (const failure of ['malformed', 'unreadable'] as const) {
      it.skipIf(!nativeAvailable)(
        `${tier.name}: ${failure} XMP fails without publishing an unedited replacement`,
        async () => {
          const xmp = xmpSidecarPath(rawPath);
          if (failure === 'malformed') await writeFile(xmp, '<x:xmpmeta><rdf:RDF>');
          else await mkdir(xmp); // An actual unreadable sidecar, even when tests run as root.
          const output = join(directory, `${tier.name}.avif`);
          await expect(tier.generate(rawPath, output)).rejects.toThrow();
          await expect(stat(output)).rejects.toThrow();
          expect(
            (await readdir(directory)).filter(
              (name) => name.includes('.develop.') || name.includes('.tmp.'),
            ),
          ).toEqual([]);
        },
        30_000,
      );
    }
  }

  async function getThumb() {
    return new Elysia()
      .use(fsThumbsRoutes)
      .handle(new Request(`http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath)}`));
  }

  it.skipIf(!nativeAvailable)(
    'filesystem route regenerates the authored edit and serves the same bytes on a warm hit',
    async () => {
      await writeFile(xmpSidecarPath(rawPath), editedXmp);
      const expected = await expectedPixels(512, 55, xmpSidecarPath(rawPath));
      const response = await getThumb();
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect((await maple(bytes).toRaw()).data).toEqual(expected);
      const warm = await getThumb();
      expect(warm.status).toBe(200);
      expect(Buffer.from(await warm.arrayBuffer())).toEqual(bytes);
      expect(await readFile(resolveThumbPath(rawPath))).toEqual(bytes);
    },
    30_000,
  );

  it.skipIf(!nativeAvailable)(
    'filesystem route preserves the selected film look on cold, warm and regenerated reads',
    async () => {
      const xml = withFilmLook('color_negative_kodak_portra_400');
      await writeFile(xmpSidecarPath(rawPath), xml);
      const expected = await filmExpectedPixels(512, 55, xml);
      const response = await getThumb();
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect((await maple(bytes).toRaw()).data).toEqual(expected);
      const warm = await getThumb();
      expect(Buffer.from(await warm.arrayBuffer())).toEqual(bytes);
      await rm(resolveThumbPath(rawPath));
      const regenerated = await getThumb();
      expect(regenerated.status).toBe(200);
      expect((await maple(Buffer.from(await regenerated.arrayBuffer())).toRaw()).data).toEqual(
        expected,
      );
      expect(await readFile(xmpSidecarPath(rawPath), 'utf8')).toBe(xml);
    },
    30000,
  );

  it.skipIf(!nativeAvailable)(
    'filesystem route rejects invalid XMP instead of extracting the camera preview',
    async () => {
      await writeFile(xmpSidecarPath(rawPath), '<x:xmpmeta><rdf:RDF>');
      expect((await getThumb()).status).toBe(500);
      await expect(stat(resolveThumbPath(rawPath))).rejects.toThrow();
    },
    30_000,
  );

  it.skipIf(!nativeAvailable)(
    'a failed RAW develop propagates without leaving a cache file or intermediate',
    async () => {
      await writeFile(xmpSidecarPath(rawPath), editedXmp);
      await writeFile(rawPath, 'corrupt RAW');
      const output = join(directory, 'thumb.avif');
      await expect(generateThumb(rawPath, output)).rejects.toThrow();
      await expect(stat(output)).rejects.toThrow();
      expect(
        (await readdir(directory)).filter(
          (name) => name.includes('.develop.') || name.includes('.tmp.'),
        ),
      ).toEqual([]);
    },
    30_000,
  );

  it.skipIf(!nativeAvailable || !cameraAvailable)(
    'sidecarless camera RAWs retain embedded-preview extraction at both cache tiers',
    async () => {
      await copyFile(cameraFixture, rawPath);
      for (const tier of [
        { maxPx: 512, quality: 55, generate: generateThumb },
        { maxPx: 1280, quality: 70, generate: generatePreview },
      ]) {
        const expected = join(directory, `embedded-${tier.maxPx}.avif`);
        expect(
          await ffiPool().renderThumbnailAvifToFile(rawPath, expected, tier.maxPx, tier.quality),
        ).toBe(true);
        const output = join(directory, `generated-${tier.maxPx}.avif`);
        await tier.generate(rawPath, output);
        expect((await maple(output).toRaw()).data).toEqual((await maple(expected).toRaw()).data);
      }
    },
    30_000,
  );
});
