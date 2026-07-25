/**
 * Pure AVIF validation predicate — the actual decode-based checks, with no
 * knowledge of IPC, the imgdecode child, or the pool. `sharp` is imported
 * directly at module scope, so no PRODUCTION code in the API parent process may
 * import this module — `imgdecode.child.ts` is its only runtime consumer. (Tests
 * import it freely to exercise the predicate directly; a test process loading
 * sharp costs nothing that matters. `thumbs/validate-avif.ts` takes only an
 * `import type` from here, which erases at compile time and loads nothing.)
 * That split is what `thumbs/validate-avif.ts`
 * (the parent-side dispatcher) exists to enforce — see its module doc — and
 * is also why this file lives separately rather than folded back into it:
 * `validate-avif.ts` must be importable by the parent WITHOUT pulling sharp
 * (and therefore libvips/libheif) into the HTTP server's address space (#2257).
 */

import sharp from 'sharp';

/** AVIF encoders can round dimensions by a pixel or two during resize — this
 * is slack on the upper bound, not a target every output must hit exactly
 * (a source smaller than the tier's target is never upscaled). */
const DIMENSION_TOLERANCE_PX = 4;

/** sharp reports AVIF's container format as `"heif"` (AVIF is a HEIF
 * profile, not a distinct sharp format) — `compression: "av1"` is what
 * actually distinguishes an AVIF from a HEIC/HEVC file within that family.
 * (sharp's `mediaType` metadata field — the more obvious `"image/avif"`
 * check — isn't populated by the libheif build this repo's pinned sharp
 * version (0.34.5, libheif 1.20.2) ships; verified empirically against the
 * exact pinned version rather than a newer one that happened to be cached
 * locally.) */
const EXPECTED_FORMAT = 'heif';
const EXPECTED_COMPRESSION = 'av1';

export type AvifValidationResult = { ok: true } | { ok: false; reason: string };

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Decode `filePath` and confirm it's a genuine, complete, correctly-sized
 * AVIF matching this pipeline's encode conventions. Checks run cheapest
 * (metadata-only) to most expensive (a full pixel decode) — see the
 * ordering note inline below for why that order is load-bearing, not
 * incidental:
 *
 *  1. Format: `format`/`compression` must report `heif`/`av1` — sharp's way
 *     of saying "this is genuinely AVIF," not e.g. a HEIC file or non-image
 *     bytes with an `.avif` extension.
 *  2. Dimensions: both the width and height must be within
 *     `DIMENSION_TOLERANCE_PX` of `expectedLongEdgePx` — an upper bound
 *     only, since `fit: 'inside', withoutEnlargement: true` (this pipeline's
 *     resize contract) legitimately leaves a source smaller than the target
 *     un-upscaled.
 *  3. Orientation: every encoder in this pipeline bakes EXIF orientation
 *     into pixels at encode time (raw-ffi's `bake_orientation`, sharp's
 *     `.rotate()`) and never carries an orientation tag forward — see
 *     `thumbs/apply-orientation.ts`'s module doc. A tag other than `1` here
 *     means some path landed a cache entry that still depends on a tag no
 *     reader (server route, Apple, web) applies.
 *  4. Colour characteristics: this pipeline's AVIF outputs are untagged
 *     sRGB by convention (`raw-core`'s `avif::encode` doc: "color-managed
 *     viewers assume sRGB for untagged AVIF", and neither encode path calls
 *     `.withIccProfile()` / `.toColorspace()`). An embedded ICC profile, or
 *     a decoded colourspace other than sRGB, means the encoder attached (or
 *     interpreted) something this pipeline never asked for.
 *  5. Integrity: a full pixel decode must succeed. `.metadata()` alone is
 *     NOT sufficient — it can return a plausible width/height read straight
 *     from the AVIF's meta/header box even when the `mdat` pixel payload is
 *     truncated (verified empirically: a header-intact AVIF sliced to a
 *     third of its real length still returns full metadata with no error).
 *     Catching a truncated/corrupt encode requires forcing a real decode of
 *     the pixel data, not just parsing the header. Deliberately LAST: it's
 *     the only check that pulls the full image into memory, so every cheap
 *     metadata-only check — especially the dimension bound — must reject
 *     first for a wildly-oversized input (see the inline comment below).
 */
export async function checkAvifOutput(
  filePath: string,
  expectedLongEdgePx: number,
): Promise<AvifValidationResult> {
  // `failOn: 'warning'` is sharp's own strictest setting (its default) —
  // explicit here because we're validating OUR OWN freshly-encoded output,
  // the opposite intent of `SHARP_INPUT_OPTS`'s `failOn: 'none'` used
  // elsewhere in this pipeline for decoding third-party source files. One
  // instance, reused below for both `.metadata()` and `.raw().toBuffer()`.
  const image = sharp(filePath, { failOn: 'warning' });

  let meta: sharp.Metadata;
  try {
    meta = await image.metadata();
  } catch (e) {
    return { ok: false, reason: `metadata decode failed: ${errMessage(e)}` };
  }

  if (meta.format !== EXPECTED_FORMAT || meta.compression !== EXPECTED_COMPRESSION) {
    return {
      ok: false,
      reason: `unexpected format "${meta.format ?? 'unknown'}"/compression "${meta.compression ?? 'unknown'}" (expected ${EXPECTED_FORMAT}/${EXPECTED_COMPRESSION})`,
    };
  }

  // Every check below this point is metadata-only (no pixel decode) — they
  // run BEFORE the full pixel decode at the bottom of this function
  // deliberately: `copyImageAsThumb`'s fallback can hand this validator
  // arbitrary bytes that happen to parse as a genuine (if huge) AVIF, and a
  // resize bug is exactly the class of thing this validator exists to catch.
  // Checking declared dimensions first means a wildly-oversized image is
  // rejected on its cheap header read rather than fully decoded into memory
  // first — see jules review on PR #2011/#2014.
  const { width, height, orientation, space, hasProfile } = meta;
  if (!width || !height) {
    return { ok: false, reason: 'metadata missing width/height' };
  }
  const maxAllowed = expectedLongEdgePx + DIMENSION_TOLERANCE_PX;
  if (width > maxAllowed || height > maxAllowed) {
    return {
      ok: false,
      reason: `dimensions ${width}x${height} exceed expected long edge ${expectedLongEdgePx} (+${DIMENSION_TOLERANCE_PX}px tolerance)`,
    };
  }

  if (orientation !== undefined && orientation !== 1) {
    return {
      ok: false,
      reason: `unexpected orientation tag ${orientation} — this pipeline bakes rotation into pixels and writes no orientation tag`,
    };
  }

  if (hasProfile) {
    return {
      ok: false,
      reason:
        'unexpected embedded ICC profile — this pipeline writes untagged sRGB AVIF by convention',
    };
  }
  if (space !== 'srgb') {
    return { ok: false, reason: `unexpected colourspace "${space}" (expected srgb)` };
  }

  try {
    // Full pixel decode, result discarded — see point 5 in the doc comment
    // above for why `.metadata()` alone can't be trusted to catch
    // truncation. Deliberately the LAST and most expensive check, now that
    // every metadata-only check (including the dimension bound) has passed.
    await image.raw().toBuffer();
  } catch (e) {
    return { ok: false, reason: `pixel decode failed (truncated or corrupt): ${errMessage(e)}` };
  }

  return { ok: true };
}
