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
/** `a * input + b`, per channel or scalar. */
export declare function pushLinear(state: BuilderState, a?: number | number[], b?: number | number[]): void;
/** Produce the negative. `alpha: false` spares the alpha channel. */
export declare function pushNegate(state: BuilderState, alpha: boolean): void;
/** Stretch luminance between the given percentiles. */
export declare function pushNormalise(state: BuilderState, lower: number, upper: number): void;
/** Scale L* and C* and rotate hue, in CIELCh. */
export declare function pushModulate(state: BuilderState, brightness: number, saturation: number, hue: number, lightness: number): void;
/** Keep each pixel's lightness, take the chroma from `tint`. */
export declare function pushTint(state: BuilderState, tint: Colour | string): void;
/**
 * Target colourspace. For bitmaps this pushes a recipe op that rotates the
 * primaries and tags the output with the matching ICC profile — accepted
 * names and error-by-name rejection (`b-w`/`cmyk`/`lab`/…) both live
 * raw-core side (`raster_recipe_colour::primaries_from_wire`), so an
 * unsupported name is not re-validated here. `state.colorSpace` also moves,
 * for the RAW-develop path (`colorSpace()`, Tier 1), which does its own
 * colour management and never sees this op.
 */
export declare function pushToColourspace(state: BuilderState, space: string): void;
