// xmp-crop.ts — crop/straighten attribute parsing, split out of
// `XmpParserService.parseAdjustmentModel` (#1840, complexity hotspot).
//
// Crop gating (#277): `crs:HasCrop` must be discovered before applying the
// rect fields — mirrors the two-pass approach in raw-core's xmp/mod.rs.
// `crs:CropAngle` is independent of `hasCrop` (pure straighten; spec § 01
// invariant 3). Missing or "False" leaves the crop at its identity default.

import type { Crop } from '../models/adjustment-model';

/** Accumulates the crop fields seen across a `parseAdjustmentModel` attribute
 * walk. Each field starts unset so `finalizeCrop` can tell "never mentioned"
 * (→ no `crop` in the model at all) apart from "mentioned at its default". */
export interface CropAccumulator {
  top?: number;
  left?: number;
  bottom?: number;
  right?: number;
  angle?: number;
}

export function newCropAccumulator(): CropAccumulator {
  return {};
}

const CROP_RECT_ATTRS: Record<string, keyof CropAccumulator> = {
  'crs:CropTop': 'top',
  'crs:CropLeft': 'left',
  'crs:CropBottom': 'bottom',
  'crs:CropRight': 'right',
};

/**
 * Applies one XMP attribute to `acc` if it's part of the crop group.
 * Returns whether `name` was a crop attribute at all (regardless of whether
 * the value parsed) — the caller uses this to decide whether to keep
 * matching the attribute against other field groups.
 */
export function applyCropAttribute(
  acc: CropAccumulator,
  name: string,
  rawValue: string,
  hasCrop: boolean,
): boolean {
  const rectKey = CROP_RECT_ATTRS[name];
  if (rectKey) {
    if (hasCrop) {
      const n = parseFloat(rawValue);
      if (!Number.isNaN(n)) acc[rectKey] = n;
    }
    return true;
  }
  if (name === 'crs:CropAngle') {
    const n = parseFloat(rawValue);
    if (!Number.isNaN(n)) acc.angle = n;
    return true;
  }
  return false;
}

/**
 * Emits a `Crop` only when at least one field came through the walk; angle
 * alone is enough (pure straighten). Unset fields fall back to the identity
 * default for that edge.
 */
export function finalizeCrop(acc: CropAccumulator): Crop | undefined {
  if (
    acc.top === undefined &&
    acc.left === undefined &&
    acc.bottom === undefined &&
    acc.right === undefined &&
    acc.angle === undefined
  ) {
    return undefined;
  }
  return {
    top: acc.top ?? 0,
    left: acc.left ?? 0,
    bottom: acc.bottom ?? 1,
    right: acc.right ?? 1,
    angle: acc.angle ?? 0,
  };
}
