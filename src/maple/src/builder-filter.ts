/**
 * Free functions behind `MapleImageBuilder`'s five filter methods — `blur`,
 * `sharpen`, `median`, `threshold`, `convolve` (#3504 task E5). Split out of
 * `builder.ts`, mirroring the `builder-state.ts`/`builder-exec.ts` split, so
 * that file's line count stays flat as Tier 2 adds op methods; each
 * function here mutates one `BuilderState` and returns nothing, matching
 * the shape a fluent builder method wraps in one line.
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

/** Blur. No argument = a fast 3x3 box blur; a sigma = a Gaussian. */
export function pushBlur(state: BuilderState, options?: number | { sigma?: number }): void {
  const sigma = typeof options === 'number' ? options : options?.sigma;
  state.ops.push({ op: 'blur', sigma: sigma ?? null });
}

/** Unsharp mask on the L* channel (sharp's `sharpen`). */
export function pushSharpen(state: BuilderState, options?: SharpenOptions): void {
  state.ops.push({
    op: 'sharpen',
    sigma: options?.sigma ?? null,
    m1: options?.m1 ?? 1.0,
    m2: options?.m2 ?? 2.0,
    x1: options?.x1 ?? 2.0,
    y2: options?.y2 ?? 10.0,
    y3: options?.y3 ?? 20.0,
  });
}

/** Square median filter; `size` is any integer sharp/`vips_rank` accepts. */
export function pushMedian(state: BuilderState, size: number): void {
  state.ops.push({ op: 'median', size });
}

/** Binarise at `threshold`; `greyscale` decides via Rec.709 luma. */
export function pushThreshold(
  state: BuilderState,
  threshold: number,
  options?: { greyscale?: boolean; grayscale?: boolean },
): void {
  state.ops.push({
    op: 'threshold',
    value: threshold,
    greyscale: options?.greyscale ?? options?.grayscale ?? true,
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
    width: kernel.width,
    height: kernel.height,
    kernel: kernel.kernel,
    scale: kernel.scale ?? null,
    offset: kernel.offset ?? 0,
  });
}
