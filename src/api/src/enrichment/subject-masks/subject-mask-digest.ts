// subject-mask-digest.ts — names a person-skin raster (#4284, #3300 slice 3).
//
// Byte-identical to Apple's `EditSession.maskDigest` (`EditSession+Masks.
// swift`) and web's `subject-mask-digest.ts`: FNV-1a over the UTF-8 of
// `{assetKey}|{person}|{facialSkin}|{bodySkin}|{model}` (bools as
// `true`/`false`), formatted to 16 lowercase hex chars.

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a, 64-bit, over UTF-8 bytes — 16 lowercase hex chars. */
export function fnv1a64Hex(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * The digest a person-skin `BitmapRecipe` carries.
 *
 * `assetKey` is the web asset id (`Asset.id` — stable on Self Hosted, where
 * the segmentation server runs). `model` is the server's model id from the
 * detect response, folded in so a model bump naturally retires old rasters.
 */
export function subjectMaskDigest(
  assetKey: string,
  person: number,
  facialSkin: boolean,
  bodySkin: boolean,
  model: string,
): string {
  return fnv1a64Hex(`${assetKey}|${person}|${facialSkin}|${bodySkin}|${model}`);
}
