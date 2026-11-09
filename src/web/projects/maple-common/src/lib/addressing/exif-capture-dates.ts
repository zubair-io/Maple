// The raw EXIF capture-date strings of a JPEG, TIFF-family, PNG, WebP or HEIF
// file, read from the tag bytes themselves (#5090).
//
// The server dates a file with `asIsoDate(DateTimeOriginal) ?? asIsoDate(
// CreateDate)` over exifr's string for ExifIFD tags 0x9003 / 0x9004, and the
// primary maple_id hashes that date. This module is that tag read, shared by
// the API's `readExif` (it imports this file, as it does `maple-id-parser`)
// and the browser's Hosted mode, with no dependencies. It walks IFD0 -> ExifIFD
// through ranged reads, so a RAW whose IFDs sit past exifr's chunk window (a
// 100 MP DNG keeps them at the end of the file) is dated like any other, and
// the Swift reader (`RawExifDates.swift`) follows the same rules. PNG, WebP and
// HEIF find their TIFF block as the server's `heic-exif.ts` / `webp-exif.ts`
// and exifr's PNG parser do.
//
// What exifr hands back, which this reproduces (checked against exifr on every
// shape in `maple-id-exif-parity.test.ts`): only ExifIFD tags count (not IFD0,
// SubIFDs or IFD1); the first of a duplicated tag wins; a value must be ASCII
// (type 2) and inside the TIFF block; the string is UTF-8, loses trailing NULs
// then surrounding whitespace, and an empty result is no value. The TIFF
// version number is not checked (ORF/RW2 carry other magics).

export interface ByteRangeReader {
  readonly size: number;
  /** Up to `length` bytes at `offset`, fewer only at the end of the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function blobReader(blob: Blob): ByteRangeReader {
  return {
    size: blob.size,
    read: async (offset, length) =>
      new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

export interface RawCaptureDates {
  DateTimeOriginal?: string;
  CreateDate?: string;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_CREATE_DATE = 0x9004;
const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_IFD = 13;
const ENTRY_BYTES = 12;

const utf8 = new TextDecoder('utf-8');

interface Tiff {
  reader: ByteRangeReader;
  /** Offset of the TIFF header; every IFD and value offset is relative to it. */
  base: number;
  /** End of the TIFF block (the Exif APP1 segment, or the file). */
  end: number;
  littleEndian: boolean;
}

interface Entry {
  type: number;
  count: number;
  /** Absolute position of the entry's 4-byte value/offset field. */
  valueField: number;
}

function u16(bytes: Uint8Array, at: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, littleEndian);
}

function u32(bytes: Uint8Array, at: number, littleEndian: boolean): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, littleEndian);
}

/** The first occurrence of each tag in the IFD at `ifdOffset` (TIFF-relative). */
async function readIfd(tiff: Tiff, ifdOffset: number): Promise<Map<number, Entry>> {
  const entries = new Map<number, Entry>();
  const at = tiff.base + ifdOffset;
  if (at < tiff.base || at + 2 > tiff.end) return entries;
  const countBytes = await tiff.reader.read(at, 2);
  if (countBytes.length < 2) return entries;
  const count = u16(countBytes, 0, tiff.littleEndian);
  const length = count * ENTRY_BYTES;
  if (at + 2 + length > tiff.end) return entries;
  const table = await tiff.reader.read(at + 2, length);
  if (table.length < length) return entries;
  for (let i = 0; i < count; i++) {
    const entry = i * ENTRY_BYTES;
    const tag = u16(table, entry, tiff.littleEndian);
    if (entries.has(tag)) continue;
    entries.set(tag, {
      type: u16(table, entry + 2, tiff.littleEndian),
      count: u32(table, entry + 4, tiff.littleEndian),
      valueField: at + 2 + entry + 8,
    });
  }
  return entries;
}

