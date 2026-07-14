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
// DELIBERATE DUPLICATE: this is a byte-for-byte port of the pure functions in
// `src/api/src/indexer/id.ts` (primary/fallback/deriveId/toHex/concat/toLeU64/
// fromHex). That file also exports `hashFileForId`, which opens a fd via
// `node:fs/promises` — a Node-only API that has no browser equivalent and
// would break ng-packagr's library build if imported from `maple-common`. The
// pure hashing functions have no such dependency, but re-importing them from
// `src/api` isn't possible either: `src/api` and `src/web` are separate
// packages/runtimes in this monorepo (api targets Bun, web targets the
// browser) with no shared-source mechanism between them. This module is kept
// in sync with `id.ts` BY CONVENTION, the same category as this repo's other
// confirmed "independently implemented, byte-identical by convention" pairs
// (e.g. the Swift CIEDE2000 port cross-validated against
// `compare_images.py`). `maple-id.spec.ts` proves parity against `id.ts`'s
// `primary()` output for identical inputs.
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

/** Parse a 32-char hex id back into bytes. */
export function fromHex(hex: string): MapleId {
  if (hex.length !== 32) {
    throw new Error(`maple:id: expected 32 hex chars, got ${hex.length}`);
  }
  // `Number.parseInt` accepts a PARTIALLY valid string — `parseInt('0g', 16)`
  // is `0`, not `NaN` (it parses the leading valid digits and silently stops
  // at the first invalid one), so a per-byte `!Number.isFinite(byte)` check
  // never actually catches a malformed pair like "0g" or "f!". `raw-core`'s
  // reference `from_hex` validates every nibble strictly and rejects any of
  // them; this port must match that, not silently accept garbage as if it
  // were a real byte. Validating the whole string up front against a strict
  // hex-only pattern closes that gap in one place, before any parsing.
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error('maple:id: invalid hex digit');
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return {
    bytes: out,
    hex: hex.toLowerCase(),
    kind: out[0] === TAG_PRIMARY ? 'primary' : 'fallback',
  };
}
