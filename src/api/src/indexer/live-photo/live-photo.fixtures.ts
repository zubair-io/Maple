// Structurally faithful Live Photo halves built from the published layouts: an
// Exif block whose MakerNote is Apple's (`Apple iOS\0`, IFD at byte 14, value
// offsets from the MakerNote start), carried in a JPEG APP1 segment or a HEIF
// `Exif` item, and a QuickTime clip whose `mdta` key table names
// `com.apple.quicktime.content.identifier`. No real camera samples are
// committed; every byte here is synthetic.
import { box } from '../motion-photo/motion-photo.fixtures.ts';

export type ByteOrder = 'MM' | 'II';

const writer = (order: ByteOrder) => ({
  u16: (value: number) => {
    const buf = Buffer.alloc(2);
    if (order === 'MM') buf.writeUInt16BE(value);
    else buf.writeUInt16LE(value);
    return buf;
  },
  u32: (value: number) => {
    const buf = Buffer.alloc(4);
    if (order === 'MM') buf.writeUInt32BE(value);
    else buf.writeUInt32LE(value);
    return buf;
  },
});

const be32 = (value: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
};
const be16 = (value: number) => {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value);
  return buf;
};

const fullBox = (type: string, version: number, ...payload: Buffer[]) =>
  box(type, Buffer.from([version, 0, 0, 0]), ...payload);

interface MakerNoteSpec {
  contentId: string | null;
  order: ByteOrder;
  header?: string;
}

/** Apple's MakerNote: a version entry, then (sorted by tag) the 0x0011 content identifier. */
function appleMakerNote({ contentId, order, header = 'Apple iOS\0' }: MakerNoteSpec): Buffer {
  const w = writer(order);
  const entryCount = contentId === null ? 1 : 2;
  const stringAt = 14 + 2 + entryCount * 12 + 4;
  const version = Buffer.concat([w.u16(0x0001), w.u16(9), w.u32(1), w.u32(15)]);
  const identifier =
    contentId === null
      ? Buffer.alloc(0)
      : Buffer.concat([w.u16(0x0011), w.u16(2), w.u32(contentId.length + 1), w.u32(stringAt)]);
  return Buffer.concat([
    Buffer.from(header, 'latin1'),
    be16(1),
    Buffer.from(order, 'latin1'),
    w.u16(entryCount),
    version,
    identifier,
    w.u32(0),
    contentId === null ? Buffer.alloc(0) : Buffer.from(`${contentId}\0`, 'latin1'),
  ]);
}

export interface AppleTiffSpec {
  contentId: string | null;
  tiffOrder?: ByteOrder;
  noteOrder?: ByteOrder;
  makerNoteHeader?: string;
}

/** A TIFF whose IFD0 points at an Exif IFD whose MakerNote is Apple's. */
export function appleTiff(spec: AppleTiffSpec): Buffer {
  const order = spec.tiffOrder ?? 'MM';
  const w = writer(order);
  const note = appleMakerNote({
    contentId: spec.contentId,
    order: spec.noteOrder ?? 'MM',
    ...(spec.makerNoteHeader === undefined ? {} : { header: spec.makerNoteHeader }),
  });
  const exifIfdAt = 8 + 2 + 12 + 4;
  const noteAt = exifIfdAt + 2 + 12 + 4;
  return Buffer.concat([
    Buffer.from(order, 'latin1'),
    w.u16(42),
    w.u32(8),
    w.u16(1),
    Buffer.concat([w.u16(0x8769), w.u16(4), w.u32(1), w.u32(exifIfdAt)]),
    w.u32(0),
    w.u16(1),
    Buffer.concat([w.u16(0x927c), w.u16(7), w.u32(note.length), w.u32(noteAt)]),
    w.u32(0),
    note,
  ]);
}

