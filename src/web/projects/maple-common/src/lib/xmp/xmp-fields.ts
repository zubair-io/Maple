// xmp-fields.ts — bidirectional field mapping table for AdjustmentModel ↔ XMP crs: attributes.
//
// Each entry describes one XMP attribute:
//   xmpKey       — the XML attribute name as written in the sidecar (e.g. 'crs:Exposure2012')
//   modelKey     — the AdjustmentModel property it maps to
//   serialize    — converts the model value to a string for the XML attribute
//   parse        — converts the XML attribute string to a model value
//   defaultValue — the "unset" sentinel; fields matching the default are omitted on write

import type { AdjustmentModel, WhiteBalancePreset } from '../models/adjustment-model';
import { defaultAdjustmentModel } from '../models/adjustment-model';

/**
 * Bidirectional mapping for a single XMP attribute. `K` is the key in
 * `AdjustmentModel`; the serializer/parser/default are tied to its value type,
 * so every entry in `ADJUSTMENT_FIELDS` is statically type-checked.
 */
export interface XmpFieldMapping<K extends keyof AdjustmentModel = keyof AdjustmentModel> {
  xmpKey: string;
  modelKey: K;
  serialize: (value: AdjustmentModel[K]) => string;
  parse: (str: string) => AdjustmentModel[K];
  defaultValue: (m: AdjustmentModel) => AdjustmentModel[K];
}

/** Keys whose values are numeric adjustment sliders (all fields except the WB preset). */
export type NumericAdjustmentKey = {
  [K in keyof AdjustmentModel]: AdjustmentModel[K] extends number ? K : never;
}[keyof AdjustmentModel];

/**
 * Canonical numeric wire codec (`docs/xmp-canonical-format.md` § "Number
 * formatting"): integers bare, non-integers rounded to two decimals with
 * trailing zeros dropped. Exported because the nested point tone curves
 * (#365) encode their control-point coordinates with the same codec even
 * though they are element text rather than attribute values.
 */
export const numericSerializer = (v: number): string => {
  if (Number.isInteger(v)) return String(v);
  const rounded = Math.round(v * 100) / 100;
  return rounded.toString();
};

const numericParser = (s: string): number => Number(s);

// Canonical defaults, read once. The write-omit sentinel for every numeric
// field is its model default — sourcing it here rather than hand-typing each
// one keeps the omit-on-write set in lockstep with the generated raw-core
// schema (`defaultAdjustmentModel()` extends `defaultGeneratedAdjustmentModel()`).
//
// These sentinels had drifted: `crs:Sharpness` / `crs:SharpenRadius` carried
// hand-typed 0 / 0.5 while the real defaults are 40 / 1.0. Because a value
// equal to the sentinel is omitted on write and an absent attribute reads back
// as the model default, a user's Sharpen Amount = 0 was dropped on save and
// silently restored to 40 on the next load. Deriving the sentinel from the
// model default fixes the round-trip and prevents the class of bug (#953).
const DEFAULTS = defaultAdjustmentModel();

/**
 * Build a numeric `crs:`/`papp:` field. serialize/parse are the shared numeric
 * codecs; the write-omit sentinel is the canonical model default for `modelKey`.
 */
function numericField(
  xmpKey: string,
  modelKey: NumericAdjustmentKey,
): XmpFieldMapping<NumericAdjustmentKey> {
  return {
    xmpKey,
    modelKey,
    serialize: numericSerializer,
    parse: numericParser,
    defaultValue: () => DEFAULTS[modelKey],
  };
}

