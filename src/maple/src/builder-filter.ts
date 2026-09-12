/**
 * Free functions behind `MapleImageBuilder`'s five filter methods — `blur`,
 * `sharpen`, `median`, `threshold`, `convolve` (#3504 task E5). Split out of
 * `builder.ts`, mirroring the `builder-state.ts`/`builder-exec.ts` split, so
 * that file's line count stays flat as Tier 2 adds op methods; each
 * function here mutates one `BuilderState` and returns nothing, matching
 * the shape a fluent builder method wraps in one line.
 *
 * **Everything is validated here, by name, before it reaches the wire.**
 * Two reasons, both of them things this file got wrong before the PR-E
 * final review. `JSON.stringify` turns `NaN` and `±Infinity` into `null`,
 * so a bad number that is not caught here arrives at raw-core as an absent
 * field — `blur(NaN)` silently became the box blur, and a `NaN` inside a
 * convolve kernel surfaced as "recipe parse failed: invalid type: null,
 * expected f64". And an un-ranged integer surfaced raw serde text: what a
 * caller saw for `median(3.5)` was "rawler failed to decode <recipe>:
 * recipe parse failed: invalid type: floating point `3.5`, expected u32 at
 * line 1 column 98". The checks below mirror sharp's own `is.inRange` gates
 * and reuse its error wording (`lib/is.js`'s `invalidParameterError`), so a
 * caller porting from sharp sees the message they already know.
 *
 * **Wire shapes below follow `raw-core/src/raster_recipe_filter.rs`'s
 * actual schema (#3504 task E4), not the task brief's own literal object
 * literals** — this file's own doc comments on each function call out
 * every place the two disagree. The one load-bearing disagreement is
 * `convolve`'s `scale`: the schema's `Convolve.scale` is `Option<f64>`
 * specifically so the executor can tell "the caller never set `scale`"
 * (wire `null`/absent, falls back to the kernel's own sum) apart from "the
 * caller explicitly passed `scale: 0`" (wire `0`, sharp's own rule clips it
 * up to 1) — sending a plain `kernel.scale ?? 0` on the wire, as the
 * brief's literal code does, collapses that distinction and silently
 * breaks a zero-sum kernel (e.g. a Sobel operator) run with no `scale` at
 * all.
 */

import type { BuilderState } from './builder-state';
import type { ConvolveKernel, SharpenOptions } from './types';

/** sharp's `blur` sigma domain (`lib/operation.js`). */
const BLUR_SIGMA = [0.3, 1000] as const;
/** sharp's `sharpen({sigma})` domain — narrower than `blur`'s, and narrower
 * than its own deprecated positional form's 0.01-10000. See [`pushSharpen`]. */
const SHARPEN_SIGMA = [0.000001, 10] as const;
/** sharp's shared domain for `m1`/`m2`/`x1`/`y2`/`y3`. */
const SHARPEN_PARAM = [0, 1000000] as const;
/** sharp's `convolve` kernel dimension domain. */
const KERNEL_DIM = [3, 1001] as const;

/** sharp's own `is.js` wording, so a ported caller sees a familiar message. */
function invalidParameter(name: string, expected: string, actual: unknown): Error {
  return new Error(
    `Expected ${expected} for ${name} but received ${String(actual)} of type ${typeof actual}`,
  );
}

/** A finite number inside `[lo, hi]`. Rejects `NaN` and `±Infinity`, which
 * `JSON.stringify` would otherwise flatten to `null` on the wire. */
function requireNumber(name: string, value: unknown, [lo, hi]: readonly [number, number]): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) {
    throw invalidParameter(name, `number between ${lo} and ${hi}`, value);
  }
  return value;
}

/** As [`requireNumber`], and an integer too — sharp's `is.integer` gate. */
function requireInteger(name: string, value: unknown, [lo, hi]: readonly [number, number]): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    throw invalidParameter(name, `integer between ${lo} and ${hi}`, value);
  }
  return value;
}

/** Blur. No argument = a fast 3x3 box blur; a sigma = a Gaussian.
 *
 * `true` is sharp's deprecated "apply the mild blur?" boolean and means the
 * same thing as no argument; `false` means "don't", so nothing is pushed at
 * all — sharp gates the stage on a non-zero sigma, which also keeps a
 * `blur(false)` from dragging a 4-channel image through the premultiply
 * sandwich.
 *
 * Note that sharp's Gaussian is an **exact identity** for every sigma up to
 * 0.557, because libvips truncates the mask at 20% of the peak amplitude
 * and that leaves a 1x1 mask. `blur(0.4)` doing nothing is sharp's real
 * behaviour, not a Maple shortcut. */
export function pushBlur(
  state: BuilderState,
  options?: number | boolean | { sigma?: number },
): void {
  if (options === false) {
    return;
  }
  if (options === undefined || options === true) {
    state.ops.push({ op: 'blur', sigma: null });
    return;
  }
  const sigma =
    typeof options === 'number'
      ? requireNumber('sigma', options, BLUR_SIGMA)
      : requireNumber('options.sigma', options.sigma, BLUR_SIGMA);
  state.ops.push({ op: 'blur', sigma });
}

