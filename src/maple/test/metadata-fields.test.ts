import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

const sharp = (() => {
  try {
    return require(require.resolve('sharp', { paths: [path.resolve(__dirname, '../../api')] }));
  } catch {
    console.warn('Metadata field oracle skipped: Sharp is not installed under src/api');
    return null;
  }
})();
const rgb = (pages = 1) => ({
  data: Buffer.from(
    Array.from(
      { length: 24 * 16 * 3 * pages },
      (_, i) => (i * 7 + Math.floor(i / 1152) * 37) % 251,
    ),
  ),
  width: 24,
  height: 16 * pages,
  channels: 3 as const,
  pageHeight: 16,
});
const FIELDS = [
  'format',
  'width',
  'height',
  'space',
  'depth',
  'channels',
  'hasAlpha',
  'isProgressive',
  'isPalette',
  'bitsPerSample',
  'paletteBitDepth',
  'chromaSubsampling',
  'pages',
  'pagePrimary',
  'compression',
  'resolutionUnit',
  'autoOrient',
  'xmpAsString',
] as const;
async function compare(bytes: Buffer, label: string) {
  const expected = await sharp(bytes).metadata();
  const actual = await maple(bytes).metadata();
  for (const field of FIELDS) expect(actual[field], `${label}: ${field}`).toEqual(expected[field]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-metadata-fields-'));
  const file = path.join(dir, 'upload');
  await fs.writeFile(file, bytes);
  try {
    expect(await maple(file).metadata()).toEqual(actual);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(sharp === null)('header metadata agrees with Sharp (#3590)', () => {
  it('matches each supported container, with and without EXIF/XMP', async () => {
    for (const format of ['jpeg', 'png', 'webp', 'tiff', 'avif'] as const) {
      const raw = rgb();
      const plain = sharp(raw.data, { raw });
      await compare(await plain.toFormat(format).toBuffer(), `${format} plain`);
      await compare(
        await sharp(raw.data, { raw })
          .withMetadata({ orientation: 6, density: 96 })
          .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">valid UTF-8</x:xmpmeta>')
          .toFormat(format)
          .toBuffer(),
        `${format} tagged`,
      );
    }
  });
  it('reads JPEG progressive and chroma sampling headers', async () => {
    const raw = rgb();
    for (const progressive of [false, true])
      for (const chromaSubsampling of ['4:2:0', '4:4:4']) {
        await compare(
          await sharp(raw.data, { raw }).jpeg({ progressive, chromaSubsampling }).toBuffer(),
          `JPEG ${progressive} ${chromaSubsampling}`,
        );
      }
  });
  it('reads PNG palettes, bit depths and interlacing', async () => {
    const raw = rgb();
    for (const progressive of [false, true])
      for (const colours of [2, 4, 16, 256]) {
        await compare(
          await sharp(raw.data, { raw }).png({ palette: true, colours, progressive }).toBuffer(),
          `palette ${colours} ${progressive}`,
        );
      }
    for (const channels of [1, 2, 3, 4])
      for (const space of [channels < 3 ? 'b-w' : 'srgb', channels < 3 ? 'grey16' : 'rgb16']) {
        const raw = { width: 16, height: 8, channels };
        for (const format of ['png', 'tiff']) {
          const bytes = await sharp(Buffer.alloc(16 * 8 * channels, 90), { raw })
            .toColourspace(space)
            .toFormat(format, format === 'tiff' ? { compression: 'none' } : {})
            .toBuffer();
          await compare(bytes, `${format} ${space} ${channels}`);
        }
      }
  });
  it('counts TIFF/GIF/WebP pages and reports the primary AVIF page', async () => {
    for (const pages of [1, 2, 3])
      for (const format of ['tiff', 'gif', 'webp', 'avif'] as const) {
        const raw = rgb(pages);
        await compare(
          await sharp(raw.data, { raw }).toFormat(format).toBuffer(),
          `${format} ${pages}`,
        );
      }
  });
  it('reads 10-bit AVIF source depth from its real AV1 sequence header', async () => {
    const raw = rgb();
    const bytes = await maple(raw).avif({ bitdepth: 10 }).toBuffer();
    await compare(bytes, '10-bit AVIF');
  });
  it('preserves XMP bytes and reports a string only for valid UTF-8', async () => {
    const raw = rgb();
    for (const xmp of [
      Buffer.from([0x3c, 0xff, 0x3e]),
      Buffer.from('\ufeff<x:xmpmeta>🌳</x:xmpmeta>'),
    ]) {
      const bytes = await maple({ ...raw, channels: 3 })
        .withXmp(xmp)
        .jpeg()
        .toBuffer();
      const actual = await maple(bytes).metadata();
      const expected = await sharp(bytes).metadata();
      expect(actual.xmp?.equals(xmp)).toBe(true);
      expect(actual.xmpAsString).toBe(expected.xmpAsString);
    }
  });
});
