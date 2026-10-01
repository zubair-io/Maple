import { describe, expect, it } from 'bun:test';
import { maple, type ExifTags } from '../src/index.ts';
import { loadSharpOracle } from './support/sharp-oracle.ts';

const sharp = loadSharpOracle();
if (sharp === null)
  throw new Error('EXIF authoring tests require sharp; run bun install in src/maple.');

// Independent TIFF reader: inspect encoded output, not the builder's recipe.
function directories(block: Buffer) {
  const bytes = block.subarray(block.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0);
  const little = bytes.toString('ascii', 0, 2) === 'II';
  const short = (at: number) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const long = (at: number) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const read = (offset: number) => {
    const tags = new Map<number, { format: number; data: Buffer }>();
    if (offset === 0) return { tags, next: 0 };
    const count = short(offset);
    for (let at = offset + 2; at < offset + 2 + count * 12; at += 12) {
      const format = short(at + 2);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 } as Record<number, number>)[
        format
      ];
      if (!size) throw new Error(`Unsupported test TIFF format ${format}`);
      const length = size * long(at + 4);
      const start = length > 4 ? long(at + 8) : at + 8;
      tags.set(short(at), { format, data: bytes.subarray(start, start + length) });
    }
    return { tags, next: long(offset + 2 + count * 12) };
  };
  const pointer = (dir: ReturnType<typeof read>, tag: number) => {
    const value = dir.tags.get(tag)?.data;
    return value ? (little ? value.readUInt32LE() : value.readUInt32BE()) : 0;
  };
  const root = read(long(4));
  const exif = read(pointer(root, 0x8769));
  const result = [
    root,
    read(root.next),
    exif,
    read(pointer(root, 0x8825)),
    read(pointer(exif, 0xa005)),
  ];
  const ascii = (ifd: number, tag: number) =>
    result[ifd].tags.get(tag)?.data.toString('utf8').replace(/\0+$/, '');
  const rational = (ifd: number, tag: number) => {
    const data = result[ifd].tags.get(tag)!.data;
    return Array.from({ length: data.length / 8 }, (_, i) => {
      const n = little ? data.readUInt32LE(i * 8) : data.readUInt32BE(i * 8);
      const d = little ? data.readUInt32LE(i * 8 + 4) : data.readUInt32BE(i * 8 + 4);
      return n / d;
    });
  };
  return { result, ascii, rational };
}

const pixels = {
  data: new Uint8Array(8 * 6 * 3).fill(80),
  width: 8,
  height: 6,
  channels: 3 as const,
};
const source = () => maple(pixels).png().toBuffer();
const read = async (bytes: Buffer) => directories((await sharp(bytes).metadata()).exif!);