/** An ASCII entry's string as exifr reports it, or undefined. */
async function asciiValue(tiff: Tiff, entry: Entry | undefined): Promise<string | undefined> {
  if (!entry || entry.type !== TYPE_ASCII || entry.count === 0) return undefined;
  let bytes: Uint8Array;
  if (entry.count <= 4) {
    bytes = (await tiff.reader.read(entry.valueField, entry.count)).subarray(0, entry.count);
  } else {
    const field = await tiff.reader.read(entry.valueField, 4);
    if (field.length < 4) return undefined;
    const at = tiff.base + u32(field, 0, tiff.littleEndian);
    if (at + entry.count > tiff.end) return undefined;
    bytes = await tiff.reader.read(at, entry.count);
  }
  const text = utf8.decode(bytes).replace(/\0+$/, '').trim();
  return text.length === 0 ? undefined : text;
}

/** The TIFF header at `block.base`, or null when the byte-order mark is absent. */
async function readTiff(
  reader: ByteRangeReader,
  block: TiffBlock,
): Promise<{ tiff: Tiff; ifd0Offset: number } | null> {
  const header = await reader.read(block.base, 8);
  if (header.length < 8) return null;
  const order = String.fromCharCode(header[0], header[1]);
  if (order !== 'II' && order !== 'MM') return null;
  const littleEndian = order === 'II';
  return {
    tiff: { reader, base: block.base, end: block.end, littleEndian },
    ifd0Offset: u32(header, 4, littleEndian),
  };
}

/** The ExifIFD's entries, found through IFD0's pointer tag. */
async function readExifIfd(tiff: Tiff, ifd0Offset: number): Promise<Map<number, Entry>> {
  const pointer = (await readIfd(tiff, ifd0Offset)).get(TAG_EXIF_IFD);
  if (!pointer || (pointer.type !== TYPE_LONG && pointer.type !== TYPE_IFD)) return new Map();
  const field = await tiff.reader.read(pointer.valueField, 4);
  return field.length < 4 ? new Map() : readIfd(tiff, u32(field, 0, tiff.littleEndian));
}

async function readTiffDates(reader: ByteRangeReader, block: TiffBlock): Promise<RawCaptureDates> {
  const located = await readTiff(reader, block);
  if (!located) return {};
  const exif = await readExifIfd(located.tiff, located.ifd0Offset);
  const dates: RawCaptureDates = {};
  const original = await asciiValue(located.tiff, exif.get(TAG_DATE_TIME_ORIGINAL));
  if (original !== undefined) dates.DateTimeOriginal = original;
  const created = await asciiValue(located.tiff, exif.get(TAG_CREATE_DATE));
  if (created !== undefined) dates.CreateDate = created;
  return dates;
}

/** Where a TIFF block sits in a file, and where it ends. */
interface TiffBlock {
  base: number;
  end: number;
}

const latin1 = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Bytes a JPEG marker occupies before the next one when it carries no APP1
 * segment to inspect (fill bytes and the standalone markers), else 0. */
function standaloneMarkerSkip(marker: number): number {
  if (marker === 0xff) return 1;
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) ? 2 : 0;
}

/** True when `head` is not a marker, or is the end of image or the scan. */
const endsMetadata = (head: Uint8Array): boolean =>
  head.length < 4 || head[0] !== 0xff || head[1] === 0xd9 || head[1] === 0xda;

async function isExifSegment(
  reader: ByteRangeReader,
  at: number,
  marker: number,
  length: number,
): Promise<boolean> {
  if (marker !== 0xe1 || length < 8) return false;
  const id = await reader.read(at + 4, 6);
  return latin1(id, 0, id.length) === 'Exif\0\0';
}

/** The first APP1 `Exif\0\0` segment before the scan data, like exifr's. */
async function jpegBlock(reader: ByteRangeReader): Promise<TiffBlock | null> {
  let at = 2;
  while (at + 4 <= reader.size) {
    const head = await reader.read(at, 4);
    if (endsMetadata(head)) return null;
    const skip = standaloneMarkerSkip(head[1]);
    if (skip > 0) {
      at += skip;
      continue;
    }
    const length = (head[2] << 8) | head[3];
    if (await isExifSegment(reader, at, head[1], length)) {
      return { base: at + 10, end: at + 2 + length };
    }
    at += 2 + length;
  }
  return null;
}

