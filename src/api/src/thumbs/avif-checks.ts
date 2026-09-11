/**
 * Post-encode validation of an AVIF this pipeline wrote (see the doc comment
 * in `validate-avif.ts`). Checks run cheapest-first: container/dimensions/
 * orientation from the header probe, then a full pixel decode last. Maple
 * decodes AVIF with a pure-Rust AV1 decoder (#3496); the retired sharp
 * version also checked `space`/ICC, which our encoder never writes, so those
 * checks are gone with it.
 *
 * `raw_ffi.child.ts` is this module's only runtime consumer — it's imported
 * at module scope there so no PRODUCTION code in the API parent process
 * loads the native bitmap bindings. (Tests import it freely to exercise the
 * predicate directly.)
 */

import { maple } from 'maple';

/** AVIF encoders can round dimensions by a pixel or two during resize — this
 * is slack on the upper bound, not a target every output must hit exactly
 * (a source smaller than the tier's target is never upscaled). */
const DIMENSION_TOLERANCE_PX = 4;

export type AvifValidationResult = { ok: true } | { ok: false; reason: string };

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Decode `filePath` and confirm it's a genuine, complete, correctly-sized
 * AVIF matching this pipeline's encode conventions. Checks run cheapest
 * (metadata-only) to most expensive (a full pixel decode):
 *
 *  1. Format: Maple's metadata probe must report `avif` — confirming this is
 *     genuinely AVIF, not e.g. a HEIC file or non-image bytes with an
 *     `.avif` extension.
 *  2. Dimensions: both the width and height must be within
 *     `DIMENSION_TOLERANCE_PX` of `expectedLongEdgePx` — an upper bound
 *     only, since `fit: 'inside', withoutEnlargement: true` (this pipeline's
 *     resize contract) legitimately leaves a source smaller than the target
 *     un-upscaled.
 *  3. Orientation: every encoder in this pipeline bakes EXIF orientation
 *     into pixels at encode time (raw-ffi's `bake_orientation`, Maple's
 *     `.rotate()`) and never carries an orientation tag forward — see
 *     `thumbs/apply-orientation.ts`'s module doc. A tag other than `1` here
 *     means some path landed a cache entry that still depends on a tag no
 *     reader (server route, Apple, web) applies.
 *  4. Integrity: a full pixel decode must succeed. `.metadata()` alone is
 *     NOT sufficient — it can return a plausible width/height read straight
 *     from the AVIF's meta/header box even when the pixel payload is
 *     truncated. Catching a truncated/corrupt encode requires forcing a real
 *     decode of the pixel data, not just parsing the header. Deliberately
 *     LAST: it's the only check that pulls the full image into memory, so
 *     every cheap metadata-only check — especially the dimension bound —
 *     must reject first for a wildly-oversized input.
 */
export async function checkAvifOutput(
  filePath: string,
  expectedLongEdgePx: number,
): Promise<AvifValidationResult> {
  const image = maple(filePath);
  const meta = await image.metadata().catch((e: unknown) => ({ error: errMessage(e) }) as const);
  if ('error' in meta) {
    return { ok: false, reason: `metadata decode failed: ${meta.error}` };
  }
  if (meta.format !== 'avif') {
    return { ok: false, reason: `unexpected format "${meta.format || 'unknown'}" (expected avif)` };
  }
  if (!meta.width || !meta.height) {
    return { ok: false, reason: 'metadata missing width/height' };
  }
  const maxAllowed = expectedLongEdgePx + DIMENSION_TOLERANCE_PX;
  if (meta.width > maxAllowed || meta.height > maxAllowed) {
    return {
      ok: false,
      reason: `dimensions ${meta.width}x${meta.height} exceed expected long edge ${expectedLongEdgePx} (+${DIMENSION_TOLERANCE_PX}px tolerance)`,
    };
  }
  if (meta.orientation !== 1) {
    return {
      ok: false,
      reason: `unexpected orientation tag ${meta.orientation} — this pipeline bakes rotation into pixels and writes no orientation tag`,
    };
  }
  const intact = await image.validateIntegrity();
  return intact
    ? { ok: true }
    : { ok: false, reason: 'pixel decode failed (truncated or corrupt)' };
}