/**
 * Unsharp mask on the L* channel (sharp's `sharpen`).
 *
 * No argument is sharp's fast mild 3x3 kernel, and so is `true` (its
 * deprecated boolean form); `false` pushes nothing, since sharp gates the
 * stage on a non-zero sigma. A bare number is sharp's
 * deprecated-but-live positional form, `sharpen(sigma)`, and is accepted
 * here for the same reason `blur` accepts one — the two idioms should not
 * diverge inside one file. One deliberate narrowing: sharp's positional
 * form allows a sigma up to 10000 while its object form stops at 10, and
 * Maple applies the object form's domain to both, so `sharpen(50)` throws
 * by name here rather than reaching a core that cannot honour it. The
 * further-deprecated `sharpen(sigma, flat, jagged)` triple is not accepted;
 * pass `{ sigma, m1, m2 }`.
 */
export function pushSharpen(
  state: BuilderState,
  options?: number | boolean | SharpenOptions,
): void {
  if (options === false) {
    return;
  }
  const mild = options === undefined || options === true;
  const numeric = typeof options === 'number';
  const sigma = mild
    ? null
    : numeric
      ? requireNumber('sigma', options, SHARPEN_SIGMA)
      : requireNumber('options.sigma', (options as SharpenOptions).sigma, SHARPEN_SIGMA);
  const params: SharpenOptions = mild || numeric ? {} : (options as SharpenOptions);
  const param = (name: keyof SharpenOptions, fallback: number): number =>
    params[name] === undefined
      ? fallback
      : requireNumber(`options.${name}`, params[name], SHARPEN_PARAM);
  state.ops.push({
    op: 'sharpen',
    sigma,
    m1: param('m1', 1.0),
    m2: param('m2', 2.0),
    x1: param('x1', 2.0),
    y2: param('y2', 10.0),
    y3: param('y3', 20.0),
  });
}

/** Square median filter; `size` is any integer sharp/`vips_rank` accepts. */
export function pushMedian(state: BuilderState, size: number): void {
  state.ops.push({ op: 'median', size: requireInteger('size', size, [1, 1000]) });
}

/**
 * Binarise at `threshold`; `greyscale` decides via linear-light luma.
 *
 * The greyscale flag follows sharp's own rule exactly, which is **not**
 * "default true unless told otherwise": `if (!is.object(options) ||
 * options.greyscale === true || options.grayscale === true)`. An options
 * object that does not literally set one of the two spellings to `true`
 * turns greyscale **off** — so `threshold(128)` is greyscale and
 * `threshold(128, {})` is not. Measured on sharp 0.34.5, that flip is worth
 * a max diff of 255 on 31% of the samples of a 32x32 noise fixture, so it
 * is not a corner case.
 *
 * A threshold of **0 is a no-op**, not "whiten everything": sharp gates the
 * stage on `threshold != 0`. `threshold(false)` resolves to that same 0 and
 * `threshold(true)` to 128, sharp's deprecated boolean form. The zero case
 * is enforced in raw-core rather than here, so a raw recipe gets it too.
 */
export function pushThreshold(
  state: BuilderState,
  threshold: number | boolean,
  options?: { greyscale?: boolean; grayscale?: boolean },
): void {
  state.ops.push({
    op: 'threshold',
    value:
      typeof threshold === 'boolean'
        ? threshold
          ? 128
          : 0
        : requireInteger('threshold', threshold, [0, 255]),
    greyscale:
      typeof options !== 'object' || options.greyscale === true || options.grayscale === true,
  });
}

/**
 * Convolve with an arbitrary kernel.
 *
 * `scale: kernel.scale ?? null` — NOT `?? 0` — is the load-bearing line:
 * `??` only substitutes on `null`/`undefined`, so an explicit `scale: 0`
 * from the caller still reaches the wire as `0` (sharp's own "clip up to
 * 1" case), while an omitted `scale` reaches it as `null` (`Option<f64>`'s
 * `None`, "use the kernel's own sum"). See this file's module doc.
 *
 * sharp's own `convolve()` (`lib/operation.js`) only honours `scale`/
 * `offset` when `is.integer()` passes on each — a non-integer `scale` is
 * silently replaced by the kernel's own sum, and a non-integer `offset` by
 * `0`, with no error either way (measured on sharp 0.34.5: `scale: 4.5`
 * over a flat 30 field with a box-of-9 kernel leaves the field at 30, i.e.
 * `scale` was replaced by the kernel sum of 9, not applied as 4.5). Maple
 * rejects rather than silently diverging from a value the caller actually
 * passed.
 */
export function pushConvolve(state: BuilderState, kernel: ConvolveKernel): void {
  const width = requireInteger('width', kernel.width, KERNEL_DIM);
  const height = requireInteger('height', kernel.height, KERNEL_DIM);
  if (!Array.isArray(kernel.kernel) || kernel.kernel.length !== width * height) {
    throw invalidParameter(
      'kernel',
      `an array of ${width * height} values for a ${width}x${height} kernel`,
      kernel.kernel,
    );
  }
  kernel.kernel.forEach((v, i) =>
    requireNumber(`kernel[${i}]`, v, [-Number.MAX_VALUE, Number.MAX_VALUE]),
  );
  if (kernel.scale !== undefined && !Number.isInteger(kernel.scale)) {
    throw new Error(
      `convolve: scale ${kernel.scale} must be an integer (sharp requires an integer scale)`,
    );
  }
  if (kernel.offset !== undefined && !Number.isInteger(kernel.offset)) {
    throw new Error(
      `convolve: offset ${kernel.offset} must be an integer (sharp requires an integer offset)`,
    );
  }
  state.ops.push({
    op: 'convolve',
    width,
    height,
    kernel: kernel.kernel,
    scale: kernel.scale ?? null,
    offset: kernel.offset ?? 0,
  });
}
