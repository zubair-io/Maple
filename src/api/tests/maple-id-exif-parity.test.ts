import { test, expect } from 'bun:test';
import exifr from 'exifr';
import { crc32 } from 'node:zlib';
import { extractHeicExifTiff } from '../src/indexer/heic-exif.ts';
import { extractWebpExifTiff } from '../src/indexer/webp-exif.ts';
import {
  blobReader,
  readRawCaptureDates,
} from '../../web/projects/maple-common/src/lib/addressing/exif-capture-dates.ts';

// #5090: the shared tag reader must hand back exactly the strings exifr does
// for the ExifIFD capture-date tags, whatever the byte order, container or
// string shape, because the server and the browser date a file from them.

interface Tag {
  tag: number;
  type?: number;
  count?: number;
  value: Buffer;
}

const bytesReader = (bytes: Uint8Array) => blobReader(new Blob([Uint8Array.from(bytes)]));

const ascii = (text: string, nul = true): Buffer =>
  Buffer.concat([Buffer.from(text, 'latin1'), nul ? Buffer.alloc(1) : Buffer.alloc(0)]);

/** A TIFF block: IFD0 holding an ExifIFD pointer (or `ifd0Tags`), then the ExifIFD. */
function tiff(exifTags: Tag[], le = true, ifd0Tags: Tag[] = [], magic = 42): Buffer {
  const u16 = (n: number): Buffer => {
    const b = Buffer.alloc(2);
    if (le) b.writeUInt16LE(n);
    else b.writeUInt16BE(n);
    return b;
  };
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    if (le) b.writeUInt32LE(n);
    else b.writeUInt32BE(n);
    return b;
  };
  const ifdSize = (tags: Tag[]): number => 2 + 12 * tags.length + 4;
  const ifd0Size = ifdSize(ifd0Tags) + 12;
  const exifOffset = 8 + ifd0Size;
  let dataOffset = exifOffset + ifdSize(exifTags);
  const blobs: Buffer[] = [];
  const entries = (tags: Tag[]): Buffer[] =>
    tags.map((t) => {
      const count = t.count ?? t.value.length;
      const type = t.type ?? 2;
      if (t.value.length <= 4) {
        const inline = Buffer.alloc(4);
        t.value.copy(inline);
        return Buffer.concat([u16(t.tag), u16(type), u32(count), inline]);
      }
      const entry = Buffer.concat([u16(t.tag), u16(type), u32(count), u32(dataOffset)]);
      blobs.push(t.value);
      dataOffset += t.value.length;
      return entry;
    });
  const ifd0Entries = entries(ifd0Tags);
  const exifEntries = entries(exifTags);
  const pointer = Buffer.concat([u16(TAG_EXIF_IFD), u16(4), u32(1), u32(exifOffset)]);
  return Buffer.concat([
    Buffer.from(le ? 'II' : 'MM'),
    u16(magic),
    u32(8),
    u16(ifd0Tags.length + 1),
    ...ifd0Entries,
    pointer,
    u32(0),
    u16(exifTags.length),
    ...exifEntries,
    u32(0),
    ...blobs,
  ]);
}
const TAG_EXIF_IFD = 0x8769;

const segment = (marker: number, payload: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
const exifSegment = (tiffBytes: Buffer): Buffer =>
  segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffBytes]));
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const jpeg = (...segments: Buffer[]): Buffer => Buffer.concat([SOI, ...segments, EOI]);

const DTO = 0x9003;
const CD = 0x9004;
const dto = (text: string, nul = true): Tag => ({
  tag: DTO,
  value: ascii(text, nul),
});
const cd = (text: string): Tag => ({ tag: CD, value: ascii(text) });

