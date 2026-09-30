/**
 * Post-encode validation of an AVIF this pipeline wrote (see the doc comment
 * in `validate-avif.ts`). Checks run cheapest-first: container and dimensions
 * from the header probe, then a full pixel decode last. Maple
 * decodes AVIF with a pure-Rust AV1 decoder (#3496); the retired implementation
 * also checked `space`/ICC, which our encoder never writes, so those
 * checks are gone with it.
 *
 * The FFI child's dispatch (`ffi/raw_ffi-dispatch.ts`) is this module's only
 * PIXEL-WORK consumer — imported at module scope there, inside the isolated
 * decode child, so no production code in the API parent
 * process ever runs a decode or encode on the native bitmap bindings; a
 * crash stays contained to the isolated child. Tests import this module
 * freely to exercise the predicate directly.
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
 *  3. Integrity: a full pixel decode must succeed. `.metadata()` alone is
 *     NOT sufficient — it can return a plausible width/height read straight
 *     from the AVIF's meta/header box even when the pixel payload is
 *     truncated. Catching a truncated/corrupt encode requires forcing a real
 *     decode of the pixel data, not just parsing the header. Deliberately
 *     LAST: it's the only check that pulls the full image into memory, so
 *     every cheap metadata-only check — especially the dimension bound —
 *     must reject first for a wildly-oversized input.
 *
 * AVIF has no reported orientation flag, even when an Exif item contains
 * Orientation (#3586). Container irot/imir transforms are baked into the
 * decoded pixels and metadata dimensions; an EXIF tag is never applied on
 * top. A metadata.orientation check would therefore be unreachable (#3589).
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
  const intact = await image.validateIntegrity();
  return intact.ok ? { ok: true } : { ok: false, reason: `pixel decode failed: ${intact.error}` };
}
