import type { ByteSource } from './byte-source.ts';

/** One ISO-BMFF box header. `size` 0 is the open-ended "runs to the end" form. */
interface BoxHeader {
  type: string;
  size: number;
  headerSize: number;
}

export async function readBoxHeader(
  source: ByteSource,
  offset: number,
  end: number,
): Promise<BoxHeader | null> {
  if (end - offset < 8) return null;
  const head = await source.read(offset, 8);
  if (!head) return null;
  const size = head.readUInt32BE(0);
  const type = head.toString('latin1', 4, 8);
  if (size !== 1) return { type, size, headerSize: 8 };
  if (end - offset < 16) return null;
  const extended = await source.read(offset + 8, 8);
  const large = extended?.readBigUInt64BE(0);
  return large === undefined || large > BigInt(Number.MAX_SAFE_INTEGER)
    ? null
    : { type, size: Number(large), headerSize: 16 };
}

const ALIGNMENT_BOXES = new Set(['free', 'skip', 'wide']);
const MAX_LEADING_BOXES = 8;
const HEADER_SCAN_BYTES = 64 * 1024;

/**
 * True when `[start, start + length)` begins with a real `ftyp` box, allowing
 * only a few leading alignment boxes before it. Anything else at the offset —
 * the stale metadata of an edited photo pointing into image bytes, or a
 * truncated clip — fails here before its size field is trusted.
 */
export async function startsWithFtyp(
  source: ByteSource,
  start: number,
  length: number,
): Promise<boolean> {
  const end = start + length;
  const scanEnd = start + Math.min(length, HEADER_SCAN_BYTES);
  const visit = async (offset: number, index: number): Promise<boolean> => {
    if (index >= MAX_LEADING_BOXES || offset >= scanEnd) return false;
    const box = await readBoxHeader(source, offset, end);
    if (!box || (box.type !== 'ftyp' && !ALIGNMENT_BOXES.has(box.type))) return false;
    if (box.size < box.headerSize || box.size > end - offset) return false;
    return box.type === 'ftyp' || visit(offset + box.size, index + 1);
  };
  return visit(start, 0);
}

/** A box inside a buffered region: its type and payload span (header excluded). */
export interface Span {
  type: string;
  start: number;
  end: number;
}

export function uintAt(buf: Buffer, offset: number, width: number): number | null {
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
// Uncapped: a tiled HEIC lists hundreds of items, and every box is at least 8 bytes.
export function childBoxes(buf: Buffer, start: number, end: number): Span[] {
  const found: Span[] = [];
  for (let offset = start; end - offset >= 8; ) {
    const size = buf.readUInt32BE(offset);
    const headerSize = size === 1 ? 16 : 8;
    const total = size === 1 ? uintAt(buf, offset + 8, 8) : size === 0 ? end - offset : size;
    if (total === null || total < headerSize || total > end - offset) return found;
    found.push({
      type: buf.toString('latin1', offset + 4, offset + 8),
      start: offset + headerSize,
      end: offset + total,
    });
    offset += total;
  }
  return found;
}
