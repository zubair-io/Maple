import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maple } from 'maple';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { cachePathFor, resolveThumbPath, xmpSidecarPath } from '../fs/xmp.ts';
import { mergeMetadataIntoXmp } from '../xmp/metadata-serializer.ts';
import { thumbRoutes } from '../routes/library/thumb.ts';
import { previewRoutes } from '../routes/library/preview.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import { invalidateLibraryRoots } from './libraries.cache.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { AuthoredSidecarRenderError } from '../thumbs/raw-sidecar-render.ts';
import { generatePreview } from './previewer.ts';
import { generateThumb } from './thumbnailer.ts';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../test-fixtures');
const supportedRaw = join(fixtures, 'batch-transfer/source.dng');
const unsupportedRaw = join(fixtures, 'raws/test_0016.X3F');
const cameraRaw = join(fixtures, 'raws/test_0017.dng');
const nativeAvailable = ffiPool().available();
const present = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const x3fAvailable = await present(unsupportedRaw);
const cameraAvailable = await present(cameraRaw);

// The exact empty sidecar the production RAW reliability suite seeds (#5231).
const EMPTY_XMP =
  '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
const METADATA_ONLY_XMP = mergeMetadataIntoXmp('', {
  rating: 4,
  flag: 'pick',
  colorLabel: 'red',
  keywords: ['harbour', 'dusk'],
  title: 'Evening ferry',
});
const EDITED_XMP = `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="-2" crs:Highlights2012="-65"/>
</rdf:RDF></x:xmpmeta>`;

const TIERS = [
  { name: 'thumbnail', maxPx: 512, generate: generateThumb, route: 'thumb' },
  { name: 'preview', maxPx: 1280, generate: generatePreview, route: 'preview' },
] as const;

const RAWS = [
  { name: 'supported DNG', source: supportedRaw, filename: 'photo.dng', available: true },
  { name: 'camera DNG', source: cameraRaw, filename: 'photo.dng', available: cameraAvailable },
  { name: 'X3F', source: unsupportedRaw, filename: 'photo.X3F', available: x3fAvailable },
] as const;