/** The first `eXIf` chunk (exifr matches the type case-insensitively), found
 * by walking every chunk header like exifr's PNG parser. */
async function pngBlock(reader: ByteRangeReader): Promise<TiffBlock | null> {
  let at = 8;
  while (at + 8 <= reader.size) {
    const head = await reader.read(at, 8);
    if (head.length < 8) return null;
    const length = new DataView(head.buffer, head.byteOffset).getUint32(0);
    if (latin1(head, 4, 8).toLowerCase() === 'exif') {
      return { base: at + 8, end: Math.min(at + 8 + length, reader.size) };
    }
    at += 12 + length;
  }
  return null;
}

/** The RIFF `EXIF` chunk past its optional `Exif\0\0` marker — the server's
 * `extractWebpExifTiff`. */
async function webpBlock(reader: ByteRangeReader): Promise<TiffBlock | null> {
  let at = 12;
  while (at + 8 <= reader.size) {
    const head = await reader.read(at, 8);
    if (head.length < 8) return null;
    const size = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
    const payload = at + 8;
    if (payload + size > reader.size) return null;
    if (latin1(head, 0, 4) === 'EXIF') {
      let start = payload;
      let length = size;
      const marker = await reader.read(payload, 6);
      if (size >= 6 && latin1(marker, 0, marker.length) === 'Exif\0\0') {
        start += 6;
        length -= 6;
      }
      return length > 0 ? { base: start, end: start + length } : null;
    }
    at = payload + size + (size & 1);
  }
  return null;
}

// HEIF: `meta` -> `iinf` / `iloc` -> the Exif item's extent, the server's
// `extractHeicExifTiff` (itself exifr's HEIF walker) over the `meta` box alone.

interface Box {
  offset: number;
  length: number;
  kind: string;
  start: number;
}

function uint(bytes: Uint8Array, at: number, size: number): number {
  if (size < 0 || at < 0 || at + size > bytes.length) throw new RangeError('truncated box');
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + bytes[at + i];
  return value;
}

function boxHead(bytes: Uint8Array, offset: number): Box {
  let length = uint(bytes, offset, 4);
  const kind = latin1(bytes, offset + 4, offset + 8);
  let start = offset + 8;
  if (length === 1) {
    length = uint(bytes, offset + 8, 8);
    start += 8;
  } else if (length === 0) {
    length = bytes.length - offset;
  }
  if (length < start - offset) throw new RangeError('box smaller than its header');
  return { offset, length, kind, start };
}

function findBox(bytes: Uint8Array, start: number, end: number, kind: string): Box | null {
  let offset = start;
  while (offset + 8 <= end) {
    const box = boxHead(bytes, offset);
    if (box.offset + box.length > end) throw new RangeError('box past its container');
    if (box.kind === kind) return box;
    offset = box.offset + box.length;
  }
  return null;
}

function exifItemId(bytes: Uint8Array, iinf: Box): number | null {
  const version = uint(bytes, iinf.start, 1);
  let offset = iinf.start + 4;
  let count: number;
  if (version === 0) {
    count = uint(bytes, offset, 2);
    offset += 2;
  } else {
    count = uint(bytes, offset, 4);
    offset += 4;
  }
  const end = iinf.offset + iinf.length;
  while (count-- > 0 && offset + 8 <= end) {
    const infe = boxHead(bytes, offset);
    const infeVersion = uint(bytes, infe.start, 1);
    const contentStart = infe.start + 4;
    if (infeVersion >= 2) {
      const idSize = infeVersion === 3 ? 4 : 2;
      const nameAt = contentStart + idSize + 2;
      if (nameAt + 4 > bytes.length) throw new RangeError('truncated infe');
      if (latin1(bytes, nameAt, nameAt + 4) === 'Exif') return uint(bytes, contentStart, idSize);
    }
    offset = infe.offset + infe.length;
  }
  return null;
}

