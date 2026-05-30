/**
 * HEIC / HEIF EXIF extraction.
 *
 * Why this module exists
 * ----------------------
 * exifr 7.1.3 (the final release — the package is effectively unmaintained)
 * refuses to parse HEICs whose `ftyp` box is longer than 50 bytes. Its
 * `HeifFileParser.canHandle` bails early:
 *
 *     let ftypLength = file.getUint16(2)
 *     if (ftypLength > 50) return false
 *
 * Modern iPhone HDR HEICs advertise ~9 compatible brands
 * (mif1/MiHB/MiHA/heix/MiHE/MiPr/miaf/heic/tmap), which pushes the `ftyp`
 * box to 52 bytes — two bytes over exifr's cap. exifr then reports
 * "Unknown file format" and never reaches its own (perfectly functional)
 * ISO-BMFF box walker, so every such photo lands in the index with no
 * capture date, camera, lens, or GPS.
 *
 * The fix
 * -------
 * exifr's box parsing is fine; only the `canHandle` gate is wrong, and exifr
 * does not export its parser internals so we cannot flip it. Instead we walk
 * the ISO base media file format boxes ourselves (`meta` → `iinf`/`infe` to
 * find the Exif item id, `meta` → `iloc` to find where its bytes live),
 * slice out the embedded TIFF block, and hand THAT to `exifr.parse()`. exifr
 * parses a bare TIFF buffer with no brand gating whatsoever, so all of the
 * existing pick-tag and GPS-sign handling in `readExif` keeps working
 * unchanged.
 *
 * The box-walk below is a faithful Buffer port of exifr's own
 * `HeifFileParser.findExif` / `findExifLocIdInIinf` / `findExtentInIloc`,
 * including the `4 + nameSize` shift that skips the Exif item's
 * `exif_tiff_header_offset` prefix (ISO/IEC 23008-12 §A.2.1) to land on the
 * "MM"/"II" TIFF header.
 *
 * Box format references: ISO/IEC 14496-12 (`meta`, `iinf`, `infe`, `iloc`).
 */

import * as fs from 'node:fs/promises';

/**
 * Thrown when a box or extent claims bytes past the end of the file we read.
 * That almost always means the file is still being copied into the library
 * (a truncated header), which is transient — `readExif` rethrows this so the
 * stage runner retries once the copy settles, rather than permanently
 * stamping `exif: null`.
 */
export class HeicTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeicTruncatedError';
  }
}

interface Box {
  /** Offset of the box header within the file. */
  offset: number;
  /** Total box length in bytes (header + body). */
  length: number;
  /** Four-character box type, e.g. 'meta'. */
  kind: string;
  /** Offset of the box body (first byte after the header). */
  start: number;
}

/** Read a big-endian unsigned integer of `size` bytes (0, 1, 2, 4, or 8). */
function getUintBytes(buf: Buffer, off: number, size: number): number {
  switch (size) {
    case 0:
      return 0;
    case 1:
      return buf.readUInt8(off);
    case 2:
      return buf.readUInt16BE(off);
    case 4:
      return buf.readUInt32BE(off);
    case 8:
      return Number(buf.readBigUInt64BE(off));
    default:
      throw new Error(`unsupported integer width ${size}`);
  }
}

/** Assert that byte range [off, off+len) lies inside the buffer. */
function need(buf: Buffer, off: number, len: number, what: string): void {
  if (off < 0 || off + len > buf.length) {
    throw new HeicTruncatedError(`${what}: need ${len} bytes at ${off}, file is ${buf.length}`);
  }
}

/** Parse a box header at `offset`. Handles the 64-bit `largesize` form. */
function parseBoxHead(buf: Buffer, offset: number): Box {
  need(buf, offset, 8, 'box header');
  let length = buf.readUInt32BE(offset);
  const kind = buf.toString('latin1', offset + 4, offset + 8);
  let start = offset + 8;
  if (length === 1) {
    need(buf, offset, 16, 'box largesize');
    length = Number(buf.readBigUInt64BE(offset + 8));
    start += 8;
  } else if (length === 0) {
    // Box runs to end-of-file.
    length = buf.length - offset;
  }
  if (length < start - offset) {
    throw new HeicTruncatedError(`box at ${offset} has length ${length} smaller than its header`);
  }
  return { offset, length, kind, start };
}

/** Iterate sibling boxes spanning [start, end), yielding each header. */
function* iterBoxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    const box = parseBoxHead(buf, offset);
    if (box.offset + box.length > end) {
      throw new HeicTruncatedError(
        `box '${box.kind}' at ${box.offset} length ${box.length} runs past ${end}`,
      );
    }
    yield box;
    offset = box.offset + box.length;
  }
}

/** First direct child box of `kind` within [start, end), or null. */
function findBox(buf: Buffer, start: number, end: number, kind: string): Box | null {
  for (const box of iterBoxes(buf, start, end)) {
    if (box.kind === kind) return box;
  }
  return null;
}

/** Version byte of a FullBox; its body content begins 4 bytes after `start`. */
function fullBoxVersion(buf: Buffer, box: Box): number {
  need(buf, box.start, 4, `${box.kind} full-box header`);
  return buf.readUInt32BE(box.start) >>> 24;
}

/**
 * Find the item id of the 'Exif' item by scanning `infe` entries in `iinf`.
 * Mirrors exifr's `findExifLocIdInIinf`.
 */
