// AdjustmentModel — per-asset develop settings.
//
// The field shape and canonical defaults are GENERATED from
// `raw_core::types::ADJUSTMENT_SCHEMA` via `tools/codegen.sh` (#118).
// This shim re-exports the generated types and adds web-only fields that
// aren't part of the canonical Rust schema yet — `whiteBalancePreset` is
// the TS-side preset selector and stays hand-written until the Rust
// `WhiteBalancePreset` enum is promoted into the canonical schema (#119).

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
 * Per-asset develop settings. Extends the generated raw-core shape with the
 * web-only `whiteBalancePreset` selector.
 */
export interface AdjustmentModel extends GeneratedAdjustmentModel {
  whiteBalancePreset: WhiteBalancePreset;
}

export function defaultAdjustmentModel(): AdjustmentModel {
  return {
    ...defaultGeneratedAdjustmentModel(),
    whiteBalancePreset: 'As Shot',
  };
}

export function isDefaultAdjustment(m: AdjustmentModel): boolean {
  const d = defaultAdjustmentModel();
  return (Object.keys(d) as Array<keyof AdjustmentModel>).every((k) => m[k] === d[k]);
}