export const ADJUSTMENT_FIELDS: XmpFieldMapping<NumericAdjustmentKey>[] = [
  numericField('crs:Temperature', 'temperature'),
  numericField('crs:Tint', 'tint'),
  numericField('crs:Exposure2012', 'exposure'),
  // Brightness — scene-linear midtone-band gain (#1102, tone/zoom design
  // § 4.1). Maple-proprietary `papp:` key: the ACR `crs:Brightness` key is
  // process-version-2010 with different semantics (default +50, removed in
  // PV2012) and is deliberately NOT parsed — reusing it would corrupt
  // Lightroom interop. Mirrors the Rust (`xmp/mod.rs`) and Swift
  // (`XMPSerialization.swift`) writers.
  numericField('papp:Brightness', 'brightness'),
  numericField('crs:Contrast2012', 'contrast'),
  numericField('crs:Highlights2012', 'highlights'),
  numericField('crs:Shadows2012', 'shadows'),
  numericField('crs:Whites2012', 'whites'),
  numericField('crs:Blacks2012', 'blacks'),
  // Parametric tone-curve region sliders (#365) — Lightroom-compatible
  // PV2012 keys, authored by the tone-curve widget (#1540). Mirrors the
  // Rust (`xmp/mod.rs`) and Swift (`XMPSerialization+Attrs.swift`) writers.
  numericField('crs:ParametricHighlights', 'parametricHighlights'),
  numericField('crs:ParametricLights', 'parametricLights'),
  numericField('crs:ParametricDarks', 'parametricDarks'),
  numericField('crs:ParametricShadows', 'parametricShadows'),
  numericField('crs:Vibrance', 'vibrance'),
  numericField('crs:Saturation', 'saturation'),
  numericField('crs:Clarity2012', 'clarity'),
  numericField('crs:Texture', 'texture'),
  numericField('crs:Dehaze', 'dehaze'),
  numericField('crs:Sharpness', 'sharpenAmount'),
  numericField('crs:SharpenRadius', 'sharpenRadius'),
  numericField('crs:SharpenDetail', 'sharpenDetail'),
  numericField('crs:SharpenEdgeMasking', 'sharpenMasking'),
  // Capture sharpening (Maple-proprietary Richardson-Lucy deconvolution).
  // The reference renderer has no equivalent; lives under the `papp:` namespace.
  numericField('papp:CaptureSharpeningAmount', 'captureSharpeningAmount'),
  // Canonical capture-sharpening sigma key (#456). Legacy
  // `papp:CaptureSharpeningRadius` lives in `LEGACY_READ_ALIASES` below —
  // older sidecars still parse, but writers emit Sigma exclusively (#464).
  numericField('papp:CaptureSharpeningSigma', 'captureSharpeningSigma'),
  numericField('crs:LuminanceSmoothing', 'nrLuminance'),
  numericField('crs:ColorNoiseReduction', 'nrColor'),
  // Decode-time chroma pre-filter (#1104, tone/zoom design § 3.1).
  // Maple-proprietary `papp:` key — there is no ACR equivalent (ACR's
  // ColorNoiseReduction maps onto the late-chain `nrColor` NLM above;
  // this stage runs inside the Rust decode product). Mirrors the Rust
  // (`xmp/mod.rs`) and Swift (`XMPSerialization.swift`) writers.
  numericField('papp:ChromaPrefilter', 'chromaPrefilter'),
  // BM3D deep denoise (#1105, tone/zoom design § 3.2). Maple-proprietary
  // `papp:` key; input-referred stage inside the Rust decode product.
  // Mirrors the Rust (`xmp/mod.rs`) and Swift (`XMPSerialization.swift`)
  // writers.
  numericField('papp:DeepDenoise', 'deepDenoise'),
  // ---- S5 effects fields (ticket #643) ----
  // Vignette, Grain, Split toning. Identity-stub scalars wired through
  // to the model + XMP so the editor pills aren't "Coming soon" and the
  // user's adjustments round-trip across sessions. Pipeline math is a
  // follow-up. Lightroom-compatible `crs:` keys per Adobe XMP spec so
  // sidecars interchange with Lightroom for these tools.
  numericField('crs:PostCropVignetteAmount', 'vignetteAmount'),
  numericField('crs:PostCropVignetteFeather', 'vignetteFeather'),
  numericField('crs:GrainAmount', 'grainAmount'),
  numericField('crs:GrainSize', 'grainSize'),
  // Lightroom names the third grain control "Frequency"; raw-core /
  // Maple-side surfaces it as `grainRoughness` (S5 spec § 3.13).
  numericField('crs:GrainFrequency', 'grainRoughness'),
  numericField('crs:SplitToningShadowHue', 'splitToneShadowHue'),
  numericField('crs:SplitToningShadowSaturation', 'splitToneShadowSaturation'),
  numericField('crs:SplitToningHighlightHue', 'splitToneHighlightHue'),
  numericField('crs:SplitToningHighlightSaturation', 'splitToneHighlightSaturation'),
  numericField('crs:SplitToningBalance', 'splitToneBalance'),
  // ---- HSL 8-band per-channel fields (ticket #1112) ----
  // Scene-linear Oklab, normalized raised-cosine partition; range -100..+100.
  // ACR-compatible crs: keys for sidecar interchange.
  numericField('crs:HueAdjustmentRed', 'hueAdjustmentRed'),
  numericField('crs:HueAdjustmentOrange', 'hueAdjustmentOrange'),
  numericField('crs:HueAdjustmentYellow', 'hueAdjustmentYellow'),
  numericField('crs:HueAdjustmentGreen', 'hueAdjustmentGreen'),
  numericField('crs:HueAdjustmentAqua', 'hueAdjustmentAqua'),
  numericField('crs:HueAdjustmentBlue', 'hueAdjustmentBlue'),
  numericField('crs:HueAdjustmentPurple', 'hueAdjustmentPurple'),
  numericField('crs:HueAdjustmentMagenta', 'hueAdjustmentMagenta'),
  numericField('crs:SaturationAdjustmentRed', 'saturationAdjustmentRed'),
  numericField('crs:SaturationAdjustmentOrange', 'saturationAdjustmentOrange'),
  numericField('crs:SaturationAdjustmentYellow', 'saturationAdjustmentYellow'),
  numericField('crs:SaturationAdjustmentGreen', 'saturationAdjustmentGreen'),
  numericField('crs:SaturationAdjustmentAqua', 'saturationAdjustmentAqua'),
  numericField('crs:SaturationAdjustmentBlue', 'saturationAdjustmentBlue'),
  numericField('crs:SaturationAdjustmentPurple', 'saturationAdjustmentPurple'),
  numericField('crs:SaturationAdjustmentMagenta', 'saturationAdjustmentMagenta'),
  numericField('crs:LuminanceAdjustmentRed', 'luminanceAdjustmentRed'),
  numericField('crs:LuminanceAdjustmentOrange', 'luminanceAdjustmentOrange'),
  numericField('crs:LuminanceAdjustmentYellow', 'luminanceAdjustmentYellow'),
  numericField('crs:LuminanceAdjustmentGreen', 'luminanceAdjustmentGreen'),
  numericField('crs:LuminanceAdjustmentAqua', 'luminanceAdjustmentAqua'),
  numericField('crs:LuminanceAdjustmentBlue', 'luminanceAdjustmentBlue'),
  numericField('crs:LuminanceAdjustmentPurple', 'luminanceAdjustmentPurple'),
  numericField('crs:LuminanceAdjustmentMagenta', 'luminanceAdjustmentMagenta'),
  // ---- B&W gray-mixer 8-band fields (ticket #276) ----
  // Scene-linear Oklab, same 8 hue-band partition as the HSL fields above;
  // range -100..+100. Drive luminance per band when `crs:ConvertToGrayscale`
  // is "True" (the toggle field itself is enum-serialized separately in
  // XmpSerializerService, mirroring the other `crs:`/`papp:` enum fields —
  // it doesn't fit the numeric-field shape here). ACR-compatible crs: keys.
  numericField('crs:GrayMixerRed', 'grayMixerRed'),
  numericField('crs:GrayMixerOrange', 'grayMixerOrange'),
  numericField('crs:GrayMixerYellow', 'grayMixerYellow'),
  numericField('crs:GrayMixerGreen', 'grayMixerGreen'),
  numericField('crs:GrayMixerAqua', 'grayMixerAqua'),
  numericField('crs:GrayMixerBlue', 'grayMixerBlue'),
  numericField('crs:GrayMixerPurple', 'grayMixerPurple'),
  numericField('crs:GrayMixerMagenta', 'grayMixerMagenta'),
];

/** WhiteBalance preset — serialized as a string attribute, not a number. */
export const WB_PRESET_FIELD = {
  xmpKey: 'crs:WhiteBalance',
  modelKey: 'whiteBalancePreset' as keyof AdjustmentModel,
};

/**
 * Read-only legacy aliases. Each entry maps a deprecated XMP key to the
 * current canonical model field — the parser consults this table for keys
 * not found in `ADJUSTMENT_FIELDS`, and the serializer never reads it.
 *
 * Currently only `papp:CaptureSharpeningRadius` → `captureSharpeningSigma`
 * (PR #463 renamed the field; #464 retired the write path). Sigma always
 * wins when both keys are present — the canonical entry in
 * `ADJUSTMENT_FIELDS` is applied first by the parser; the legacy alias
 * only fires when sigma is absent.
 */
export const LEGACY_READ_ALIASES: ReadonlyArray<XmpFieldMapping<NumericAdjustmentKey>> = [
  numericField('papp:CaptureSharpeningRadius', 'captureSharpeningSigma'),
];