function findExifItemId(buf: Buffer, iinf: Box): number | null {
  const version = fullBoxVersion(buf, iinf);
  let offset = iinf.start + 4;
  need(buf, offset, 2, 'iinf entry count');
  // entry_count is 16-bit for version 0, 32-bit for version 1+.
  let count: number;
  if (version === 0) {
    count = buf.readUInt16BE(offset);
    offset += 2;
  } else {
    need(buf, offset, 4, 'iinf entry count');
    count = buf.readUInt32BE(offset);
    offset += 4;
  }
  const iinfEnd = iinf.offset + iinf.length;
  while (count-- > 0 && offset + 8 <= iinfEnd) {
    const infe = parseBoxHead(buf, offset);
    const infeVersion = fullBoxVersion(buf, infe);
    const contentStart = infe.start + 4;
    if (infeVersion >= 2) {
      const idSize = infeVersion === 3 ? 4 : 2;
      need(buf, contentStart, idSize + 2 + 4, 'infe item_type');
      const name = buf.toString('latin1', contentStart + idSize + 2, contentStart + idSize + 6);
      if (name === 'Exif') return getUintBytes(buf, contentStart, idSize);
    }
    offset = infe.offset + infe.length;
  }
  return null;
}

/**
 * Resolve [extentOffset, extentLength] for `wantedId` from the `iloc` box.
 * Mirrors exifr's `findExtentInIloc`. Only the single-extent / file-offset
 * (construction_method 0) layout that cameras emit is exercised; multi-extent
 * items take the first extent, matching exifr.
 */
function findExtent(buf: Buffer, iloc: Box, wantedId: number): [number, number] | null {
  const version = fullBoxVersion(buf, iloc);
  let offset = iloc.start + 4;
  need(buf, offset, 2, 'iloc size fields');
  const sizeByte = buf.readUInt8(offset++);
  const offsetSize = sizeByte >> 4;
  const lengthSize = sizeByte & 0xf;
  const baseByte = buf.readUInt8(offset++);
  const baseOffsetSize = baseByte >> 4;
  const indexSize = baseByte & 0xf;

  const itemIdSize = version === 2 ? 4 : 2;
  const constMethodSize = version === 1 || version === 2 ? 2 : 0;
  const extentSize = indexSize + offsetSize + lengthSize;
  const itemCountSize = version === 2 ? 4 : 2;

  need(buf, offset, itemCountSize, 'iloc item count');
  let itemCount = getUintBytes(buf, offset, itemCountSize);
  offset += itemCountSize;

  while (itemCount-- > 0) {
    need(buf, offset, itemIdSize + constMethodSize + 2 + baseOffsetSize + 2, 'iloc item');
    const itemId = getUintBytes(buf, offset, itemIdSize);
    // base_offset sits after item_id + construction_method + data_reference_index.
    const baseOffset = getUintBytes(buf, offset + itemIdSize + constMethodSize + 2, baseOffsetSize);
    offset += itemIdSize + constMethodSize + 2 + baseOffsetSize;
    const extentCount = buf.readUInt16BE(offset);
    offset += 2;
    if (itemId === wantedId) {
      need(buf, offset, indexSize + offsetSize + lengthSize, 'iloc extent');
      // The extent's absolute file offset is base_offset + extent_offset
      // (ISO/IEC 14496-12). Cameras usually leave base_offset_size 0, but
      // some encoders store a per-item base with extent_offset relative to
      // it — dropping the base slices the wrong bytes / false-throws.
      const extentOffset = getUintBytes(buf, offset + indexSize, offsetSize);
      const extentLength = getUintBytes(buf, offset + indexSize + offsetSize, lengthSize);
      return [baseOffset + extentOffset, extentLength];
    }
    offset += extentCount * extentSize;
  }
  return null;
}

/**
 * Locate the embedded TIFF block inside a HEIC/HEIF buffer.
 *
 * Returns the TIFF slice (starting at the "MM"/"II" byte-order marker) ready
 * to hand to `exifr.parse`, or null when the container has no Exif item.
 * Throws {@link HeicTruncatedError} when the file appears truncated.
 */
export function extractHeicExifTiff(buf: Buffer): Buffer | null {
  // A real HEIC/HEIF always opens with an `ftyp` box. Bail to null (rather
  // than throwing on a wild box length) when the bytes clearly aren't an
  // ISO-BMFF container, so a mislabelled `.heic` is treated as "no EXIF"
  // instead of an endlessly-retried truncation.
  if (buf.length < 8 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;

  const meta = findBox(buf, 0, buf.length, 'meta');
  if (!meta) return null;
  // `meta` is a FullBox: its child boxes begin after the 4-byte version/flags.
  const metaChildStart = meta.start + 4;
  const metaEnd = meta.offset + meta.length;

  const iinf = findBox(buf, metaChildStart, metaEnd, 'iinf');
  const iloc = findBox(buf, metaChildStart, metaEnd, 'iloc');
  if (!iinf || !iloc) return null;

  const exifId = findExifItemId(buf, iinf);
  if (exifId == null) return null;

  const extent = findExtent(buf, iloc, exifId);
  if (!extent) return null;
  const [exifOffset, exifLength] = extent;

  // The Exif item payload starts with a 4-byte `exif_tiff_header_offset`; the
  // TIFF header sits `4 + that` bytes in (exifr does the same).
  need(buf, exifOffset, 4, 'exif item header');
  const nameSize = buf.readUInt32BE(exifOffset);
  const shift = 4 + nameSize;
  const tiffOffset = exifOffset + shift;
  const tiffLength = exifLength - shift;
  if (tiffLength <= 0) return null;
  need(buf, tiffOffset, tiffLength, 'exif tiff block');
  return buf.subarray(tiffOffset, tiffOffset + tiffLength);
}

/**
 * Read `absPath` and return its embedded EXIF as a bare TIFF buffer, or null
 * when there is no Exif item. Throws on I/O errors and on truncation (both
 * transient — the caller retries).
 */
export async function readHeicExifTiff(absPath: string): Promise<Buffer | null> {
  const buf = await fs.readFile(absPath);
  return extractHeicExifTiff(buf);
}
