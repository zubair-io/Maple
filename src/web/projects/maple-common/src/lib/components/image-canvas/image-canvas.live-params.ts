// image-canvas.live-params.ts — the GPU live-session fast-path gate (#1914).
//
// The persistent `WebLiveSession` has two re-render entry points:
//   - `render_with_params(params)` — the hot path: it applies a flat array of 19
//     scalar sliders onto a CLONE of the cached, stripped develop prefix, skipping
//     XML parsing (#1038).
//   - `render(xmp)` — the full path: it parses the whole model and re-develops when
//     the prefix changed.
//
// The catch: the stripped prefix (raw-wasm `gpu_render/model.rs stripped_prefix_model`)
// ZEROES every GPU-chain slider the fast path can't carry — HSL, split-tone,
// parametric tone, sharpen, and noise-reduction — and FREEZES the kept-prefix fields
// (profile, capture sharpening, decode pre-filters, crop, …) at whatever the session
// opened with. So `render_with_params` silently drops any of those edits: they never
// appear on the live canvas until the session reopens.
//
// `canUseLiveFastPath` decides, per tick, whether the fast path can faithfully
// reproduce the model. When it can't, the caller sends no params and the worker
// routes through the full `render(xmp)` path instead (which re-develops only when the
// prefix actually changed, so the cost is a small XML parse — not a re-develop — for
// the common "creative edit + scalar drag" case).

import {
  type AdjustmentModel,
  defaultAdjustmentModel,
  isDefaultAdjustment,
} from '../../models/adjustment-model';

/**
 * Whether the 19-scalar fast path (`WebLiveSession::render_with_params`) can
 * faithfully render `model`, or whether it must route through the full
 * `render(xmp)` path (#1914).
 *
 * The fast path applies its scalars onto the stripped develop prefix, which zeroes
 * the GPU-chain sliders it can't carry. Two of those — `sharpenAmount` and `nrColor`
 * — have NON-zero defaults (40 and 25), so the prefix's zero differs from a default
 * model: the fast path faithfully reproduces the model only when both are already at
 * the prefix's zero. Every other non-scalar field must be at its default; a
 * kept-prefix field that's merely non-default (HSL, profile, capture sharpening,
 * decode pre-filters, crop, …) is frozen at the open baseline, so — to never risk a
 * dropped or stale edit — it too routes through the (still cheap, no re-develop)
 * full path.
 *
 * Comparing the remainder against the default model via the generic
 * `isDefaultAdjustment` means a NEW slider added to the schema is covered
 * automatically: it defaults to routing through the full path rather than being
 * silently dropped, so this class of bug can't recur.
 */
export function canUseLiveFastPath(model: AdjustmentModel): boolean {
  // The two prefix-zeroed chain sliders whose defaults are non-zero — the fast path
  // renders them at 0 regardless, so it's only faithful when the model wants 0.
  if (model.sharpenAmount !== 0 || model.nrColor !== 0) return false;

  const d = defaultAdjustmentModel();
  const scalarWildcarded: AdjustmentModel = {
    ...model,
    // Fields the params array carries — wildcard to default so they don't count as
    // edits (any value is faithfully reproduced by the fast path).
    exposure: d.exposure,
    brightness: d.brightness,
    contrast: d.contrast,
    highlights: d.highlights,
    shadows: d.shadows,
    whites: d.whites,
    blacks: d.blacks,
    vibrance: d.vibrance,
    saturation: d.saturation,
    temperature: d.temperature,
    tint: d.tint,
    clarity: d.clarity,
    texture: d.texture,
    dehaze: d.dehaze,
    vignetteAmount: d.vignetteAmount,
    vignetteFeather: d.vignetteFeather,
    grainAmount: d.grainAmount,
    grainSize: d.grainSize,
    grainRoughness: d.grainRoughness,
    // The WB preset is a UI label carried through temperature/tint — wildcard it too.
    whiteBalancePreset: d.whiteBalancePreset,
    // Verified at the prefix zero above; wildcard so their non-zero DEFAULTS don't
    // trip the generic default check below.
    sharpenAmount: d.sharpenAmount,
    nrColor: d.nrColor,
  };
  return isDefaultAdjustment(scalarWildcarded);
}

/**
 * Build the flat 19-scalar parameter array `WebLiveSession::render_with_params`
 * consumes (the field order is the wasm ABI contract — keep it in lockstep with
 * `render_with_params`). Only called once `canUseLiveFastPath(model)` is true.
 *
 * An As-Shot white balance is the camera display seed, not an edit: the live chain's
 * WB matrix is absolute (identity at 6500/0 over the as-shot-balanced buffer), so
 * send the identity pair, mirroring the serializer's As-Shot omission (#1892).
 */
export function buildLiveParams(model: AdjustmentModel): Float32Array {
  const wbIsAsShot = !model.whiteBalancePreset || model.whiteBalancePreset === 'As Shot';
  const params = new Float32Array(19);
  params[0] = model.exposure;
  params[1] = model.brightness;
  params[2] = model.contrast;
  params[3] = model.highlights;
  params[4] = model.shadows;
  params[5] = model.whites;
  params[6] = model.blacks;
  params[7] = model.vibrance;
  params[8] = model.saturation;
  params[9] = wbIsAsShot ? 6500 : model.temperature;
  params[10] = wbIsAsShot ? 0 : model.tint;
  params[11] = model.clarity;
  params[12] = model.texture;
  params[13] = model.dehaze;
  params[14] = model.vignetteAmount;
  params[15] = model.vignetteFeather;
  params[16] = model.grainAmount;
  params[17] = model.grainSize;
  params[18] = model.grainRoughness;
  return params;
}
