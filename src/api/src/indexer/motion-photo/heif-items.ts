import type { ByteSource } from './byte-source.ts';
import { childBoxes, readBoxHeader, uintAt, type Span } from './iso-bmff.ts';

const MAX_TOP_LEVEL_BOXES = 32;
const MAX_META_BYTES = 1024 * 1024;
const MAX_ITEM_BYTES = 1024 * 1024;
const XMP_CONTENT_TYPE = 'application/rdf+xml';

function cString(buf: Buffer, offset: number, end: number): { value: string; next: number } | null {
  const terminator = buf.indexOf(0, offset);
  return terminator < 0 || terminator >= end
    ? null
    : { value: buf.toString('utf8', offset, terminator), next: terminator + 1 };
}

/** The metadata items of a HEIF still this reader can extract. */
export type HeifItemKind = 'xmp' | 'exif';

/** The item id of an `infe` box (version 2 or 3) declaring an item of the wanted kind. */
function wantedItemId(buf: Buffer, infe: Span, kind: HeifItemKind): number | null {
  const version = buf[infe.start];
  if (version !== 2 && version !== 3) return null;
  const idWidth = version === 3 ? 4 : 2;
  const idOffset = infe.start + 4;
  const id = uintAt(buf, idOffset, idWidth);
  const typeOffset = idOffset + idWidth + 2;
  if (id === null || typeOffset + 4 > infe.end) return null;
  const itemType = buf.toString('latin1', typeOffset, typeOffset + 4);
  if (kind === 'exif') return itemType === 'Exif' ? id : null;
  if (itemType !== 'mime') return null;
  const name = cString(buf, typeOffset + 4, infe.end);
  const contentType = name ? cString(buf, name.next, infe.end) : null;
  return contentType?.value === XMP_CONTENT_TYPE ? id : null;
}

function findItemId(buf: Buffer, iinf: Span, kind: HeifItemKind): number | null {
  const version = buf[iinf.start];
  const entriesStart = iinf.start + 4 + (version === 0 ? 2 : 4);
  const ids = childBoxes(buf, entriesStart, iinf.end)
    .filter((box) => box.type === 'infe')
    .map((infe) => wantedItemId(buf, infe, kind))
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
  const entry = (offset: number) => {
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
    return read && { id, method, dataReference, ...read };
  };
  // A loop, not recursion: the item count is untrusted and can run to 2^32.
  for (let remaining = count, offset = iloc.start + 6 + idWidth; remaining > 0; remaining -= 1) {
    const item = entry(offset);
    if (!item) return null;
    if (item.id === itemId) {
      return item.dataReference === 0
        ? { constructionMethod: item.method & 0xf, extents: item.extents }
        : null;
    }
    offset = item.next;
  }
  return null;
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
  if (total > MAX_ITEM_BYTES || location.extents.length === 0) return null;
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
 * The bytes of a HEIF still's metadata item: the `mime` item whose content
 * type is `application/rdf+xml` (`xmp`) or the `Exif` item (`exif`), located
 * through the `meta` box's `iinf` and `iloc`. Reads the top-level box headers,
 * the `meta` box (at most 1 MB) and the item's own extents (at most 1 MB) —
 * never the coded image.
 */
export async function readHeifItem(source: ByteSource, kind: HeifItemKind): Promise<Buffer | null> {
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
  const itemId = findItemId(meta, iinf, kind);
  const location = itemId === null ? null : findItemLocation(meta, iloc, itemId);
  if (!location) return null;
  const idat = children.find((box) => box.type === 'idat');
  return readExtentBytes(source, meta, idat, location);
}

/** The XMP packet of a HEIF still. */
export async function readHeifXmp(source: ByteSource): Promise<string | null> {
  const bytes = await readHeifItem(source, 'xmp');
  return bytes ? bytes.toString('utf8') : null;
}
