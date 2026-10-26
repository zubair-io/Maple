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
