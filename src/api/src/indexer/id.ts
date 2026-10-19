/**
 * Maple stable image id — byte-for-byte parity with raw-core's `MapleId`.
 *
 * Spec §04:
 *   primary  = 0x01 || BLAKE3( SHA1(first 64 KB) || CaptureDateTimeOriginal
 *              || camera_serial || shutter_count_le_u64 )[..15]
 *   fallback = 0x02 || BLAKE3( SHA1(full_bytes) || filesize_le_u64 )[..15]
 *
 * Output: 16 bytes, hex-encoded lowercase (32 chars).
 */

import * as fs from 'node:fs/promises';
import { blake3 } from '@noble/hashes/blake3.js';
import { sha1 } from '@noble/hashes/legacy.js';

/** First byte of a primary-form id. */
const TAG_PRIMARY = 0x01;
/** First byte of a fallback-form id. */
const TAG_FALLBACK = 0x02;

/** Number of leading bytes that feed sha1Head. */
export const SHA1_HEAD_BYTES = 64 * 1024;

import type { MapleId } from '../../../web/projects/maple-common/src/lib/addressing/maple-id-parser.ts';
export {
  fromHex,
  isMapleId,
} from '../../../web/projects/maple-common/src/lib/addressing/maple-id-parser.ts';
export type { MapleId } from '../../../web/projects/maple-common/src/lib/addressing/maple-id-parser.ts';

function toLeU64(n: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  const big = typeof n === 'bigint' ? n : BigInt(n);
  view.setBigUint64(0, big, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0');
  }
  return s;
}

function makeId(tag: number, digest: Uint8Array): MapleId {
  const out = new Uint8Array(16);
  out[0] = tag;
  out.set(digest.subarray(0, 15), 1);
  return {
    bytes: out,
    hex: toHex(out),
    kind: tag === TAG_PRIMARY ? 'primary' : 'fallback',
  };
}

/**
 * Primary-form id. `bytes` should cover at least the first 64 KB of the
 * file; extra bytes are ignored for the primary derivation.
 */
export function primary(
  bytes: Uint8Array,
  captureDateTimeOriginal: string,
  cameraSerial: string | null,
  shutterCount: bigint | number | null,
): MapleId {
  const headLen = Math.min(bytes.length, SHA1_HEAD_BYTES);
  const sha1Head = sha1(bytes.subarray(0, headLen));

  const ts = new TextEncoder().encode(captureDateTimeOriginal);
  const serial = cameraSerial !== null ? new TextEncoder().encode(cameraSerial) : new Uint8Array(0);
  const count = toLeU64(shutterCount ?? 0);

  const digest = blake3(concat([sha1Head, ts, serial, count]));
  return makeId(TAG_PRIMARY, digest);
}

/**
 * Fallback-form id. SHA-1 over full bytes, BLAKE3 over that || filesize.
 */
export function fallback(bytes: Uint8Array, filesize: bigint | number): MapleId {
  return fallbackFromSha1(sha1(bytes), filesize);
}

function fallbackFromSha1(sha1Full: Uint8Array, filesize: bigint | number): MapleId {
  const size = toLeU64(filesize);
  const digest = blake3(concat([sha1Full, size]));
  return makeId(TAG_FALLBACK, digest);
}

/**
 * Pick primary if a capture timestamp is available, else fallback.
 * Mirrors `raw-core::id::maple_id`.
 */
export function deriveId(
  bytes: Uint8Array,
  capturedAt: string | null,
  cameraSerial: string | null,
  shutterCount: bigint | number | null,
): MapleId {
  return capturedAt !== null
    ? primary(bytes, capturedAt, cameraSerial, shutterCount)
    : fallback(bytes, bytes.length);
}

const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * Disk-side helper: stream a file once, stat it, and produce the fields the
 * discover watcher needs to insert an asset row with `maple_id` populated.
 *
 * The id is in **fallback form** (tag `0x02`) over the full file and its real
 * size, matching raw-core, Swift and the browser; `sha1_head` still covers only
 * the first 64 KB. The exif stage upgrades the id to primary form once
 * `captured_at` is available, and re-derives legacy head-only fallback ids
 * (`EXIF_STAGE_VERSION` 3).
 */
export async function hashFileForId(absPath: string): Promise<{
  maple_id: string;
  sha1_head: string;
  size: number;
  mtime: number;
}> {
  // Hash and stat off one fd: if the path is swapped mid-read, `fs.stat(absPath)`
  // would describe a different inode than the bytes we hashed.
  const fd = await fs.open(absPath, 'r');
  try {
    const full = sha1.create();
    const buf = new Uint8Array(HASH_CHUNK_BYTES);
    const headChunks: Uint8Array[] = [];
    let headLen = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      full.update(chunk);
      if (headLen < SHA1_HEAD_BYTES) {
        const take = chunk.subarray(0, SHA1_HEAD_BYTES - headLen);
        headChunks.push(take.slice());
        headLen += take.length;
      }
      position += bytesRead;
    }
    const stat = await fd.stat();
    const id = fallbackFromSha1(full.digest(), position);
    return {
      maple_id: id.hex,
      sha1_head: toHex(sha1(concat(headChunks))),
      size: stat.size,
      mtime: stat.mtimeMs,
    };
  } finally {
    await fd.close();
  }
}
