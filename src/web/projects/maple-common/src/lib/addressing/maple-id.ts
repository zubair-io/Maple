// Maple stable image id — byte-for-byte parity with raw-core's `MapleId` and
// the server's `src/api/src/indexer/id.ts` (#1995).
//
// Spec §04:
//   primary  = 0x01 || BLAKE3( SHA1(first 64 KB) || CaptureDateTimeOriginal
//              || camera_serial || shutter_count_le_u64 )[..15]
//   fallback = 0x02 || BLAKE3( SHA1(full_bytes) || filesize_le_u64 )[..15]
//
// Output: 16 bytes, hex-encoded lowercase (32 chars).
//
// Hashing adapters retain their existing derivation policy. Parsing is shared
// with the API through the dependency-free maple-id-parser module.
//
// `fallback()` below still exists for small/in-memory buffers (tests, and
// any small-file case), but the browser's real fallback-form path does NOT
// call it: a 100+ MB RAW can't be held as one contiguous in-memory buffer
// without defeating the point of chunked `File.slice()` reads. See
// `maple-id-fallback-hasher.service.ts`, which streams a File's bytes through
// the WASM `FallbackIdHasher` (raw-wasm/src/id.rs) instead — it returns the
// same tagged, hex-encoded `MapleId.hex` shape this module produces, parseable
// back into a `MapleId` via `fromHex()`. The primary form never needs
// streaming: it only ever reads a bounded 64 KB head, which `primary()`
// below handles directly.

import { blake3 } from '@noble/hashes/blake3.js';
import { sha1 } from '@noble/hashes/legacy.js';

/** First byte of a primary-form id. */
export const TAG_PRIMARY = 0x01;
/** First byte of a fallback-form id. */
export const TAG_FALLBACK = 0x02;

/** Number of leading bytes that feed sha1Head. */
export const SHA1_HEAD_BYTES = 64 * 1024;

import type { MapleId } from './maple-id-parser';
export { fromHex, isMapleId } from './maple-id-parser';
export type { MapleId, IdKind } from './maple-id-parser';

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
 *
 * `sha1Full` is computed elsewhere for the browser path (streamed via the
 * WASM `FallbackIdHasher` over chunked `File.slice()` reads — see
 * `maple-id-fallback-hasher.service.ts`); this function stays available for
 * small buffers (tests, and any in-memory-file case) where a single-shot
 * SHA-1 is cheap.
 */
export function fallback(bytes: Uint8Array, filesize: bigint | number): MapleId {
  const sha1Full = sha1(bytes);
  const size = toLeU64(filesize);
  const digest = blake3(concat([sha1Full, size]));
  return makeId(TAG_FALLBACK, digest);
}

/**
 * Pick primary if a capture timestamp is available, else fallback.
 * Mirrors `raw-core::id::maple_id` / `src/api/src/indexer/id.ts`'s `deriveId`.
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
