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
export const TAG_PRIMARY = 0x01;
/** First byte of a fallback-form id. */
export const TAG_FALLBACK = 0x02;

/** Number of leading bytes that feed sha1Head. */
export const SHA1_HEAD_BYTES = 64 * 1024;

export type IdKind = 'primary' | 'fallback';

export interface MapleId {
  readonly bytes: Uint8Array;
  readonly hex: string;
  readonly kind: IdKind;
}

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
  const sha1Full = sha1(bytes);
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

/**
 * Disk-side helper: read the first 64 KB of a file, stat it, and produce
 * the fields the discover watcher needs to insert an asset row with
 * `maple_id` populated.
 *
 * Returned shape mirrors what the legacy `hash` worker stage wrote to the
 * doc — `(maple_id, sha1_head, size, mtime)` — so callers can stop running
 * the post-insert hash stage entirely. The id is in **fallback form**
 * (tag `0x02`): the exif stage upgrades it to primary form once
 * `captured_at` is available.
 *
 * Byte-for-byte parity with the previous hash-stage handler is enforced by
 * `id.test.ts` — same head slice (≤ 64 KB), same `deriveId(head, null,
 * null, null)` call. Changing this shape requires bumping the hash
 * stage's `targetVersion` so legacy rows re-derive.
 */
export async function hashFileForId(absPath: string): Promise<{
  maple_id: string;
  sha1_head: string;
  size: number;
  mtime: number;
}> {
  // Open once, read head AND stat off the same fd. If the path is replaced
  // between read and stat (rename / atomic swap), `fs.stat(absPath)` would
  // return fields from a different inode than the bytes we hashed; `fd.stat`
  // is inode-stable for the lifetime of the descriptor.
  const fd = await fs.open(absPath, 'r');
  let head: Uint8Array;
  let stat: Awaited<ReturnType<typeof fd.stat>>;
  try {
    const buf = new Uint8Array(SHA1_HEAD_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
    stat = await fd.stat();
  } finally {
    await fd.close();
  }
  const sha1_head = toHex(sha1(head));
  const id = deriveId(head, null, null, null);
  return { maple_id: id.hex, sha1_head, size: stat.size, mtime: stat.mtimeMs };
}

/** Parse a 32-char hex id back into bytes. */
export function fromHex(hex: string): MapleId {
  if (hex.length !== 32) {
    throw new Error(`maple:id: expected 32 hex chars, got ${hex.length}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) {
      throw new Error(`maple:id: invalid hex digit near index ${i * 2}`);
    }
    out[i] = byte;
  }
  return {
    bytes: out,
    hex: hex.toLowerCase(),
    kind: out[0] === TAG_PRIMARY ? 'primary' : 'fallback',
  };
}