function exifExtent(bytes: Uint8Array, iloc: Box, wantedId: number): [number, number] | null {
  const version = uint(bytes, iloc.start, 1);
  let offset = iloc.start + 4;
  const sizes = uint(bytes, offset, 2);
  offset += 2;
  const offsetSize = (sizes >> 12) & 0xf;
  const lengthSize = (sizes >> 8) & 0xf;
  const baseOffsetSize = (sizes >> 4) & 0xf;
  const indexSize = sizes & 0xf;
  const itemIdSize = version === 2 ? 4 : 2;
  const methodSize = version === 1 || version === 2 ? 2 : 0;
  const extentSize = indexSize + offsetSize + lengthSize;
  const countSize = version === 2 ? 4 : 2;
  let items = uint(bytes, offset, countSize);
  offset += countSize;
  while (items-- > 0) {
    const id = uint(bytes, offset, itemIdSize);
    const baseOffset = uint(bytes, offset + itemIdSize + methodSize + 2, baseOffsetSize);
    offset += itemIdSize + methodSize + 2 + baseOffsetSize;
    const extentCount = uint(bytes, offset, 2);
    offset += 2;
    if (id === wantedId) {
      return [
        baseOffset + uint(bytes, offset + indexSize, offsetSize),
        uint(bytes, offset + indexSize + offsetSize, lengthSize),
      ];
    }
    offset += extentCount * extentSize;
  }
  return null;
}

/** The top-level `meta` box, read whole, walking box headers past `mdat`. */
async function readMetaBox(reader: ByteRangeReader): Promise<Uint8Array | null> {
  let at = 0;
  while (at + 8 <= reader.size) {
    const head = await reader.read(at, 16);
    if (head.length < 8) return null;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let length = dv.getUint32(0);
    if (length === 1) length = head.length < 16 ? 0 : Number(dv.getBigUint64(8));
    else if (length === 0) length = reader.size - at;
    if (length < 8 || at + length > reader.size) return null;
    if (latin1(head, 4, 8) === 'meta') return reader.read(at, length);
    at += length;
  }
  return null;
}

/** The Exif item's `[offset, length]` extent inside a `meta` box, or null. */
function exifItemExtent(meta: Uint8Array): [number, number] | null {
  try {
    const box = boxHead(meta, 0);
    const children = box.start + 4;
    const iinf = findBox(meta, children, box.length, 'iinf');
    const iloc = findBox(meta, children, box.length, 'iloc');
    const itemId = iinf && iloc ? exifItemId(meta, iinf) : null;
    return iloc && itemId !== null ? exifExtent(meta, iloc, itemId) : null;
  } catch {
    return null;
  }
}

async function heifBlock(reader: ByteRangeReader): Promise<TiffBlock | null> {
  const meta = await readMetaBox(reader);
  const extent = meta && exifItemExtent(meta);
  if (!extent) return null;
  const [offset, length] = extent;
  const nameSize = await reader.read(offset, 4);
  if (nameSize.length < 4) return null;
  const shift = 4 + new DataView(nameSize.buffer, nameSize.byteOffset).getUint32(0);
  if (length <= shift || offset + length > reader.size) return null;
  return { base: offset + shift, end: offset + length };
}

/**
 * The raw ExifIFD capture-date strings of a JPEG, TIFF-family, PNG, WebP or
 * HEIF file, or null when `reader` is none of those (the caller dates it
 * another way). A recognised file with no usable date yields an empty object.
 */
export async function readRawCaptureDates(
  reader: ByteRangeReader,
): Promise<RawCaptureDates | null> {
  const magic = await reader.read(0, 12);
  let block: TiffBlock | null;
  if (magic[0] === 0xff && magic[1] === 0xd8) block = await jpegBlock(reader);
  else if ((magic[0] === 0x49 && magic[1] === 0x49) || (magic[0] === 0x4d && magic[1] === 0x4d)) {
    block = { base: 0, end: reader.size };
  } else if (latin1(magic, 0, 8) === '\x89PNG\r\n\x1a\n') block = await pngBlock(reader);
  else if (latin1(magic, 0, 4) === 'RIFF' && latin1(magic, 8, 12) === 'WEBP') {
    block = await webpBlock(reader);
  } else if (magic.length >= 8 && latin1(magic, 4, 8) === 'ftyp') block = await heifBlock(reader);
  else return null;
  return block ? readTiffDates(reader, block) : {};
}
