/**
 * Geometry op builders for `MapleImageBuilder` — extract, extend, rotate,
 * flip, flop, trim (#3501, Tier 2 task B6), emitting the recipe ops Task B5
 * added to raw-core. Split out of `builder.ts` to keep that file under the
 * repo's file-size budget: each function mutates one `BuilderState` in
 * place, and the builder's own methods are thin wrappers that call these
 * and return `this`.
 */

import type { BuilderState } from './builder-state';
import { resolveColour } from './builder-state';
import type { ExtendOptions, ExtractRegion, RotateOptions, TrimOptions } from './types';

const OPAQUE_BLACK: [number, number, number, number] = [0, 0, 0, 255];

/**
 * `JSON.stringify` turns `NaN`/`Infinity` into `null`, so a non-finite
 * number placed in a recipe op never reaches raw-core's own finite-number
 * guards (rotate's angle, trim's threshold) — it arrives there as `null`
 * and fails with a generic deserialisation error instead of a message
 * naming the field. Catch it here, before it's ever serialised, with the
 * same wording those guards use.
 */
function assertFinite(op: string, field: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${op}: ${field} must be finite (got ${value})`);
  }
}

/**
 * With no angle: auto-orient from the EXIF Orientation tag (the Tier 1
 * behaviour, and sharp's backwards-compatible default). With an angle:
 * append a `rotate` op that turns the image clockwise by that many
 * degrees, padding any new edges with `background`.
 */
export function pushRotate(
  state: BuilderState,
  angle: number | undefined,
  options?: RotateOptions,
): void {
  if (angle === undefined) {
    state.autoOrient = true;
    return;
  }
  assertFinite('rotate', 'angle', angle);
  state.ops.push({
    op: 'rotate',
    angle,
    background: resolveColour(options?.background, OPAQUE_BLACK),
  });
}

/** Crop to a region (sharp's `extract`). */
export function pushExtract(state: BuilderState, region: ExtractRegion): void {
  assertFinite('extract', 'left', region.left);
  assertFinite('extract', 'top', region.top);
  assertFinite('extract', 'width', region.width);
  assertFinite('extract', 'height', region.height);
  state.ops.push({
    op: 'extract',
    left: region.left,
    top: region.top,
    width: region.width,
    height: region.height,
  });
}

/** Pad one or more edges with a background colour (sharp's `extend`). */
export function pushExtend(state: BuilderState, options: ExtendOptions | number): void {
  const edges =
    typeof options === 'number'
      ? { top: options, bottom: options, left: options, right: options }
      : options;
  const opts = typeof options === 'number' ? {} : options;
  for (const field of ['top', 'bottom', 'left', 'right'] as const) {
    const value = edges[field];
    if (value !== undefined) {
      assertFinite('extend', field, value);
    }
  }
  state.ops.push({
    op: 'extend',
    top: edges.top ?? 0,
    bottom: edges.bottom ?? 0,
    left: edges.left ?? 0,
    right: edges.right ?? 0,
    extendWith: opts.extendWith ?? 'background',
    background: resolveColour(opts.background, OPAQUE_BLACK),
  });
}

/** Mirror about the horizontal axis. */
export function pushFlip(state: BuilderState): void {
  state.ops.push({ op: 'flip' });
}

/** Mirror about the vertical axis. */
export function pushFlop(state: BuilderState): void {
  state.ops.push({ op: 'flop' });
}

/** Crop a border of pixels similar to `background` (sharp's `trim`). */
export function pushTrim(state: BuilderState, options?: TrimOptions): void {
  const threshold = options?.threshold ?? 10;
  assertFinite('trim', 'threshold', threshold);
  if (options?.margin !== undefined) {
    assertFinite('trim', 'margin', options.margin);
  }
  state.ops.push({
    op: 'trim',
    background:
      options?.background === undefined ? null : resolveColour(options.background, OPAQUE_BLACK),
    threshold,
    margin: options?.margin ?? 0,
    // `lineArt` must be forwarded even when unset — omitting it from the op
    // let a `true` value get silently dropped rather than reaching
    // raw-core's own named rejection (#3501 fix-round-3).
    lineArt: options?.lineArt ?? false,
  });
}
