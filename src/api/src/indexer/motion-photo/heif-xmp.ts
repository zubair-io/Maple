import type { ByteSource } from './byte-source.ts';
import { readBoxHeader } from './iso-bmff.ts';

const MAX_TOP_LEVEL_BOXES = 32;
const MAX_META_BYTES = 1024 * 1024;
const MAX_XMP_BYTES = 1024 * 1024;
const XMP_CONTENT_TYPE = 'application/rdf+xml';

interface Span {
  type: string;
  start: number;
  end: number;
}

function uintAt(buf: Buffer, offset: number, width: number): number | null {
  if (offset < 0 || offset + width > buf.length) return null;
  if (width === 0) return 0;
  if (width === 2) return buf.readUInt16BE(offset);
  if (width === 4) return buf.readUInt32BE(offset);
  if (width === 8) {
    const big = buf.readBigUInt64BE(offset);
    return big > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(big);
  }
  return null;
}

/** Child boxes of a buffer region; stops at the first malformed header. */
function childBoxes(buf: Buffer, start: number, end: number): Span[] {
  const walk = (offset: number, found: Span[]): Span[] => {
    if (end - offset < 8 || found.length >= 64) return found;
    const size = buf.readUInt32BE(offset);
    const headerSize = size === 1 ? 16 : 8;
    const total = size === 1 ? uintAt(buf, offset + 8, 8) : size === 0 ? end - offset : size;
    if (total === null || total < headerSize || total > end - offset) return found;
    const box = {
      type: buf.toString('latin1', offset + 4, offset + 8),
      start: offset + headerSize,
      end: offset + total,
    };
    return walk(offset + total, [...found, box]);
  };
  return walk(start, []);
}

function cString(buf: Buffer, offset: number, end: number): { value: string; next: number } | null {
  const terminator = buf.indexOf(0, offset);
  return terminator < 0 || terminator >= end
    ? null
    : { value: buf.toString('utf8', offset, terminator), next: terminator + 1 };
}

/** The item id of the XMP `mime` item declared by an `infe` box, version 2 or 3. */
function xmpItemId(buf: Buffer, infe: Span): number | null {
  const version = buf[infe.start];
  if (version !== 2 && version !== 3) return null;
  const idWidth = version === 3 ? 4 : 2;
  const idOffset = infe.start + 4;
  const id = uintAt(buf, idOffset, idWidth);
  const typeOffset = idOffset + idWidth + 2;
  if (id === null || typeOffset + 4 > infe.end) return null;
  if (buf.toString('latin1', typeOffset, typeOffset + 4) !== 'mime') return null;
  const name = cString(buf, typeOffset + 4, infe.end);
  const contentType = name ? cString(buf, name.next, infe.end) : null;
  return contentType?.value === XMP_CONTENT_TYPE ? id : null;
}

function findXmpItemId(buf: Buffer, iinf: Span): number | null {
  const version = buf[iinf.start];
  const entriesStart = iinf.start + 4 + (version === 0 ? 2 : 4);
  const ids = childBoxes(buf, entriesStart, iinf.end)
    .filter((box) => box.type === 'infe')
    .map((infe) => xmpItemId(buf, infe))
    .filter((id): id is number => id !== null);
  return ids[0] ?? null;
}

interface Extent {
  offset: number;
  length: number;
}

interface ItemLocation {
  constructionMethod: number;
  extents: Extent[];
}

interface IlocLayout {
  version: number;
  offsetWidth: number;
  lengthWidth: number;
  baseWidth: number;
  indexWidth: number;
}

function readExtents(
  buf: Buffer,
  layout: IlocLayout,
  start: number,
  count: number,
  base: number,
): { extents: Extent[]; next: number } | null {
  const extentSize = layout.indexWidth + layout.offsetWidth + layout.lengthWidth;
  const extents = Array.from({ length: count }, (_, index) => {
    const at = start + index * extentSize + layout.indexWidth;
    const offset = uintAt(buf, at, layout.offsetWidth);
    const length = uintAt(buf, at + layout.offsetWidth, layout.lengthWidth);
    return offset === null || length === null || length === 0
      ? null
      : { offset: base + offset, length };
  });
  return extents.every((extent) => extent !== null)
    ? { extents: extents as Extent[], next: start + count * extentSize }
    : null;
}

