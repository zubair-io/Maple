/**
 * Geometry op builders for `MapleImageBuilder` — extract, extend, rotate,
 * flip, flop, trim (#3501, Tier 2 task B6), emitting the recipe ops Task B5
 * added to raw-core. Split out of `builder.ts` to keep that file under the
 * repo's file-size budget: each function mutates one `BuilderState` in
 * place, and the builder's own methods are thin wrappers that call these
 * and return `this`.
 */
import type { BuilderState } from './builder-state';
import type { ExtendOptions, ExtractRegion, RotateOptions, TrimOptions } from './types';
/**
 * With no angle: auto-orient from the EXIF Orientation tag (the Tier 1
 * behaviour, and sharp's backwards-compatible default). With an angle:
 * append a `rotate` op that turns the image clockwise by that many
 * degrees, padding any new edges with `background`.
 */
export declare function pushRotate(state: BuilderState, angle: number | undefined, options?: RotateOptions): void;
/** Crop to a region (sharp's `extract`). */
export declare function pushExtract(state: BuilderState, region: ExtractRegion): void;
/** Pad one or more edges with a background colour (sharp's `extend`). */
export declare function pushExtend(state: BuilderState, options: ExtendOptions | number): void;
/** Mirror about the horizontal axis. */
export declare function pushFlip(state: BuilderState): void;
/** Mirror about the vertical axis. */
export declare function pushFlop(state: BuilderState): void;
/** Crop a border of pixels similar to `background` (sharp's `trim`). */
export declare function pushTrim(state: BuilderState, options?: TrimOptions): void;