/** SOI, an APP1 Exif segment (omitted for `null`), a quantisation table, a scan, EOI. */
export function jpegWithExif(tiff: Buffer | null): Buffer {
  const exif =
    tiff === null
      ? Buffer.alloc(0)
      : Buffer.concat([
          Buffer.from([0xff, 0xe1]),
          be16(tiff.length + 8),
          Buffer.from('Exif\0\0', 'latin1'),
          tiff,
        ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    exif,
    Buffer.from([0xff, 0xdb]),
    be16(67),
    Buffer.alloc(65, 1),
    Buffer.from([0xff, 0xda]),
    be16(8),
    Buffer.alloc(6, 2),
    Buffer.alloc(256, 0x5a),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * A HEIC whose Exif item sits in `idat`. The item opens with the byte count
 * between its offset field and the TIFF header: 6 for the `Exif\0\0` prefix
 * iPhones write.
 */
export function heicWithExif(tiff: Buffer | null): Buffer {
  const ftyp = box(
    'ftyp',
    Buffer.from('heic', 'latin1'),
    be32(0),
    Buffer.from('mif1heic', 'latin1'),
  );
  const item =
    tiff === null
      ? Buffer.alloc(0)
      : Buffer.concat([be32(6), Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const infe = (id: number, type: string) =>
    fullBox('infe', 2, be16(id), be16(0), Buffer.from(`${type}\0\0`, 'latin1'));
  const iinf = fullBox(
    'iinf',
    0,
    be16(tiff === null ? 1 : 2),
    infe(1, 'hvc1'),
    ...(tiff === null ? [] : [infe(2, 'Exif')]),
  );
  const iloc = fullBox(
    'iloc',
    1,
    Buffer.from([0x44, 0x00]),
    be16(tiff === null ? 1 : 2),
    Buffer.concat([be16(1), be16(0), be16(0), be16(1), be32(0), be32(1)]),
    ...(tiff === null
      ? []
      : [Buffer.concat([be16(2), be16(1), be16(0), be16(1), be32(0), be32(item.length)])]),
  );
  const meta = fullBox(
    'meta',
    0,
    fullBox('hdlr', 0, Buffer.alloc(4), Buffer.from('pict', 'latin1'), Buffer.alloc(13)),
    iinf,
    iloc,
    box('idat', item),
  );
  return Buffer.concat([ftyp, meta, box('mdat', Buffer.alloc(64, 7))]);
}

export const CONTENT_IDENTIFIER_KEY = 'com.apple.quicktime.content.identifier';

export interface QuickTimeClipSpec {
  contentId: string | null;
  /** `iso` writes `meta` as an ISO full box; `quicktime` omits the version and flags. */
  metaStyle?: 'iso' | 'quicktime';
  key?: string;
  /** Where the metadata container sits: inside `moov`, or as a top-level box. */
  container?: 'moov' | 'top-level';
}

/** A QuickTime clip: `ftyp`, `mdat`, and `moov` holding an `mdta` key table and item list. */
export function quickTimeClip(spec: QuickTimeClipSpec): Buffer {
  const key = spec.key ?? CONTENT_IDENTIFIER_KEY;
  const keys = fullBox(
    'keys',
    0,
    be32(1),
    be32(8 + key.length),
    Buffer.from('mdta', 'latin1'),
    Buffer.from(key, 'latin1'),
  );
  const ilst = box(
    'ilst',
    ...(spec.contentId === null
      ? []
      : [
          box(
            String.fromCharCode(0, 0, 0, 1),
            box('data', be32(1), be32(0), Buffer.from(spec.contentId, 'utf8')),
          ),
        ]),
  );
  const hdlr = fullBox('hdlr', 0, Buffer.alloc(4), Buffer.from('mdta', 'latin1'), Buffer.alloc(13));
  const meta =
    (spec.metaStyle ?? 'quicktime') === 'iso'
      ? fullBox('meta', 0, hdlr, keys, ilst)
      : box('meta', hdlr, keys, ilst);
  const inMoov = (spec.container ?? 'moov') === 'moov';
  return Buffer.concat([
    box('ftyp', Buffer.from('qt  ', 'latin1'), be32(0), Buffer.from('qt  ', 'latin1')),
    box('mdat', Buffer.alloc(128, 9)),
    box('moov', box('mvhd', Buffer.alloc(100)), ...(inMoov ? [meta] : [])),
    ...(inMoov ? [] : [meta]),
  ]);
}
