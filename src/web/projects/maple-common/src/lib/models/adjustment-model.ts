// AdjustmentModel — per-asset develop settings.
//
// The field shape and canonical defaults are GENERATED from
// `raw_core::types::ADJUSTMENT_SCHEMA` via `tools/codegen.sh` (#118).
// This shim re-exports the generated types and adds web-only fields that
// aren't part of the canonical Rust schema yet — `whiteBalancePreset` is
// the TS-side preset selector and stays hand-written until the Rust
// `WhiteBalancePreset` enum is promoted into the canonical schema (#119).
// `Crop` is also hand-written here because it's a nested struct rather than
// a flat slider — see `raw-core::types::adjustment::schema` for the design
// note that excludes it from `ADJUSTMENT_SCHEMA`.

import {
  GeneratedAdjustmentModel,
  defaultGeneratedAdjustmentModel,
} from '../generated/adjustment-model.generated';

export type { GeneratedAdjustmentModel } from '../generated/adjustment-model.generated';
export type { HighlightRecoveryMode } from '../generated/adjustment-model.generated';
export {
  ADJUSTMENT_RANGES,
  defaultGeneratedAdjustmentModel,
} from '../generated/adjustment-model.generated';

/**
 * White balance preset name as recorded in `crs:WhiteBalance` in the XMP
 * sidecar. Stays TS-only until #119 promotes the Rust `WhiteBalancePreset`
 * enum into the canonical schema.
 */
export type WhiteBalancePreset =
  | 'As Shot'
  | 'Auto'
  | 'Daylight'
  | 'Cloudy'
  | 'Shade'
  | 'Tungsten'
  | 'Fluorescent'
  | 'Flash'
  | 'Custom';

/**
 * Geometry (crop + straighten) per spec § 3.12 / ticket #277. Mirror of
 * `raw_core::types::Crop`. Coordinates are normalised to [0, 1] against
 * the display-oriented image dimensions (post-EXIF orientation).
 *
 * Identity is the full frame at zero rotation; serialisation omits the
 * whole `crs:Crop*` group + `crs:HasCrop` marker in that case (spec § 01
 * invariant 3). `angle` is in degrees, positive = clockwise (reference-renderer convention).
 */
export interface Crop {
  top: number;
  left: number;
  bottom: number;
  right: number;
  angle: number;
}

export const CROP_IDENTITY: Crop = Object.freeze({
  top: 0,
  left: 0,
  bottom: 1,
  right: 1,
  angle: 0,
});

export function defaultCrop(): Crop {
  return { ...CROP_IDENTITY };
}

export function isIdentityCrop(c: Crop): boolean {
  return c.top === 0 && c.left === 0 && c.bottom === 1 && c.right === 1 && c.angle === 0;
}

export function isCropRectValid(c: Crop): boolean {
  return (
    c.top >= 0 &&
    c.top <= 1 &&
    c.left >= 0 &&
    c.left <= 1 &&
    c.bottom >= 0 &&
    c.bottom <= 1 &&
    c.right >= 0 &&
    c.right <= 1 &&
    c.right > c.left &&
    c.bottom > c.top
  );
}

/**
 * Per-asset develop settings. Extends the generated raw-core shape with the
 * web-only `whiteBalancePreset` selector and the nested `crop` group.
 */
export interface AdjustmentModel extends GeneratedAdjustmentModel {
  whiteBalancePreset: WhiteBalancePreset;
  crop: Crop;
  /**
   * WB slider-scale version of this model's temperature/tint (#1780/#1875).
   * `1` = pre-#1756 scale (post-DCP CAT16, 6500 K identity) — raw-core
   * converts on use; `3` = ACR calibration-frame scale with the ACR tint
   * direction (current). `2` (the #1756–#1875 scale, tint axis inverted vs
   * ACR) never survives a parse: the loader negates authored tint and
   * normalizes the model to `3`. Parsed from `papp:WbScaleVersion` (absent
   * stamp on a Maple-authored sidecar means `1`; non-Maple sidecars are
   * `3`), re-stamped as {1, 3} whenever an explicit Temperature/Tint is
   * written so a V1 sidecar's stored values keep their meaning across
   * saves. Fresh models author in the current scale. Internal parse-state
   * (like raw-core's `wb_scale_version`) — not part of the generated
   * codegen schema.
   */
  wbScaleVersion: number;
}

export function defaultAdjustmentModel(): AdjustmentModel {
  return {
    ...defaultGeneratedAdjustmentModel(),
    whiteBalancePreset: 'As Shot',
    crop: defaultCrop(),
    wbScaleVersion: 3,
  };
}

export function isDefaultAdjustment(m: AdjustmentModel): boolean {
  const d = defaultAdjustmentModel();
  // `crop` is a nested object; compare by deep value before falling back to
  // strict-equality on the flat scalar fields.
  if (!isIdentityCrop(m.crop)) return false;
  return (Object.keys(d) as Array<keyof AdjustmentModel>).every((k) => {
    if (k === 'crop') return true;
    // Parse-state, not an adjustment (#1780): a pristine pre-#1756 sidecar
    // parses to wbScaleVersion 1 with every slider at default — that must
    // not read as "has edits".
    if (k === 'wbScaleVersion') return true;
    return m[k] === d[k];
  });
}