const dateStrings: Record<string, Tag[]> = {
  conformant: [dto('2024:06:01 12:34:56'), cd('2024:06:01 12:34:57')],
  'original only': [dto('2024:06:01 12:34:56')],
  'digitized only': [cd('2024:06:01 12:34:57')],
  'non-padded fields': [dto('2024:6:1 12:34:56'), cd('2024:06:01 12:34:57')],
  'space-padded hour': [dto('2024:06:01  2:34:56'), cd('2024:06:01 12:34:57')],
  'T separator': [dto('2024:06:01T12:34:56'), cd('2024:06:01 12:34:57')],
  'dashes and a space': [dto('2024-06-01 12:34:56'), cd('2024:06:01 12:34:57')],
  'slashes and a space': [dto('2024/06/01 12:34:56'), cd('2024:06:01 12:34:57')],
  'date only': [dto('2024:06:01'), cd('2024:06:01 12:34:57')],
  'zero placeholder': [dto('0000:00:00 00:00:00'), cd('2024:06:01 12:34:57')],
  'blank placeholder': [dto('    :  :     :  :  '), cd('2024:06:01 12:34:57')],
  'no NUL terminator': [dto('2024:06:01 12:34:56', false)],
  'trailing spaces': [dto('2024:06:01 12:34:56  ')],
  'leading spaces': [dto('  2024:06:01 12:34:56')],
  'NUL then space': [{ tag: DTO, value: Buffer.from('2024:06:01 12:34:56\0 ', 'latin1') }],
  'interior NUL': [{ tag: DTO, value: Buffer.from('2024:06:01\0 12:34:56\0', 'latin1') }],
  'many NULs': [{ tag: DTO, value: Buffer.from('2024:06:01 12:34:56\0\0\0', 'latin1') }],
  'non-breaking space': [{ tag: DTO, value: Buffer.from('2024:06:01 12:34:56\u00a0\0', 'utf8') }],
  'UTF-8 text': [{ tag: DTO, value: Buffer.from('2024:06:01 12:34:56é\0', 'utf8') }],
  'invalid UTF-8': [{ tag: DTO, value: Buffer.from([0x32, 0x30, 0xe9, 0x32, 0]) }],
  'short inline value': [dto('ab')],
  'all NULs': [{ tag: DTO, value: Buffer.alloc(6) }],
  'whitespace only': [{ tag: DTO, value: Buffer.from('  \0\0', 'latin1') }],
  'undefined-typed value': [
    {
      tag: DTO,
      type: 7,
      value: Buffer.from('2024:06:01 12:34:56\0', 'latin1'),
    },
  ],
  'zero count': [{ tag: DTO, count: 0, value: Buffer.alloc(0) }],
  'duplicated tag': [dto('2024:06:02 12:34:56'), dto('2023:06:01 12:34:56')],
  'tags out of order': [cd('2024:06:01 12:34:57'), dto('2024:06:02 12:34:56')],
  'unrelated tags only': [{ tag: 0x829a, type: 5, value: Buffer.alloc(8) }],
  'no tags': [],
};

const containers: Record<string, (t: Buffer) => Buffer> = {
  'bare TIFF': (t) => t,
  'JPEG APP1': (t) => jpeg(exifSegment(t)),
  'JPEG after JFIF and XMP': (t) =>
    jpeg(
      segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
      segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x/>', 'latin1')),
      exifSegment(t),
    ),
};

async function exifrDates(
  bytes: Buffer,
): Promise<{ DateTimeOriginal?: string; CreateDate?: string }> {
  // An unrecognised container makes exifr throw; there is no date either way.
  const raw = (await exifr
    .parse(new Uint8Array(bytes), {
      pick: ['DateTimeOriginal', 'CreateDate'],
      reviveValues: false,
    })
    .catch(() => undefined)) as Record<string, unknown> | undefined;
  const out: { DateTimeOriginal?: string; CreateDate?: string } = {};
  if (typeof raw?.DateTimeOriginal === 'string') out.DateTimeOriginal = raw.DateTimeOriginal;
  if (typeof raw?.CreateDate === 'string') out.CreateDate = raw.CreateDate;
  return out;
}

test('every date string shape, byte order and container reads as exifr reads it', async () => {
  for (const [shape, tags] of Object.entries(dateStrings)) {
    for (const le of [true, false]) {
      for (const [container, wrap] of Object.entries(containers)) {
        const bytes = wrap(tiff(tags, le));
        const label = `${shape} / ${le ? 'II' : 'MM'} / ${container}`;
        expect(await readRawCaptureDates(bytesReader(new Uint8Array(bytes))), label).toEqual(
          await exifrDates(bytes),
        );
      }
    }
  }
});

test('structural variants read as exifr reads them', async () => {
  const good = [dto('2024:06:01 12:34:56'), cd('2024:06:01 12:34:57')];
  const base = tiff(good);
  const variants: Record<string, Buffer> = {
    'ORF-style magic': tiff(good, true, [], 0x4f52),
    'unknown magic': tiff(good, false, [], 7),
    'date tags in IFD0 only': tiff([], true, good),
    'ExifIFD offset past the end': (() => {
      const b = Buffer.from(base);
      b.writeUInt32LE(b.length + 1000, 8 + 2 + 12 - 4);
      return b;
    })(),
    'IFD0 offset past the end': (() => {
      const b = Buffer.from(base);
      b.writeUInt32LE(b.length + 1000, 4);
      return b;
    })(),
    'value offset past the end': tiff([{ tag: DTO, count: 20, value: Buffer.alloc(0), type: 2 }]),
    truncated: base.subarray(0, base.length - 6),
    'no byte-order mark': Buffer.concat([Buffer.from('XX'), base.subarray(2)]),
    'exif segment after the scan data': Buffer.concat([
      SOI,
      Buffer.from([0xff, 0xda, 0, 2]),
      exifSegment(base),
      EOI,
    ]),
    'two exif segments': jpeg(exifSegment(base), exifSegment(tiff([dto('2000:01:01 00:00:00')]))),
    'exif segment after a quantisation table': jpeg(
      segment(0xdb, Buffer.alloc(65)),
      exifSegment(base),
    ),
    'empty file': Buffer.alloc(0),
    'JPEG without APP1': jpeg(segment(0xe0, Buffer.alloc(14))),
  };
  for (const [label, bytes] of Object.entries(variants)) {
    const expected = await exifrDates(bytes);
    const actual = await readRawCaptureDates(bytesReader(new Uint8Array(bytes)));
    expect(actual ?? {}, label).toEqual(expected);
  }
});

