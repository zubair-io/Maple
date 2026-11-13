import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maple } from 'maple';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { resolveThumbPath, xmpSidecarPath } from '../fs/xmp.ts';
import { thumbRoutes } from '../routes/library/thumb.ts';
import { registerLibrary } from '../../tests/helpers/assets-route-fixtures.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { generatePreview } from '../indexer/previewer.ts';

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../test-fixtures/batch-transfer/source.dng',
);
const filmLuts = resolve(dirname(fixture), '../../resources/film-luts');
const nativeAvailable = ffiPool().available();

// The shape an Apple build before #4686 wrote on its second save of a
// film-look edit: the model's copy and the passthrough copy of
// `papp:FilmLook`, adjacent after the canonical sort (#5475).
const corruptSidecar = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      crs:Exposure2012="-1.5"
      crs:HasSettings="True"
      crs:ProcessVersion="11.0"
      crs:Temperature="5600"
      crs:Tint="4"
      crs:Version="11.0"
      crs:WhiteBalance="Custom"
      papp:FilmLook="color_negative_kodak_portra_160"
      papp:FilmLook="color_negative_kodak_portra_160"
      papp:Profile="Auto"
      papp:WbScaleVersion="5"/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
const repairedSidecar = corruptSidecar.replace(
  '\n      papp:FilmLook="color_negative_kodak_portra_160"\n      papp:FilmLook=',
  '\n      papp:FilmLook=',
);

describe('a sidecar that repeats an attribute still develops (#5475)', () => {
  let directory: string;
  let rawPath: string;
  let live: LiveTestDatabase;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-duplicate-attr-')));
    rawPath = join(directory, '084A9983.dng');
    await copyFile(fixture, rawPath);
    live = await createLiveTestDatabase();
    registerLibrary(live.db, directory, 'photos');
  });

  afterEach(async () => {
    invalidateLibraryRoots();
    live.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function expectedPixels(maxPx: number, quality: number, xml: string) {
    const jpeg = join(directory, `oracle-${maxPx}.jpg`);
    const avif = `${jpeg}.avif`;
    const recipe = { ...DEFAULT_EXPORT_RECIPE, quality: 90, maxLongEdge: maxPx };
    expect(
      await ffiPool().exportRecipeToFile(rawPath, xml, JSON.stringify(recipe), filmLuts, jpeg),
    ).toBe(true);
    expect(await ffiPool().renderBitmapThumbToFile(jpeg, avif, maxPx, quality, 'jpg')).toEqual({
      ok: true,
    });
    return (await maple(avif).toRaw()).data;
  }

  const getThumb = () =>
    new Elysia().use(thumbRoutes).handle(new Request('http://localhost/thumb/photos/084A9983.dng'));

  it('the fixture really is rejected by the strict reader', async () => {
    expect(repairedSidecar.match(/papp:FilmLook=/g)).toHaveLength(1);
    const { SaxesParser } = await import('saxes');
    expect(() => new SaxesParser({ xmlns: true }).write(corruptSidecar).close()).toThrow(
      'duplicate attribute: {http://ns.justmaple.app/photo/1.0/}FilmLook.',
    );
  });

  it.skipIf(!nativeAvailable)(
    'the thumbnail route serves the film edit and leaves the sidecar untouched',
    async () => {
      await writeFile(xmpSidecarPath(rawPath), corruptSidecar);
      const expected = await expectedPixels(512, 55, repairedSidecar);
      const response = await getThumb();
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect((await maple(bytes).toRaw()).data).toEqual(expected);
      expect(await readFile(xmpSidecarPath(rawPath), 'utf8')).toBe(corruptSidecar);
    },
    30_000,
  );

  it.skipIf(!nativeAvailable)(
    'the preview tier develops the same edit',
    async () => {
      await writeFile(xmpSidecarPath(rawPath), corruptSidecar);
      const expected = await expectedPixels(1280, 70, repairedSidecar);
      const output = join(directory, 'preview.avif');
      await generatePreview(rawPath, output);
      expect((await maple(output).toRaw()).data).toEqual(expected);
      expect(await readFile(xmpSidecarPath(rawPath), 'utf8')).toBe(corruptSidecar);
    },
    30_000,
  );

  it.skipIf(!nativeAvailable)(
    'a repeated attribute in an otherwise broken sidecar still fails',
    async () => {
      const unclosed = corruptSidecar.replace('</x:xmpmeta>', '');
      await writeFile(xmpSidecarPath(rawPath), unclosed);
      expect((await getThumb()).status).toBe(500);
      await expect(stat(resolveThumbPath(rawPath))).rejects.toThrow();
    },
    30_000,
  );
});
