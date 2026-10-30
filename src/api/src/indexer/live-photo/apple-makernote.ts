const EXIF_IFD_POINTER = 0x8769;
const MAKER_NOTE = 0x927c;
const CONTENT_IDENTIFIER = 0x0011;
const APPLE_HEADER = Buffer.from('Apple iOS\0', 'latin1');
const APPLE_IFD_OFFSET = 14;
const ASCII = 2;
const MAX_IFD_ENTRIES = 512;
const ENTRY_BYTES = 12;

const TYPE_BYTES: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };

interface Reader {
  buf: Buffer;
  little: boolean;
}

interface IfdEntry {
  type: number;
  count: number;
  valueField: number;
}

function u16(reader: Reader, offset: number): number | null {
  if (offset < 0 || offset + 2 > reader.buf.length) return null;
  return reader.little ? reader.buf.readUInt16LE(offset) : reader.buf.readUInt16BE(offset);
}

function u32(reader: Reader, offset: number): number | null {
  if (offset < 0 || offset + 4 > reader.buf.length) return null;
  return reader.little ? reader.buf.readUInt32LE(offset) : reader.buf.readUInt32BE(offset);
}

function findEntry(reader: Reader, ifdOffset: number, tag: number): IfdEntry | null {
  const count = u16(reader, ifdOffset);
  if (count === null) return null;
  const entries = Array.from({ length: Math.min(count, MAX_IFD_ENTRIES) }, (_, index) => {
    const at = ifdOffset + 2 + index * ENTRY_BYTES;
    return at + ENTRY_BYTES <= reader.buf.length ? at : null;
  });
  const hit = entries.find((at) => at !== null && u16(reader, at) === tag);
  if (hit === undefined || hit === null) return null;
  const type = u16(reader, hit + 2);
  const valueCount = u32(reader, hit + 4);
  return type === null || valueCount === null
    ? null
    : { type, count: valueCount, valueField: hit + 8 };
}

/** The value bytes of an entry: inline in its 4-byte field when they fit, else at the offset it holds. */
function entryBytes(reader: Reader, entry: IfdEntry): Buffer | null {
  const width = TYPE_BYTES[entry.type];
  if (width === undefined) return null;
  const length = width * entry.count;
  if (length <= 4) return reader.buf.subarray(entry.valueField, entry.valueField + length);
  const offset = u32(reader, entry.valueField);
  return offset === null || offset + length > reader.buf.length
    ? null
    : reader.buf.subarray(offset, offset + length);
}

function tiffReader(tiff: Buffer): { reader: Reader; firstIfd: number } | null {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const reader = { buf: tiff, little: order === 'II' };
  const firstIfd = u32(reader, 4);
  return u16(reader, 2) === 42 && firstIfd !== null ? { reader, firstIfd } : null;
}

function makerNoteOf(tiff: Buffer): Buffer | null {
  const parsed = tiffReader(tiff);
  if (!parsed) return null;
  const exifPointer = findEntry(parsed.reader, parsed.firstIfd, EXIF_IFD_POINTER);
  const exifIfd = exifPointer && u32(parsed.reader, exifPointer.valueField);
  const makerNote = exifIfd ? findEntry(parsed.reader, exifIfd, MAKER_NOTE) : null;
  return makerNote ? entryBytes(parsed.reader, makerNote) : null;
}

/**
 * Apple's Live Photo content identifier (MakerNote tag 0x0011) from a
 * TIFF-structured Exif block, or null when the block has no Apple MakerNote or
 * no such tag. The MakerNote is `Apple iOS\0`, a two-byte version, its own byte
 * order mark, then an IFD whose value offsets count from the MakerNote's start.
 */
export function appleContentIdentifier(tiff: Buffer): string | null {
  const note = makerNoteOf(tiff);
  if (!note || !note.subarray(0, APPLE_HEADER.length).equals(APPLE_HEADER)) return null;
  const order = note.toString('latin1', 12, 14);
  if (order !== 'II' && order !== 'MM') return null;
  const reader = { buf: note, little: order === 'II' };
  const entry = findEntry(reader, APPLE_IFD_OFFSET, CONTENT_IDENTIFIER);
  const value = entry?.type === ASCII ? entryBytes(reader, entry) : null;
  if (!value) return null;
  const terminator = value.indexOf(0);
  return value.toString('latin1', 0, terminator < 0 ? value.length : terminator);
}