describe('RAW sidecars without authored adjustments render as sidecarless (#5231)', () => {
  let directory: string;
  let live: LiveTestDatabase;
  let libraryId: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-raw-sidecar-fallback-')));
    live = await createLiveTestDatabase();
    libraryId = registerLibrary(live.db, directory, 'photos');
  });

  afterEach(async () => {
    invalidateLibraryRoots();
    live.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function pixels(image: string | Buffer) {
    return (await maple(image).toRaw()).data;
  }

  /** Age the cached derivative so the next sidecar write is unambiguously newer. */
  async function backdateCache(rawPath: string, route: 'thumb' | 'preview') {
    const cache =
      route === 'thumb' ? resolveThumbPath(rawPath) : cachePathFor(rawPath, 'previews', 'avif');
    const past = new Date(Date.now() - 60_000);
    await utimes(cache, past, past);
  }

  function intermediates(): Promise<string[]> {
    return readdir(directory).then((names) =>
      names.filter((name) => name.includes('.tmp.') || name.includes('.develop.')),
    );
  }

  for (const raw of RAWS) {
    for (const tier of TIERS) {
      it.skipIf(!nativeAvailable || !raw.available)(
        `${raw.name} ${tier.name}: zero-byte, empty and metadata-only sidecars match the sidecarless render`,
        async () => {
          const rawPath = join(directory, raw.filename);
          await copyFile(raw.source, rawPath);
          const original = await readFile(rawPath);
          const sidecarless = join(directory, `${tier.name}-none.avif`);
          await tier.generate(rawPath, sidecarless);
          const expected = await pixels(sidecarless);
          for (const [label, xml] of [
            ['zero-byte', ''],
            ['empty', EMPTY_XMP],
            ['metadata-only', METADATA_ONLY_XMP],
          ] as const) {
            await writeFile(xmpSidecarPath(rawPath), xml);
            const output = join(directory, `${tier.name}-${label}.avif`);
            await tier.generate(rawPath, output);
            expect(await pixels(output)).toEqual(expected);
            expect(await readFile(xmpSidecarPath(rawPath), 'utf8')).toBe(xml);
          }
          expect(await readFile(rawPath)).toEqual(original);
          expect(await intermediates()).toEqual([]);
        },
        60_000,
      );
    }
  }

  for (const tier of TIERS) {
    it.skipIf(!nativeAvailable || !x3fAvailable)(
      `X3F ${tier.name}: authored edits fail closed with a typed error and no cache`,
      async () => {
        const rawPath = join(directory, 'photo.X3F');
        await copyFile(unsupportedRaw, rawPath);
        await writeFile(xmpSidecarPath(rawPath), EDITED_XMP);
        const output = join(directory, `${tier.name}.avif`);
        const failure = await tier.generate(rawPath, output).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(AuthoredSidecarRenderError);
        await expect(stat(output)).rejects.toThrow();
        expect(await intermediates()).toEqual([]);
        expect(await readFile(xmpSidecarPath(rawPath), 'utf8')).toBe(EDITED_XMP);
      },
      60_000,
    );

    it.skipIf(!nativeAvailable || !x3fAvailable)(
      `X3F ${tier.route} route: empty sidecar serves the embedded preview, authored edits answer 422`,
      async () => {
        const rawPath = join(directory, 'photo.X3F');
        await copyFile(unsupportedRaw, rawPath);
        seedRouteAsset(live.db, { libraryId, path: '', filename: 'photo.X3F', mapleId: 'x3f-id' });
        const app = new Elysia().use(thumbRoutes).use(previewRoutes);
        const url = `http://localhost/${tier.route}/photos/photo.X3F`;
        await writeFile(xmpSidecarPath(rawPath), EMPTY_XMP);
        const served = await app.handle(new Request(url));
        expect(served.status).toBe(200);
        expect((await pixels(Buffer.from(await served.arrayBuffer()))).length).toBeGreaterThan(0);

        await backdateCache(rawPath, tier.route);
        await writeFile(xmpSidecarPath(rawPath), EDITED_XMP);
        const refused = await app.handle(new Request(url));
        expect(refused.status).toBe(422);
        expect(await refused.json()).toEqual({
          error: 'The edits saved for this photo cannot be developed',
          code: 'authored-edits-unrenderable',
        });
      },
      60_000,
    );
  }

  it.skipIf(!nativeAvailable)(
    'an authored develop that fails for another reason stays an untyped server error',
    async () => {
      const rawPath = join(directory, 'photo.dng');
      await writeFile(rawPath, 'corrupt RAW');
      await writeFile(xmpSidecarPath(rawPath), EDITED_XMP);
      const failure = await generateThumb(rawPath, join(directory, 'thumb.avif')).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(AuthoredSidecarRenderError);
      expect(await intermediates()).toEqual([]);
    },
    30_000,
  );

  for (const tier of TIERS) {
    it.skipIf(!nativeAvailable)(
      `supported DNG ${tier.route} route: an empty sidecar that gains edits re-renders the edit`,
      async () => {
        const rawPath = join(directory, 'photo.dng');
        await copyFile(supportedRaw, rawPath);
        seedRouteAsset(live.db, { libraryId, path: '', filename: 'photo.dng', mapleId: 'dng-id' });
        const app = new Elysia().use(thumbRoutes).use(previewRoutes);
        const url = `http://localhost/${tier.route}/photos/photo.dng`;
        const sidecarless = join(directory, 'sidecarless.avif');
        await tier.generate(rawPath, sidecarless);
        await writeFile(xmpSidecarPath(rawPath), EMPTY_XMP);
        const unedited = await app.handle(new Request(url));
        expect(unedited.status).toBe(200);
        const uneditedBytes = Buffer.from(await unedited.arrayBuffer());
        expect(await pixels(uneditedBytes)).toEqual(await pixels(sidecarless));
        const etag = unedited.headers.get('ETag')!;

        await backdateCache(rawPath, tier.route);
        await writeFile(xmpSidecarPath(rawPath), EDITED_XMP);
        const edited = await app.handle(new Request(url, { headers: { 'If-None-Match': etag } }));
        expect(edited.status).toBe(200);
        expect(edited.headers.get('ETag')).not.toBe(etag);
        const jpeg = join(directory, 'oracle.jpg');
        const oracle = join(directory, 'oracle.avif');
        const quality = tier.route === 'thumb' ? 55 : 70;
        expect(
          await ffiPool().renderDevelopJpegToFile(
            rawPath,
            xmpSidecarPath(rawPath),
            jpeg,
            tier.maxPx,
            90,
          ),
        ).toBe(true);
        expect(
          await ffiPool().renderBitmapThumbToFile(jpeg, oracle, tier.maxPx, quality, 'jpg'),
        ).toEqual({
          ok: true,
        });
        const editedPixels = await pixels(Buffer.from(await edited.arrayBuffer()));
        expect(editedPixels).toEqual(await pixels(oracle));
        expect(editedPixels).not.toEqual(await pixels(uneditedBytes));
        if (tier.route === 'thumb')
          expect(await readFile(resolveThumbPath(rawPath))).toEqual(
            Buffer.from(await (await app.handle(new Request(url))).arrayBuffer()),
          );
        expect(await readFile(rawPath)).toEqual(await readFile(supportedRaw));
      },
      60_000,
    );
  }
});
