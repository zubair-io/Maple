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
  state.ops.push({
    op: 'rotate',
    angle,
    background: resolveColour(options?.background, OPAQUE_BLACK),
  });
}

/** Crop to a region (sharp's `extract`). */
export function pushExtract(state: BuilderState, region: ExtractRegion): void {
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
  state.ops.push({
    op: 'trim',
    background:
      options?.background === undefined ? null : resolveColour(options.background, OPAQUE_BLACK),
    threshold: options?.threshold ?? 10,
    margin: options?.margin ?? 0,
  });
}