const be32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const box = (type: string, payload: Buffer): Buffer =>
  Buffer.concat([be32(8 + payload.length), Buffer.from(type, 'latin1'), payload]);

/** ftyp + meta(iinf: one `Exif` item, iloc: its extent) + mdat(Exif item). */
function heic(tiffBytes: Buffer): Buffer {
  const ftyp = box('ftyp', Buffer.from('heic\0\0\0\0mif1heic', 'latin1'));
  const infe = box(
    'infe',
    Buffer.concat([be32(0x02000000), Buffer.from([0, 1, 0, 0]), Buffer.from('Exif', 'latin1')]),
  );
  const iinf = box('iinf', Buffer.concat([be32(0), Buffer.from([0, 1]), infe]));
  const ilocBody = (extentOffset: number, length: number): Buffer =>
    Buffer.concat([
      be32(0x01000000),
      Buffer.from([0x44, 0x00, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1]),
      be32(extentOffset),
      be32(length),
    ]);
  const payload = Buffer.concat([be32(0), tiffBytes]);
  const metaLength = 8 + 4 + iinf.length + 8 + ilocBody(0, 0).length;
  const iloc = box('iloc', ilocBody(ftyp.length + metaLength + 8, payload.length));
  const meta = box('meta', Buffer.concat([be32(0), iinf, iloc]));
  return Buffer.concat([ftyp, meta, box('mdat', payload)]);
}

function webp(tiffBytes: Buffer, marker: boolean): Buffer {
  const payload = Buffer.concat([
    marker ? Buffer.from('Exif\0\0', 'latin1') : Buffer.alloc(0),
    tiffBytes,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  const chunk = Buffer.concat([
    Buffer.from('EXIF', 'latin1'),
    size,
    payload,
    payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
  const riff = Buffer.alloc(4);
  riff.writeUInt32LE(4 + chunk.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), riff, Buffer.from('WEBP', 'latin1'), chunk]);
}

function png(tiffBytes: Buffer, after: boolean): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    return Buffer.concat([be32(data.length), body, be32(crc32(body) >>> 0)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = chunk('IDAT', Buffer.alloc(8, 1));
  const exif = chunk('eXIf', tiffBytes);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(after ? [idat, exif] : [exif, idat]),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('HEIC, WebP and PNG containers read as the server reads them', async () => {
  for (const [shape, tags] of Object.entries(dateStrings)) {
    const inner = tiff(tags, false);
    const label = (container: string): string => `${shape} / ${container}`;
    const heicBytes = heic(inner);
    expect(extractHeicExifTiff(heicBytes), label('HEIC locator sanity')).not.toBeNull();
    expect(
      await readRawCaptureDates(bytesReader(new Uint8Array(heicBytes))),
      label('HEIC'),
    ).toEqual(await exifrDates(extractHeicExifTiff(heicBytes) ?? Buffer.alloc(0)));
    for (const marker of [true, false]) {
      const webpBytes = webp(inner, marker);
      expect(
        await readRawCaptureDates(bytesReader(new Uint8Array(webpBytes))),
        label(`WebP ${marker ? 'with' : 'without'} marker`),
      ).toEqual(await exifrDates(extractWebpExifTiff(webpBytes) ?? Buffer.alloc(0)));
    }
    for (const after of [false, true]) {
      const pngBytes = png(inner, after);
      expect(
        await readRawCaptureDates(bytesReader(new Uint8Array(pngBytes))),
        label(`PNG eXIf ${after ? 'after' : 'before'} IDAT`),
      ).toEqual(await exifrDates(pngBytes));
    }
  }
});

test('a file in none of the walked containers is left to the caller', async () => {
  expect(await readRawCaptureDates(bytesReader(Buffer.from('GIF89a......')))).toBeNull();
  expect(await readRawCaptureDates(bytesReader(Buffer.alloc(0)))).toBeNull();
});
