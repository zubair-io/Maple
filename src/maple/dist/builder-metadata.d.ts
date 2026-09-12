/**
 * `metadata()`, `stats()`, and the metadata-passthrough builder methods
 * (`keepMetadata`, `withMetadata`, `withExif`, `withIccProfile`, `withXmp`) —
 * split out of `builder.ts` to keep that file inside the repo's file-size
 * budget as Tier 2 adds op methods (#3505, #3507). Every function here takes
 * the `BuilderState`; `builder.ts`'s class methods are thin wrappers that
 * call into these and (for the fluent setters) `return this`.
 *
 * Backed by `maple_raster_analyze_buf` (`native-raster-analyze.ts`) — see
 * `raw-pipeline/raw-core/src/raster_analyze.rs` for the JSON reply this
 * mirrors field-for-field, and `raster_recipe_meta.rs::RecipeMetadata` for
 * the recipe `metadata` block the `with*`/`keep*` methods populate.
 */
import { type BuilderState } from './builder-state';
import type { ImageMetadata, ImageStats } from './types';
/**
 * Dimensions, format, orientation and — for an in-memory bitmap or a
 * non-RAW bitmap file path — the richer metadata block: alpha, embedded
 * colour profile, EXIF/ICC/XMP, density (#3507). A `rawInput` pixel buffer
 * or an actual camera RAW file (by extension, or content-sniffed for a
 * bytes input with no filename to route on) keeps Tier 1's cheap header
 * probe unchanged — analyze()'s container-sidecar reader is written and
 * tested against bitmap containers only.
 */
export declare function resolveMetadata(state: BuilderState): Promise<ImageMetadata>;
/**
 * Pixel-derived statistics for every channel plus the whole-image numbers
 * (sharp's `stats()`). Ignores any queued resize/composite/etc ops — like
 * `metadata()`, this reads the *input*, matching sharp's own `stats()`
 * (measured: `sharp(png).resize(4,4).stats()` reports the same numbers as
 * `sharp(png).stats()`).
 *
 * A camera RAW file has no pixels to measure until it's been developed —
 * unlike `metadata()`, which stays a header probe for RAW input, `stats()`
 * runs the full RAW-develop pipeline first (recipe/XMP, colour management,
 * the GPU chain), so expect RAW-develop-level cost, not a header-probe one.
 */
export declare function resolveStats(state: BuilderState): Promise<ImageStats>;
/** Keep every metadata block from the input (sharp's `keepMetadata`). */
export declare function applyKeepMetadata(state: BuilderState): void;
/** Keep most metadata and optionally set the orientation or density (sharp's `withMetadata`). */
export declare function applyWithMetadata(state: BuilderState, options?: {
    orientation?: number;
    density?: number;
}): void;
/**
 * Embed this EXIF block (a bare TIFF block, starting `II*` or `MM*`).
 *
 * Diverges from sharp's own `withExif(exif: {IFD0?: Record<string,string>,
 * …})`, which takes an object of IFD tags and authors the TIFF block itself.
 * Maple has no IFD-object authoring yet (tracked as a follow-up, #3588) —
 * passing sharp's object shape here is rejected by name rather than
 * silently doing the wrong thing with it.
 */
export declare function applyWithExif(state: BuilderState, exif: Uint8Array | Buffer): void;
/**
 * Embed an ICC profile — `'srgb'` (Maple's own built-in profile, no bytes to
 * supply), a filesystem path (read now — Maple's `aux` blob needs real bytes
 * at call time, unlike sharp's own deferred-to-libvips read), or raw profile
 * bytes (a Maple extension beyond sharp's `string`-only signature).
 *
 * This TAGS the output; it never converts its pixels, which is where it
 * parts company with sharp. `'p3'` is therefore a named error rather than a
 * mislabelling (see [`NAMED_ICC_PROFILES`]), and `'cmyk'` — sharp's third
 * named value — is a named error because Maple has no CMYK support at all.
 */
export declare function applyWithIccProfile(state: BuilderState, icc: string | Uint8Array | Buffer): void;
/**
 * Embed this XMP packet — a string, as sharp takes, or raw packet bytes (a
 * Maple extension beyond sharp's `string`-only signature, the same one
 * `withIccProfile` offers).
 *
 * Anything else is rejected with sharp's own wording. Before this only the
 * empty string was checked, so `withXmp(42)` threw nothing at call time and
 * failed downstream with `AuxBlob wrote NaN bytes, expected NaN`, and
 * `withXmp(null)` with `null is not an object` (#3507 final fix wave,
 * item 9).
 */
export declare function applyWithXmp(state: BuilderState, xmp: string | Uint8Array | Buffer): void;
