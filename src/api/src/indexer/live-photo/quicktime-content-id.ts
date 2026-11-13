import type { ByteSource } from '../motion-photo/byte-source.ts';
import { childBoxes, readBoxHeader, uintAt, type Span } from '../motion-photo/iso-bmff.ts';

const CONTENT_IDENTIFIER_KEY = 'com.apple.quicktime.content.identifier';
const MAX_TOP_LEVEL_BOXES = 32;
const MAX_CONTAINER_BYTES = 1024 * 1024;
const MAX_KEYS = 256;
const UTF8_DATA_TYPE = 1;

/** The `mdta` key table: the 1-based index of the content-identifier key, or null. */
function contentIdentifierIndex(meta: Buffer, keys: Span): number | null {
  const count = uintAt(meta, keys.start + 4, 4);
  if (count === null) return null;
  const walk = (offset: number, index: number): number | null => {
    if (index > Math.min(count, MAX_KEYS)) return null;
    const size = uintAt(meta, offset, 4);
    if (size === null || size < 8 || offset + size > keys.end) return null;
    const namespace = meta.toString('latin1', offset + 4, offset + 8);
    const name = meta.toString('utf8', offset + 8, offset + size);
    return namespace === 'mdta' && name === CONTENT_IDENTIFIER_KEY
      ? index
      : walk(offset + size, index + 1);
  };
  return walk(keys.start + 8, 1);
}

/** The itemlist entry for key `index`: its type is that index as a big-endian integer. */
function utf8Value(meta: Buffer, ilst: Span, index: number): string | null {
  const itemType = Buffer.alloc(4);
  itemType.writeUInt32BE(index);
  const item = childBoxes(meta, ilst.start, ilst.end).find(
    (box) => box.type === itemType.toString('latin1'),
  );
  const data = item && childBoxes(meta, item.start, item.end).find((box) => box.type === 'data');
  if (!data || data.end - data.start <= 8) return null;
  return uintAt(meta, data.start, 4) === UTF8_DATA_TYPE
    ? meta.toString('utf8', data.start + 8, data.end)
    : null;
}

/**
 * The `mdta` metadata box of a QuickTime file holds its keys; classic QuickTime
 * writes it without the ISO full-box version and flags that precede its first child.
 */
function identifierInMeta(payload: Buffer): string | null {
  const firstChild = payload.toString('latin1', 4, 8) === 'hdlr' ? 0 : 4;
  const children = childBoxes(payload, firstChild, payload.length);
  const keys = children.find((box) => box.type === 'keys');
  const ilst = children.find((box) => box.type === 'ilst');
  const index = keys ? contentIdentifierIndex(payload, keys) : null;
  return ilst && index !== null ? utf8Value(payload, ilst, index) : null;
}

async function metaPayloads(source: ByteSource): Promise<Buffer[]> {
  const found: Buffer[] = [];
  const visit = async (offset: number, index: number): Promise<void> => {
    if (index >= MAX_TOP_LEVEL_BOXES) return;
    const box = await readBoxHeader(source, offset, source.size);
    if (!box) return;
    const size = box.size === 0 ? source.size - offset : box.size;
    if (size < box.headerSize) return;
    if ((box.type === 'moov' || box.type === 'meta') && size <= MAX_CONTAINER_BYTES) {
      const whole = await source.read(offset, size);
      if (whole && box.type === 'meta') found.push(whole.subarray(box.headerSize));
      if (whole && box.type === 'moov') {
        childBoxes(whole, box.headerSize, whole.length)
          .filter((child) => child.type === 'meta')
          .forEach((child) => found.push(whole.subarray(child.start, child.end)));
      }
    }
    await visit(offset + size, index + 1);
  };
  await visit(0, 0);
  return found;
}

/**
 * Apple's Live Photo content identifier from a QuickTime clip: the
 * `com.apple.quicktime.content.identifier` entry of the `mdta` key table in
 * `moov/meta` (or a top-level `meta`). Reads top-level box headers and the
 * metadata containers (at most 1 MB each), never the media data.
 */
export async function readQuickTimeContentIdentifier(source: ByteSource): Promise<string | null> {
  const payloads = await metaPayloads(source);
  return payloads.map(identifierInMeta).find((value) => value !== null) ?? null;
}
