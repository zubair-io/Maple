/**
 * Decode-based validation for AVIF cache derivatives (thumbs + previews).
 *
 * `indexer/thumbnailer.ts` and `indexer/previewer.ts` both write through
 * `ffiPool().renderThumbnailAvifToFile` (Rust) or `renderImageThumbToFileViaPool`
 * (sharp, via the isolated `imgdecode` child) to encode a resized AVIF. Both
 * of those encoders already write atomically (temp file + rename) internally,
 * so a crash or `ENOSPC` mid-write can't leave a half-written file at the
 * final cache path. What neither encoder validates is the CONTENT of what it
 * successfully wrote: a completed-but-corrupt encode (a codec edge case, a
 * resize bug, a source silently mis-decoded) can still finish writing and get
 * renamed into place looking like a good cache entry.
 *
 * `validateAvifOutput` closes that gap with a real decode. `publishValidatedAvif`
 * is the write-side half: given bytes already encoded to a private temp path,
 * it validates them and only then renames into the real cache path — the same
 * write-to-temp-then-rename idiom as `fs/xmp.ts`'s `writeXmpWithPrecondition`,
 * gated on decode success rather than only on the write itself succeeding. On
 * failure it removes the temp file, so nothing invalid is ever left where a
 * reader expects a good cache entry.
 */

import * as fs from 'node:fs/promises';
import sharp from 'sharp';
import type { Logger } from 'pino';

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

export type AvifTier = 'preview' | 'thumb';

export interface AvifValidationContext {
  /** Absolute path of the SOURCE asset this derivative was generated from. */
  assetPath: string;
  tier: AvifTier;
}

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
export async function validateAvifOutput(
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

/**
 * Validate `tmpPath` (an AVIF the caller just encoded to a private temp
 * path) and, only if it passes, atomically publish it to `finalPath` via
 * rename. On any failure — validation or the rename itself — `tmpPath` is
 * removed so nothing invalid is ever left at `finalPath`, and the failure is
 * logged with `context` (asset, tier, which check failed) for triage.
 */
export async function publishValidatedAvif(
  tmpPath: string,
  finalPath: string,
  expectedLongEdgePx: number,
  log: Logger,
  context: AvifValidationContext,
): Promise<boolean> {
  const validation = await validateAvifOutput(tmpPath, expectedLongEdgePx);
  if (!validation.ok) {
    await unlinkQuiet(tmpPath);
    log.warn(
      { assetPath: context.assetPath, tier: context.tier, finalPath, reason: validation.reason },
      'avif validation failed — discarding',
    );
    return false;
  }

  try {
    await fs.rename(tmpPath, finalPath);
    return true;
  } catch (e) {
    await unlinkQuiet(tmpPath);
    log.warn(
      { assetPath: context.assetPath, tier: context.tier, finalPath, err: errMessage(e) },
      'avif publish rename failed',
    );
    return false;
  }
}

/**
 * Shared by `previewer.ts`/`thumbnailer.ts` after every render branch
 * (RAW-FFI, sharp bitmap, or thumbnailer's last-resort copy fallback) has
 * attempted to write `tmpPath`: if the render itself failed, discard
 * `tmpPath`; if it succeeded, hand off to `publishValidatedAvif`. Returns
 * whether a good AVIF now exists at `finalPath`.
 */
export async function finalizeAvifRender(
  renderOk: boolean,
  tmpPath: string,
  finalPath: string,
  expectedLongEdgePx: number,
  log: Logger,
  context: AvifValidationContext,
): Promise<boolean> {
  if (!renderOk) {
    await unlinkQuiet(tmpPath);
    return false;
  }
  return publishValidatedAvif(tmpPath, finalPath, expectedLongEdgePx, log, context);
}

async function unlinkQuiet(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // best-effort — nothing to clean up, or already gone.
  }
}
