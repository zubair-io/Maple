/**
 * Colour recipe ops for `MapleImageBuilder` (#3503 Task D6): `greyscale`,
 * `gamma`, `linear`, `negate`, `normalise`, `modulate`, `tint`,
 * `toColourspace`. Split out of `builder.ts` for the file-size budget, same
 * lane split as `builder-geometry.ts`. Each function mutates the state's
 * `ops` list (and occasionally `colorSpace`, for the RAW-develop path) —
 * `builder.ts`'s methods are thin wrappers that call these and `return
 * this`.
 *
 * Range validation for most of these ops lives raw-core side
 * (`raster_recipe_colour.rs`), which already names the offending option and
 * value in its error — that error surfaces here as a rejected promise with
 * the same text, so it is not duplicated. `gamma`/`gammaOut` are the one
 * exception: sharp's `[1.0, 3.0]` bound applies to the user-facing values,
 * not to the wire `exponent` (the pre-resize instance's wire value IS
 * `gamma` directly, but the post-resize instance's is `1/gammaOut`, which
 * is usually well outside that range) — so that check has to happen here,
 * before the reciprocal is taken.
 */
import type { BuilderState } from './builder-state';
import type { Colour } from './types';
export declare function pushGreyscale(state: BuilderState, greyscale: boolean): void;
/**
 * sharp's `gamma(gamma, gammaOut)`. libvips' `vips_gamma(image, exponent)`
 * computes `x ** (1/exponent)` — NOT a direct power law — so sharp's
 * pipeline calls `Gamma(image, 1/gamma)` before the resize (which nets to
 * `x ** gamma`, darkening for `gamma > 1`) and `Gamma(image, gammaOut)`
 * after it (which nets to `x ** (1/gammaOut)`, brightening for `gammaOut >
 * 1`). Our recipe's own `gamma{exponent}` op is a PLAIN `x ** exponent`
 * (see `raster_colour.rs`), unlike `vips_gamma` — so reproducing sharp's
 * net effect through our op means emitting the wire exponents the other
 * way round from what a naive reading of sharp's call suggests: `gamma`
 * itself before the resize, and `1/gammaOut` after it. With the defaults
 * (2.2, 2.2) the pair is a net identity and the RESIZE is what happens in
 * the changed encoding.
 *
 * The pair is recorded in `state.gammaPair`, not spliced into `state.ops`
 * here — sharp's `gamma`/`resize` are fixed pipeline STAGES, so the pair's
 * position relative to `resize` has to be resolved once the full op list is
 * known, at assembly time (`stateToRecipe`), not at the moment `.gamma()`
 * happens to be called. Splicing here would put the pair in the wrong place
 * whenever `.gamma()` is chained before `.resize()` — the position needs to
 * be resolved from the FINAL op list, which doesn't exist yet mid-chain. A
 * second `.gamma()` call replaces the pending pair, matching sharp.
 */
export declare function pushGamma(state: BuilderState, gamma: number, gammaOut?: number): void;
/**
 * `a * input + b`, per channel or scalar.
 *
 * `a` and `b` must be the same length, counting a scalar as length 1 — so
 * `linear(1.2, [0, 10, -10])` is rejected, exactly as sharp rejects it
 * (`lib/operation.js`: `linearA.length !== linearB.length`).
 */
export declare function pushLinear(state: BuilderState, a?: number | number[], b?: number | number[]): void;
/**
 * Produce the negative. `{ alpha: false }` spares the alpha channel.
 *
 * `negate(false)` DISABLES the op, as in sharp: `this.options.negate =
 * is.bool(options) ? options : true` (`lib/operation.js:584`). Measured —
 * sharp's `negate(false)` returns the source pixels untouched. This lane's
 * own `greyscale(false)` already worked that way, so the pair was
 * internally inconsistent (#3503 review I4).
 */
export declare function pushNegate(state: BuilderState, options?: boolean | {
    alpha?: boolean;
}): void;
/** Stretch luminance between the given percentiles. */
export declare function pushNormalise(state: BuilderState, lower: number, upper: number): void;
/** Scale L* and C* and rotate hue, in CIELCh. */
export declare function pushModulate(state: BuilderState, brightness: number, saturation: number, hue: number, lightness: number): void;
/** Keep each pixel's lightness, take the chroma from `tint`. */
export declare function pushTint(state: BuilderState, tint: Colour | string): void;
/**
 * Target colourspace. For bitmaps this pushes a recipe op that rotates the
 * primaries and tags the output with the matching ICC profile.
 *
 * `'b-w'` is the one libvips interpretation name sharp's own
 * `toColourspace` takes that Maple can honour, and it means exactly what
 * `greyscale()` means — sharp reaches `image.colourspace(B_W)` either way —
 * so it pushes the greyscale op rather than a primaries rotation (#3503
 * review I2). Everything else is either a primaries name or an error.
 *
 * An unrecognised name throws HERE rather than only raw-core side. The
 * RAW-develop path never sees `state.ops`, so the previous
 * `space === 'srgb' ? 'srgb' : 'display-p3'` silently exported Display P3
 * for any unrecognised string — including `'b-w'` and typos — where Tier 1
 * exported sRGB (#3503 review, cross-task consistency). `gamma`/`gammaOut`
 * already validate synchronously in this file, so the shape matches.
 */
export declare function pushToColourspace(state: BuilderState, space: string): void;