// fallow-ignore-next-line complexity
function findItemLocation(buf: Buffer, iloc: Span, itemId: number): ItemLocation | null {
  const version = buf[iloc.start]!;
  if (version > 2 || iloc.start + 6 > iloc.end) return null;
  const sizes = buf[iloc.start + 4]!;
  const bases = buf[iloc.start + 5]!;
  const layout: IlocLayout = {
    version,
    offsetWidth: sizes >> 4,
    lengthWidth: sizes & 0xf,
    baseWidth: bases >> 4,
    indexWidth: version === 0 ? 0 : bases & 0xf,
  };
  const idWidth = version === 2 ? 4 : 2;
  const count = uintAt(buf, iloc.start + 6, idWidth);
  if (count === null) return null;
  const visit = (offset: number, remaining: number): ItemLocation | null => {
    if (remaining === 0) return null;
    const id = uintAt(buf, offset, idWidth);
    const methodWidth = version === 0 ? 0 : 2;
    const method = version === 0 ? 0 : uintAt(buf, offset + idWidth, 2);
    const dataReference = uintAt(buf, offset + idWidth + methodWidth, 2);
    const baseAt = offset + idWidth + methodWidth + 2;
    const base = uintAt(buf, baseAt, layout.baseWidth);
    const extentCount = uintAt(buf, baseAt + layout.baseWidth, 2);
    if (id === null || method === null || dataReference === null) return null;
    if (base === null || extentCount === null) return null;
    const read = readExtents(buf, layout, baseAt + layout.baseWidth + 2, extentCount, base);
    if (!read) return null;
    if (id !== itemId) return visit(read.next, remaining - 1);
    return dataReference === 0 ? { constructionMethod: method & 0xf, extents: read.extents } : null;
  };
  return visit(iloc.start + 6 + idWidth, count);
}

async function findMetaBox(source: ByteSource): Promise<{ start: number; size: number } | null> {
  const visit = async (offset: number, index: number) => {
    if (index >= MAX_TOP_LEVEL_BOXES) return null;
    const box = await readBoxHeader(source, offset, source.size);
    if (!box || box.size === 0 || box.size < box.headerSize) return null;
    if (box.type === 'meta') return { start: offset, size: box.size };
    return visit(offset + box.size, index + 1);
  };
  return visit(0, 0);
}

async function readExtentBytes(
  source: ByteSource,
  meta: Buffer,
  idat: Span | undefined,
  location: ItemLocation,
): Promise<Buffer | null> {
  const total = location.extents.reduce((sum, extent) => sum + extent.length, 0);
  if (total > MAX_XMP_BYTES || location.extents.length === 0) return null;
  if (location.constructionMethod === 1) {
    if (!idat) return null;
    const parts = location.extents.map((extent) =>
      extent.offset + extent.length <= idat.end - idat.start
        ? meta.subarray(idat.start + extent.offset, idat.start + extent.offset + extent.length)
        : null,
    );
    return parts.every((part) => part !== null) ? Buffer.concat(parts as Buffer[]) : null;
  }
  if (location.constructionMethod !== 0) return null;
  const parts = await Promise.all(
    location.extents.map((extent) => source.read(extent.offset, extent.length)),
  );
  return parts.every((part) => part !== null) ? Buffer.concat(parts as Buffer[]) : null;
}

/**
 * The XMP packet of a HEIF still: the `mime` item whose content type is
 * `application/rdf+xml`, located through the `meta` box's `iinf` and `iloc`.
 * Reads the top-level box headers, the `meta` box (at most 1 MB) and the
 * item's own extents (at most 1 MB) — never the coded image.
 */
export async function readHeifXmp(source: ByteSource): Promise<string | null> {
  const metaBox = await findMetaBox(source);
  if (!metaBox || metaBox.size > MAX_META_BYTES) return null;
  const meta = await source.read(metaBox.start, metaBox.size);
  if (!meta) return null;
  const header = await readBoxHeader(source, metaBox.start, source.size);
  if (!header) return null;
  const children = childBoxes(meta, header.headerSize + 4, meta.length);
  const iinf = children.find((box) => box.type === 'iinf');
  const iloc = children.find((box) => box.type === 'iloc');
  if (!iinf || !iloc) return null;
  const itemId = findXmpItemId(meta, iinf);
  const location = itemId === null ? null : findItemLocation(meta, iloc, itemId);
  if (!location) return null;
  const idat = children.find((box) => box.type === 'idat');
  const bytes = await readExtentBytes(source, meta, idat, location);
  return bytes ? bytes.toString('utf8') : null;
}
