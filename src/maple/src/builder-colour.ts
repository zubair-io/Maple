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

import { resolveColour } from './builder-state';
import type { BuilderState } from './builder-state';
import type { Colour } from './types';

export function pushGreyscale(state: BuilderState, greyscale: boolean): void {
  if (greyscale) {
    state.ops.push({ op: 'greyscale' });
  }
}

function checkGammaRange(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 1.0 || value > 3.0) {
    throw new Error(`${name}: expected a finite value in [1.0, 3.0], got ${value}`);
  }
}

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
export function pushGamma(state: BuilderState, gamma: number, gammaOut?: number): void {
  checkGammaRange('gamma', gamma);
  const out = gammaOut ?? gamma;
  checkGammaRange('gammaOut', out);
  state.gammaPair = {
    before: { op: 'gamma', exponent: gamma },
    after: { op: 'gamma', exponent: 1 / out },
  };
}

/**
 * A scalar or per-channel triple. libvips' `vips_linear` broadcasts a
 * 1-element vector and takes an N-element one for an N-band image, and
 * rejects everything else — so 1 and 3 are the only lengths that mean
 * anything for the 3 colour bands this op writes.
 *
 * The old code quietly invented the missing coefficients (`[1, 1.5]` ran
 * the third channel at `a[0]`, not 1.5) where sharp throws. Error wording
 * is libvips' own (#3503 review I5).
 */
function coefficients(v: number | number[]): [number, number, number] {
  if (typeof v === 'number') {
    return [v, v, v];
  }
  if (v.length === 1) {
    return [v[0], v[0], v[0]];
  }
  if (v.length === 3) {
    return [v[0], v[1], v[2]];
  }
  // A 4-element vector is legal in sharp on an RGBA image, where libvips
  // applies the 4th element to the alpha channel. This op never touches
  // alpha, so it says so rather than dropping the element silently.
  const alphaNote =
    v.length === 4 ? ' (sharp applies a 4th element to alpha; this op never touches alpha)' : '';
  throw new Error(`linear: vector must have 1 or 3 elements, got ${v.length}${alphaNote}`);
}

/** How long sharp considers a coefficient argument to be: a scalar is 1. */
const coefficientLength = (v: number | number[]): number => (typeof v === 'number' ? 1 : v.length);

/**
 * `a * input + b`, per channel or scalar.
 *
 * `a` and `b` must be the same length, counting a scalar as length 1 — so
 * `linear(1.2, [0, 10, -10])` is rejected, exactly as sharp rejects it
 * (`lib/operation.js`: `linearA.length !== linearB.length`).
 */
export function pushLinear(
  state: BuilderState,
  a: number | number[] = 1,
  b: number | number[] = 0,
): void {
  if (coefficientLength(a) !== coefficientLength(b)) {
    throw new Error('Expected a and b to be arrays of the same length');
  }
  state.ops.push({ op: 'linear', a: coefficients(a), b: coefficients(b) });
}

/**
 * Produce the negative. `{ alpha: false }` spares the alpha channel.
 *
 * `negate(false)` DISABLES the op, as in sharp: `this.options.negate =
 * is.bool(options) ? options : true` (`lib/operation.js:584`). Measured —
 * sharp's `negate(false)` returns the source pixels untouched. This lane's
 * own `greyscale(false)` already worked that way, so the pair was
 * internally inconsistent (#3503 review I4).
 */
export function pushNegate(state: BuilderState, options?: boolean | { alpha?: boolean }): void {
  if (options === false) {
    return;
  }
  const alpha = typeof options === 'object' ? (options.alpha ?? true) : true;
  state.ops.push({ op: 'negate', alpha });
}

/** Stretch luminance between the given percentiles. */
export function pushNormalise(state: BuilderState, lower: number, upper: number): void {
  state.ops.push({ op: 'normalise', lower, upper });
}

/** Scale L* and C* and rotate hue, in CIELCh. */
export function pushModulate(
  state: BuilderState,
  brightness: number,
  saturation: number,
  hue: number,
  lightness: number,
): void {
  state.ops.push({ op: 'modulate', brightness, saturation, hue, lightness });
}

/** Keep each pixel's lightness, take the chroma from `tint`. */
export function pushTint(state: BuilderState, tint: Colour | string): void {
  const [r, g, b] = resolveColour(tint, [0, 0, 0, 255]);
  state.ops.push({ op: 'tint', rgb: [r, g, b] });
}

/**
 * Target colourspace. For bitmaps this pushes a recipe op that rotates the
 * primaries and tags the output with the matching ICC profile — accepted
 * names and error-by-name rejection (`b-w`/`cmyk`/`lab`/…) both live
 * raw-core side (`raster_recipe_colour::primaries_from_wire`), so an
 * unsupported name is not re-validated here. `state.colorSpace` also moves,
 * for the RAW-develop path (`colorSpace()`, Tier 1), which does its own
 * colour management and never sees this op.
 */
export function pushToColourspace(state: BuilderState, space: string): void {
  state.colorSpace = space === 'srgb' ? 'srgb' : 'display-p3';
  state.ops.push({ op: 'toColourspace', space });
}