describe('IFD-object EXIF authoring (#3588)', () => {
  it.each(['jpeg', 'png', 'webp', 'avif'] as const)(
    'embeds authored EXIF in %s readable by sharp',
    async (format) => {
      const output = await maple(await source())
        .withExif({ IFD0: { Copyright: 'Photographer 2026' } })
        .toFormat(format)
        .toBuffer();
      expect((await read(output)).ascii(0, 0x8298)).toBe('Photographer 2026');
      expect((await sharp(output).metadata()).hasProfile).toBe(false);
    },
  );

  it('authors all five directories and typed scalar/array values', async () => {
    const tags: ExifTags = {
      IFD0: { Copyright: 'Photographer', XResolution: '300/1' },
      IFD1: { Software: 'thumbnail' },
      IFD2: { DateTimeOriginal: '2026:10:01 12:30:00', ExposureTime: '1/125', FNumber: '2.8' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 3230/100' },
      IFD4: { InteroperabilityIndex: 'R98' },
    };
    const output = await maple(await source())
      .withExif(tags)
      .jpeg()
      .toBuffer();
    const decoded = await read(output);
    expect(decoded.ascii(0, 0x8298)).toBe('Photographer');
    expect(decoded.ascii(1, 0x0131)).toBe('thumbnail');
    expect(decoded.ascii(2, 0x9003)).toBe('2026:10:01 12:30:00');
    expect(decoded.rational(2, 0x829a)).toEqual([1 / 125]);
    expect(decoded.rational(2, 0x829d)).toEqual([2.8]);
    expect(decoded.rational(3, 2)).toEqual([51, 30, 32.3]);
    expect(decoded.ascii(4, 1)).toBe('R98');
    const oracle = await sharp(await source())
      .withExif(tags)
      .jpeg()
      .toBuffer();
    const expected = await read(oracle);
    expect(decoded.rational(2, 0x829a)).toEqual(expected.rational(2, 0x829a));
    expect(decoded.rational(3, 2)).toEqual(expected.rational(3, 2));
    expect(decoded.ascii(4, 1)).toBe(expected.ascii(4, 1));
  });

  it('replaces input EXIF or merges only EXIF, matching sharp call semantics', async () => {
    const input = await sharp(await source())
      .withExif({
        IFD0: { Copyright: 'Camera', Artist: 'Camera owner' },
        IFD2: { ExposureTime: '1/250' },
      })
      .withIccProfile('srgb')
      .withXmp('<x:xmpmeta/>')
      .jpeg()
      .toBuffer();
    const original = Buffer.from(input);
    for (const merge of [false, true]) {
      const tags = { IFD0: { Copyright: 'Edited' } };
      const output = await (merge ? maple(input).withExifMerge(tags) : maple(input).withExif(tags))
        .jpeg()
        .toBuffer();
      const expected = await (
        merge ? sharp(input).withExifMerge(tags) : sharp(input).withExif(tags)
      )
        .jpeg()
        .toBuffer();
      const decoded = await read(output);
      const oracle = await read(expected);
      expect(decoded.ascii(0, 0x8298)).toBe('Edited');
      expect(decoded.ascii(0, 0x013b)).toBe(oracle.ascii(0, 0x013b));
      expect(decoded.result[2].tags.has(0x829a)).toBe(merge);
      const meta = await sharp(output).metadata();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
    }
    expect(input).toEqual(original);
  });

  it('snapshots caller tags and accumulates successive calls; the final method controls merge', async () => {
    const input = await sharp(await source())
      .withExif({ IFD0: { Artist: 'Camera owner' } })
      .jpeg()
      .toBuffer();
    const tags = { IFD0: { Copyright: 'First' } };
    const builder = maple(input).withExif(tags);
    tags.IFD0.Copyright = 'Mutated';
    const output = await builder
      .withExifMerge({ IFD2: { DateTimeOriginal: '2026:10:01 12:30:00' } })
      .jpeg()
      .toBuffer();
    const decoded = await read(output);
    expect(decoded.ascii(0, 0x8298)).toBe('First');
    expect(decoded.ascii(0, 0x013b)).toBe('Camera owner');
    const replaced = await maple(input)
      .withExifMerge({ IFD0: { Copyright: 'First' } })
      .withExif({ IFD2: { DateTimeOriginal: '2026:10:01 12:30:00' } })
      .jpeg()
      .toBuffer();
    expect((await read(replaced)).ascii(0, 0x013b)).toBeUndefined();
  });

  it('retains Unicode without transliteration and supports the raw-block extension', async () => {
    const first = await maple(await source())
      .withExif({
        IFD0: { Copyright: 'Zoë 📷', XPAuthor: 'Zoë 📷' },
        IFD2: { UserComment: 'Café 📷' },
      })
      .jpeg()
      .toBuffer();
    const decoded = await read(first);
    expect(decoded.ascii(0, 0x8298)).toBe('Zoë 📷');
    expect(decoded.result[0].tags.get(40093)!.data.toString('utf16le').replace(/\0+$/, '')).toBe(
      'Zoë 📷',
    );
    const comment = decoded.result[2].tags.get(0x9286)!.data;
    expect(comment.subarray(0, 8).toString()).toBe('UNICODE\0');
    expect(comment.subarray(8).toString('utf16le')).toBe('Café 📷');
    const block = (await sharp(first).metadata()).exif!;
    const copied = await maple(await source())
      .withExif(block)
      .png()
      .toBuffer();
    expect((await read(copied)).ascii(0, 0x8298)).toBe('Zoë 📷');
  });

  it('uses case-insensitive IFDs and actual image dimensions, orientation and density like sharp', async () => {
    const input = await sharp(await source())
      .withMetadata({ orientation: 6, density: 96 })
      .jpeg()
      .toBuffer();
    const tags = {
      IFD0: { Copyright: 'First', Orientation: '8', XResolution: '300/1' },
      ifd0: { Artist: 'Photographer' },
      IFD2: { PixelXDimension: '999', PixelYDimension: '999' },
    };
    const output = await maple(input)
      .withExif(tags)
      .withExif({ ifd0: { Copyright: 'Last' } })
      .rotate()
      .resize({ width: 3, height: 4 })
      .jpeg()
      .toBuffer();
    const expected = await sharp(input)
      .withExif(tags)
      .withExif({ IFD0: { Copyright: 'Last' } })
      .rotate()
      .resize(3, 4)
      .jpeg()
      .toBuffer();
    const decoded = await read(output);
    expect(decoded.ascii(0, 0x8298)).toBe('Last');
    expect(decoded.ascii(0, 0x013b)).toBe('Photographer');
    const metadata = await sharp(output).metadata();
    const oracle = await sharp(expected).metadata();
    expect(metadata.orientation).toBe(oracle.orientation);
    expect(metadata.density).toBe(oracle.density);
    expect(decoded.result[2].tags.get(0xa002)!.data.readUInt32LE()).toBe(metadata.width);
    expect(decoded.result[2].tags.get(0xa003)!.data.readUInt32LE()).toBe(metadata.height);
  });

  it('validates tag-object shapes and rejects unknown tags and invalid typed values', async () => {
    for (const value of [null, 42, [], { IFD0: null }, { IFD0: { Copyright: 42 } }]) {
      expect(() => maple(pixels).withExif(value as unknown as ExifTags)).toThrow();
    }
    expect(() => maple(pixels).withExifMerge(Buffer.from('x') as unknown as ExifTags)).toThrow(
      'IFD object',
    );
    const invalid: ExifTags[] = [
      { IFD9: { Copyright: 'x' } },
      { IFD0: { UnknownTag: 'x' } },
      { IFD2: { FNumber: 'NaN' } },
      { IFD3: { GPSLatitude: '1/1 2/1' } },
    ];
    for (const value of invalid) {
      await expect(
        maple(await source())
          .withExif(value)
          .jpeg()
          .toBuffer(),
      ).rejects.toThrow('metadata.exifTags');
    }
    await expect(
      maple(await source())
        .withExif({ IFD0: { Copyright: 'x' } })
        .tiff()
        .toBuffer(),
    ).rejects.toThrow('TIFF cannot embed EXIF');
  });
});
