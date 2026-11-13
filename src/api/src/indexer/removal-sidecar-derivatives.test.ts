// #1472: qualify saved RAW edits through the actual disposable native child.
// No model installation or injected FFI binding is used. This synthetic fixture
// proves persistence/render interoperability, not photographic AI quality.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
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
import { join, resolve } from 'node:path';
import { maple } from 'maple';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { nativeLibAvailable } from '../ffi/raw_ffi.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { computeHistogram } from '../thumbs/histogram.ts';
import { generatePreview } from './previewer.ts';
import { generateThumb } from './thumbnailer.ts';

const fixture = resolve(import.meta.dir, '../../../../test-fixtures/removal/calibration');
const tiers = [
  { name: 'thumbnail', maxPx: 512, quality: 55, generate: generateThumb },
  { name: 'preview', maxPx: 1280, quality: 70, generate: generatePreview },
];
const pngRecipe = (maxLongEdge: number) =>
  JSON.stringify({
    ...DEFAULT_EXPORT_RECIPE,
    format: 'png',
    quality: null,
    maxLongEdge,
  });

// CI builds the native library first. Missing native builds visibly skip; the
// committed fixture itself is mandatory once that real library is available.
describe.skipIf(!nativeLibAvailable())('saved-removal API worker interoperability (#1472)', () => {
  let directory: string;
  let raw: string;
  let xmp: string;
  let mask: string;
  let patch: string;
  let source: Buffer<ArrayBuffer>;
  let xml: string;
  let records: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-removal-api-')));
    raw = join(directory, 'photo.dng');
    xmp = join(directory, 'photo.xmp');
    records = await readFile(join(fixture, 'records.txt'), 'utf8');
    const [record] = JSON.parse(records) as {
      accepted: { mask: string };
      patch: string;
    }[];
    const assets = join(directory, '.maple/inpaint');
    await mkdir(assets, { recursive: true });
    mask = join(assets, `${record.accepted.mask.slice(7)}.mask`);
    patch = join(assets, `${record.patch.slice(7)}.f16`);
    await copyFile(join(fixture, 'source.dng'), raw);
    await copyFile(join(fixture, 'saved.xmp'), xmp);
    await copyFile(join(fixture, 'mask.mimf'), mask);
    await copyFile(join(fixture, 'patch.f16'), patch);
    source = await readFile(raw);
    xml = await readFile(xmp, 'utf8');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(() => ffiPool().shutdown());

  async function assertDurableFilesUnchanged() {
    expect(await readFile(raw)).toEqual(source);
    expect(await readFile(xmp, 'utf8')).toBe(xml);
    expect(await readFile(mask)).toEqual(await readFile(join(fixture, 'mask.mimf')));
    expect(await readFile(patch)).toEqual(await readFile(join(fixture, 'patch.f16')));
  }

  async function setRecords(value: unknown) {
    const escaped = JSON.stringify(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    xml = xml.replace(/papp:InpaintRemovals="[^"]*"/, `papp:InpaintRemovals="${escaped}"`);
    await writeFile(xmp, xml);
  }

  for (const cap of [4, 64]) {
    it(`recipe PNG at ${cap}px matches committed RGB rather than a second RAW render`, async () => {
      const output = join(directory, 'export.png');
      expect(await ffiPool().exportRecipeToFile(raw, xml, pngRecipe(cap), null, output)).toBe(true);
      const pixels = await maple(output).toRaw();
      const size = JSON.parse(await readFile(join(fixture, `preview-${cap}.json`), 'utf8'));
      expect([pixels.width, pixels.height]).toEqual([size.width, size.height]);
      expect(Buffer.from(pixels.data)).toEqual(await readFile(join(fixture, `preview-${cap}.rgb`)));
      await assertDurableFilesUnchanged();
    }, 30_000);
  }

  it('legacy developed JPEG and histogram preserve the committed saved pixels over IPC', async () => {
    const output = join(directory, 'developed.jpg');
    expect(await ffiPool().renderDevelopJpegToFile(raw, xmp, output, 64, 90)).toBe(true);
    expect(await readFile(output)).toEqual(await readFile(join(fixture, 'preview-64-q90.jpg')));
    const rgb = await readFile(join(fixture, 'preview-64.rgb'));
    expect(await ffiPool().computeHistogram(raw, xmp)).toEqual(computeHistogram(rgb, 16, 8));
    await assertDurableFilesUnchanged();
  }, 30_000);

  it('schema-5 disable and re-enable reproduce the selected stack without changing assets', async () => {
    const [record] = JSON.parse(records);
    const inactive = [{ ...record, schema: 5, id: record.patch, active: false }];
    await setRecords(inactive);
    const output = join(directory, 'disabled.png');
    const baseline = join(directory, 'baseline.png');
    expect(await ffiPool().exportRecipeToFile(raw, xml, pngRecipe(64), null, output)).toBe(true);
    expect(await ffiPool().exportRecipeToFile(raw, '', pngRecipe(64), null, baseline)).toBe(true);
    expect((await maple(output).toRaw()).data).toEqual((await maple(baseline).toRaw()).data);
    expect(Buffer.from((await maple(output).toRaw()).data)).not.toEqual(
      await readFile(join(fixture, 'preview-64.rgb')),
    );
    expect(await ffiPool().computeHistogram(raw, xmp)).toEqual(
      await ffiPool().computeHistogram(raw, null),
    );
    await assertDurableFilesUnchanged();
    await setRecords([{ ...inactive[0], active: true }]);
    const enabled = join(directory, 'enabled.png');
    expect(await ffiPool().exportRecipeToFile(raw, xml, pngRecipe(64), null, enabled)).toBe(true);
    expect(Buffer.from((await maple(enabled).toRaw()).data)).toEqual(
      await readFile(join(fixture, 'preview-64.rgb')),
    );
    await assertDurableFilesUnchanged();
  }, 30_000);

  for (const tier of tiers) {
    it(`${tier.name} cold generation, warm reuse and regeneration reproduce the saved edit`, async () => {
      // Encode the committed JPEG pixels, not another native RAW render, as
      // the lossy AVIF oracle. The real format dispatch must retain the patch.
      const expectedFile = join(directory, 'expected.avif');
      expect(
        await ffiPool().renderBitmapThumbToFile(
          join(fixture, 'preview-64-q90.jpg'),
          expectedFile,
          tier.maxPx,
          tier.quality,
          'jpg',
        ),
      ).toEqual({ ok: true });
      const expected = (await maple(expectedFile).toRaw()).data;
      const output = join(directory, `${tier.name}.avif`);
      await tier.generate(raw, output);
      expect((await maple(output).toRaw()).data).toEqual(expected);
      const first = await stat(output);
      await tier.generate(raw, output);
      expect((await stat(output)).mtimeMs).toBe(first.mtimeMs);
      await rm(output);
      await tier.generate(raw, output);
      expect((await maple(output).toRaw()).data).toEqual(expected);
      expect(
        (await readdir(directory)).filter(
          (name) => name.includes('.tmp.') || name.includes('.develop.'),
        ),
      ).toEqual([]);
      await assertDurableFilesUnchanged();
    }, 30_000);
  }

  for (const failure of [
    'missing-mask',
    'corrupt-patch',
    'changed-source',
    'future-schema',
    'disabled-missing-mask',
  ] as const) {
    it(`${failure} rejects all cold consumers without publishing an unedited result`, async () => {
      if (failure === 'missing-mask' || failure === 'disabled-missing-mask') await rm(mask);
      if (failure === 'corrupt-patch') await writeFile(patch, 'corrupt companion');
      if (failure === 'changed-source') {
        // A valid DNG with identical decoded pixels but a different original
        // digest must not accept a patch bound to the previous original.
        source = Buffer.concat([source, Buffer.from([0])]);
        await writeFile(raw, source);
      }
      if (failure === 'future-schema' || failure === 'disabled-missing-mask') {
        const [record] = JSON.parse(records);
        await setRecords(
          failure === 'future-schema'
            ? [{ ...record, schema: 99 }]
            : [{ ...record, schema: 5, id: record.patch, active: false }],
        );
      }
      const png = join(directory, 'failed.png');
      const jpeg = join(directory, 'failed.jpg');
      const reason =
        failure === 'corrupt-patch'
          ? /checksum mismatch/
          : failure === 'changed-source'
            ? /source or decode anchor changed/
            : failure === 'future-schema'
              ? /unsupported removal schema/
              : /saved companion .*\.mask/;
      await expect(
        ffiPool().exportRecipeToFile(raw, xml, pngRecipe(64), null, png),
      ).rejects.toThrow(reason);
      await expect(ffiPool().renderDevelopJpegToFile(raw, xmp, jpeg, 64, 90)).rejects.toThrow();
      await expect(ffiPool().computeHistogram(raw, xmp)).rejects.toThrow();
      for (const tier of tiers) {
        const output = join(directory, `failed-${tier.name}.avif`);
        await expect(tier.generate(raw, output)).rejects.toThrow();
        await expect(stat(output)).rejects.toThrow();
      }
      await expect(stat(png)).rejects.toThrow();
      await expect(stat(jpeg)).rejects.toThrow();
      expect((await readdir(directory)).sort()).toEqual(['.maple', 'photo.dng', 'photo.xmp']);
      expect(await readFile(raw)).toEqual(source);
      expect(await readFile(xmp, 'utf8')).toBe(xml);
      if (failure !== 'missing-mask' && failure !== 'disabled-missing-mask')
        expect(await readFile(mask)).toEqual(await readFile(join(fixture, 'mask.mimf')));
      if (failure !== 'corrupt-patch')
        expect(await readFile(patch)).toEqual(await readFile(join(fixture, 'patch.f16')));
      else expect(await readFile(patch, 'utf8')).toBe('corrupt companion');
    }, 30_000);
  }
});
