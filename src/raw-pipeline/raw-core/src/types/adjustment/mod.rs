//! Canonical `AdjustmentModel` and companion enums.
//!
//! This module is the **single source of truth** for the develop-settings
//! schema. Swift (`MapleCore.AdjustmentModel`) and TypeScript
//! (`maple-common/AdjustmentModel`) mirror this shape via the codegen at
//! `tools/codegen.sh`, which reads the [`schema::ADJUSTMENT_SCHEMA`] const
//! table.
//!
//! Layout:
//! - [`mod@self`] — the `AdjustmentModel` struct and the
//!   `HighlightRecoveryMode` enum; every other companion enum lives in its
//!   own sibling module and is re-exported from here.
//! - `defaults` — the `impl Default for AdjustmentModel` fresh-import
//!   values (split out in #376 for the 600-LOC budget).
//! - [`schema`] — `FieldSpec` + `ADJUSTMENT_SCHEMA` codegen table (scalars,
//!   enums, and the four point-curve fields; see that module's docstring).
//! - [`curves`] — the [`curves::ToneCurve`] point-curve type used by the
//!   four per-channel `tone_curve_*` fields below.
//!
//! Per-#326, sharpen defaults match the reference renderer's import
//! baseline (Sharpness=40, Radius=1.0, Detail=25, EdgeMasking=0) so
//! first-open output is no softer than Lightroom; the Swift hand-written
//! defaults in `AdjustmentModel.swift` mirror this.

pub mod curves;
pub mod schema;

pub use curves::{ToneCurve, ToneCurvePoint};
pub use schema::{
    transfer_mode, AdjustmentGroup, FieldKind, FieldSpec, TransferMode, ADJUSTMENT_SCHEMA,
    NON_COPYABLE_FIELDS,
};
pub use schema::{TRANSFER_XMP_ATTRIBUTES, TRANSFER_XMP_ELEMENTS};

/// User-selectable display Look. Canonical definition lives in
/// `crate::view::look` (the module that owns the LUT data and `apply`
/// implementation); this re-export keeps `AdjustmentModel.look` and
/// existing consumers building against the historical
/// `crate::types::adjustment::Look` path.
///
/// Resurrected in the Maple Look v1 epic (#505) — see
/// `docs/superpowers/specs/2026-05-26-auto-tone-and-looks-design.md`. The
/// empirical 1D LUT was originally introduced in #371, retired in #443,
/// and is being re-wired into the GPU view transforms by the L2–L5
/// follow-ups so Apple, Web, and Rust render identically.
pub use crate::view::look::Look;

// HighlightRecoveryMode split into its own submodule to stay under the
// 600-LOC hard budget (#3413), the same pattern every other companion
// enum here already follows.
mod highlight_recovery;
pub use highlight_recovery::HighlightRecoveryMode;

// WbMethod split into its own submodule to stay under the 600-LOC hard
// budget (#772).
mod wb_method;
pub use wb_method::WbMethod;

// HotPixelSuppressionMode split into its own submodule to stay under the
// 600-LOC hard budget (#1181).
mod hot_pixel_suppression;
pub use hot_pixel_suppression::HotPixelSuppressionMode;

// AutoExposureMode split into its own submodule to stay under the
// 600-LOC hard budget (#772).
mod auto_exposure;
pub use auto_exposure::AutoExposureMode;

// BlackWhiteMode split into its own submodule to stay under the
// 600-LOC hard budget (#276).
mod black_white;
pub use black_white::BlackWhiteMode;

// Crop geometry type split into its own submodule to stay under the
// 600-LOC hard budget (#772).
mod crop;
pub use crop::Crop;

// Profile / WhiteBalancePreset / ToneCurveMode split into their own
// submodule to stay under the 600-LOC hard budget (PR #1730).
mod render_enums;
mod white_balance_presets;
pub use render_enums::{Profile, ToneCurveMode, WbScaleVersion, WbSource, WhiteBalancePreset};

// LensProfileEnable split into its own submodule to stay under the
// 600-LOC hard budget (#1181).
mod lens_correction;
pub use lens_correction::LensProfileEnable;

// DemosaicChoice split into its own submodule for the same reason (#3413).
mod demosaic_choice;
pub use demosaic_choice::DemosaicChoice;

// AutoLateralCa split into its own submodule for the same reason (#3411),
// same shape as `hot_pixel_suppression`.
mod auto_lateral_ca;
pub use auto_lateral_ca::AutoLateralCa;

/// Per-image develop settings.
///
/// This struct's field order, types, and ranges are the canonical reference
/// for Swift and TypeScript mirrors. The [`ADJUSTMENT_SCHEMA`] table in
/// [`schema`] describes every scalar / enum field for codegen.
///
/// The four `tone_curve_*` fields ride the schema through the
/// `FieldKind::ToneCurve` variant (#366): codegen emits the field
/// references on Swift and TypeScript, while the `ToneCurve` value type is
/// hand-written on each platform. Identity defaults (empty curve / zero
/// parametric scalars) guarantee that these fields do not perturb the
/// pixel-parity harness against the pre-tone-curve baseline.
#[derive(Clone, Debug, PartialEq)]
pub struct AdjustmentModel {
    pub temperature: f32, // 2000..12000, default 6500
    pub tint: f32,        // -150..150 (ACR's crs:Tint span, #1870), default 0
    /// True when `crs:Temperature` was explicitly present in the parsed XMP
    /// sidecar. False for the default model (no sidecar) and for sidecars that
    /// carry `crs:WhiteBalance="Custom"` with only `crs:Tint` set (tint-only
    /// adjustments). The develop pipeline uses this to substitute the image's
    /// as-shot CCT when the temperature component was not explicitly authored.
    /// Not part of the codegen schema — internal parse-state flag. (#1729)
    pub temperature_seen: bool,
    /// True when `crs:Tint` was explicitly present in the parsed XMP sidecar.
    /// Analogous to `temperature_seen` for the tint component. The develop
    /// pipeline substitutes the as-shot tint (0.0 — we do not attempt to invert
    /// the camera's AsShotNeutral tint component) when false. (#1729)
    pub tint_seen: bool,
    /// User white-balance method (ticket #431). Default `Cat16` performs
    /// proper chromatic adaptation in CAT16 LMS cone space; legacy
    /// `DiagonalRec2020` keeps the pre-#431 von-Kries diagonal gains.
    pub wb_method: WbMethod,
    /// WB slider-scale version of the sidecar's stored temperature/tint
    /// (#1780/#1875). `V1` = pre-#1756 post-DCP CAT16 scale (converted on
    /// use by `stages::wb_camera::resolve_target_versioned`); `V2` = the
    /// #1756–#1875 scale (tint axis inverted vs ACR — authored tint is
    /// negated on use); `V3` = ACR calibration-frame scale, ACR tint
    /// direction (pass-through). Set by the XMP parser from
    /// `papp:WbScaleVersion` / the Maple-authorship heuristic; default `V3`.
    /// Not part of the codegen schema — internal parse-state, like
    /// `temperature_seen`.
    pub wb_scale_version: WbScaleVersion,
    /// Provenance of the white balance (#2434) — see [`WbSource`]. Metadata,
    /// never a render input.
    pub wb_source: WbSource,
    /// Normalised image-relative sample point when `wb_source` is `Sampled`
    /// (0..1 each, default 0).
    pub wb_sample_x: f32,
    pub wb_sample_y: f32,
    /// Estimator version behind an `Auto` / `Sampled` pair
    /// (source-specific AUTO or point-sampler version); 0 otherwise.
    pub wb_algorithm_version: f32,
    pub exposure: f32, // -4..+4 EV, default 0
    /// Brightness — scene-linear midtone-band gain (#1102, tone/zoom design
    /// spec § 4.1). Applied inside `scene_tone_controls` after exposure,
    /// before highlights/shadows/whites/blacks. Weight is exactly 0 at
    /// Y ≤ 0.05 and Y ≥ 4.0, so the histogram ends stay pinned. XMP key is
    /// `papp:Brightness` — NOT `crs:Brightness`, which is ACR PV2010 with
    /// different semantics (default +50, removed in PV2012).
    pub brightness: f32, // -100..100, default 0
    pub contrast: f32, // -100..100, default 0 (routed to AgX slope per spec § 3.6a)
    pub highlights: f32, // -100..100, default 0
    pub shadows: f32,  // -100..100, default 0
    pub whites: f32,   // -100..100, default 0
    pub blacks: f32,   // -100..100, default 0

    // Parametric tone curve — PV2012-style four-region sliders. Distinct
    // from `highlights/shadows/whites/blacks` above (those are scene
    // tone controls per spec § 3.6). Synthesises a piecewise-cubic
    // curve over the four canonical region split points (¼, ½, ¾ of the
    // authoring `[0, 1]` domain) and applies post-`scene_tone_controls`,
    // pre-`vibrance`. See `stages::tone_curves`.
    pub parametric_highlights: f32, // -100..100, default 0
    pub parametric_lights: f32,     // -100..100, default 0
    pub parametric_darks: f32,      // -100..100, default 0
    pub parametric_shadows: f32,    // -100..100, default 0

    // ACR's parametric split points (`crs:ParametricShadowSplit` /
    // `MidtoneSplit` / `HighlightSplit`, #2320). Round-tripped for sidecar
    // fidelity — a Lightroom/ACR sidecar with moved split points no longer
    // silently loses them on a Maple save. The curve builder in
    // `stages::tone_curves::parametric` does not yet consume these fields
    // (it still uses fixed 25/50/75 constants); wiring them in ripples
    // through raw-gpu's CPU-side parity port and the GpuLiveParams FFI
    // surface, tracked in #3152.
    pub parametric_shadow_split: f32,    // 0..100, default 25
    pub parametric_midtone_split: f32,   // 0..100, default 50
    pub parametric_highlight_split: f32, // 0..100, default 75

    pub vibrance: f32,                  // -100..100, default 0 (spec § 3.7)
    pub saturation: f32,                // -100..100, default 0
    pub clarity: f32,                   // -100..100, default 0 (unsharp radius 40 per spec § 3.8)
    pub texture: f32,                   // -100..100, default 0 (unsharp radius 3 per spec § 3.8)
    pub sharpen_amount: f32, // 0..150, default 40 (reference-renderer import default; spec § 3.10; 0 = stage skipped, 100 = full RL, >100 overdrive)
    pub sharpen_radius: f32, // 0.5..3.0, default 1.0 (reference-renderer import default; PSF Gaussian sigma)
    pub sharpen_detail: f32, // 0..100, default 25 (edge-attenuation strength)
    pub sharpen_masking: f32, // 0..100, default 0 (edge-mask threshold)
    pub capture_sharpening_amount: f32, // 0..100, default 0 (Richardson–Lucy strength; 0 = stage skipped)
    /// Capture-sharpening Gaussian PSF sigma in pixels (0.5..2.0, default 1.0; #456).
    pub capture_sharpening_sigma: f32,
    /// Deprecated alias for [`AdjustmentModel::capture_sharpening_sigma`] (#456).
    #[deprecated(
        since = "0.0.0",
        note = "use `capture_sharpening_sigma`; the field's meaning changed from \
                integer radius to float Gaussian sigma in PR #452"
    )]
    pub capture_sharpening_radius: f32,
    pub nr_luminance: f32, // 0..100, default 0 (spec § 3.11)
    pub nr_color: f32,     // 0..100, default 25 (default = the reference renderer's default)
    pub dehaze: f32,       // -100..100, default 0

    // S5 effects (#643): vignette (#1109), grain (#1110), film (#2683), color grade (#275).
    pub vignette_amount: f32, // -100..100, default 0 (negative = darken corners)
    pub vignette_feather: f32, // 0..100, default 50 (transition softness)
    pub grain_amount: f32,    // 0..100, default 0
    pub grain_size: f32,      // 0..100, default 25
    pub grain_roughness: f32, // 0..100, default 50
    /// Film emulation look id from the film catalog (#2683); empty = none (`papp:FilmLook`).
    pub film_look: String,
    /// Film look blend strength in percent; 100 = full look (`papp:FilmStrength`).
    pub film_strength: f32,

    // Colour grading (#275): display-linear Oklab three-zone tint (`stages::color_grade`).
    pub split_tone_shadow_hue: f32,           // 0..360, default 0
    pub split_tone_shadow_saturation: f32,    // 0..100, default 0
    pub split_tone_highlight_hue: f32,        // 0..360, default 0
    pub split_tone_highlight_saturation: f32, // 0..100, default 0
    pub split_tone_balance: f32,              // -100..100, default 0
    pub color_grade_shadow_luminance: f32,    // -100..100, default 0
    pub color_grade_midtone_hue: f32,         // 0..360, default 0
    pub color_grade_midtone_saturation: f32,  // 0..100, default 0
    pub color_grade_midtone_luminance: f32,   // -100..100, default 0
    pub color_grade_highlight_luminance: f32, // -100..100, default 0
    pub color_grade_global_hue: f32,          // 0..360, default 0
    pub color_grade_global_saturation: f32,   // 0..100, default 0
    pub color_grade_global_luminance: f32,    // -100..100, default 0

    // HSL 8-band hue/saturation/luminance (#1112, `stages::hsl`, `crs:*Adjustment*`).
    pub hue_adjustment_red: f32,            // -100..100, default 0
    pub hue_adjustment_orange: f32,         // -100..100, default 0
    pub hue_adjustment_yellow: f32,         // -100..100, default 0
    pub hue_adjustment_green: f32,          // -100..100, default 0
    pub hue_adjustment_aqua: f32,           // -100..100, default 0
    pub hue_adjustment_blue: f32,           // -100..100, default 0
    pub hue_adjustment_purple: f32,         // -100..100, default 0
    pub hue_adjustment_magenta: f32,        // -100..100, default 0
    pub saturation_adjustment_red: f32,     // -100..100, default 0
    pub saturation_adjustment_orange: f32,  // -100..100, default 0
    pub saturation_adjustment_yellow: f32,  // -100..100, default 0
    pub saturation_adjustment_green: f32,   // -100..100, default 0
    pub saturation_adjustment_aqua: f32,    // -100..100, default 0
    pub saturation_adjustment_blue: f32,    // -100..100, default 0
    pub saturation_adjustment_purple: f32,  // -100..100, default 0
    pub saturation_adjustment_magenta: f32, // -100..100, default 0
    pub luminance_adjustment_red: f32,      // -100..100, default 0
    pub luminance_adjustment_orange: f32,   // -100..100, default 0
    pub luminance_adjustment_yellow: f32,   // -100..100, default 0
    pub luminance_adjustment_green: f32,    // -100..100, default 0
    pub luminance_adjustment_aqua: f32,     // -100..100, default 0
    pub luminance_adjustment_blue: f32,     // -100..100, default 0
    pub luminance_adjustment_purple: f32,   // -100..100, default 0
    pub luminance_adjustment_magenta: f32,  // -100..100, default 0

    // Black & white mix (#276, `crs:ConvertToGrayscale` + `crs:GrayMixer*`).
    pub black_white: BlackWhiteMode,
    pub gray_mixer_red: f32,     // -100..100, default 0
    pub gray_mixer_orange: f32,  // -100..100, default 0
    pub gray_mixer_yellow: f32,  // -100..100, default 0
    pub gray_mixer_green: f32,   // -100..100, default 0
    pub gray_mixer_aqua: f32,    // -100..100, default 0
    pub gray_mixer_blue: f32,    // -100..100, default 0
    pub gray_mixer_purple: f32,  // -100..100, default 0
    pub gray_mixer_magenta: f32, // -100..100, default 0

    pub highlight_recovery: HighlightRecoveryMode,
    /// Per-image auto-exposure mode (#429). Default `On` anchors mid-gray at 0.18 before AgX.
    pub auto_exposure: AutoExposureMode,
    /// Retired DisplayLookCurve (#371/#443); kept as a no-op for `papp:Look` round-trip.
    pub look: Look,
    /// Render-shaping profile (#536): `Auto` (default) vs `Neutral` (scene-referred AgX).
    pub profile: Profile,
    /// Local adjustment layers (#280, not part of `ADJUSTMENT_SCHEMA`).
    pub local_adjustments: Vec<super::local_adjustment::LocalAdjustment>,
    /// Registered bitmap-mask rasters (#3271, not part of `ADJUSTMENT_SCHEMA`).
    pub mask_rasters: Vec<std::sync::Arc<super::local_adjustment::MaskRaster>>,
    /// Baked AI-removal layers (#1486, not part of `ADJUSTMENT_SCHEMA`).
    pub inpaint_removals: Vec<super::inpaint::Removal>,
    /// Clone / heal repair spots (#3409, not part of `ADJUSTMENT_SCHEMA`).
    pub retouch_spots: Vec<super::retouch::RetouchSpot>,
    /// Tone-curve application mode (#436): `PerChannel` (default) vs `RatioPreserving`.
    pub tone_curve_mode: ToneCurveMode,

    // Scene-linear point curves (#273, pre-AgX; `tone_curve_luma` is luma-coupled).
    pub tone_curve_luma: ToneCurve,
    pub tone_curve_red: ToneCurve,
    pub tone_curve_green: ToneCurve,
    pub tone_curve_blue: ToneCurve,

    // Display-referred point curves (#2232, `crs:ToneCurvePV2012*`, post-AgX per-channel).
    pub display_tone_curve_luma: ToneCurve,
    pub display_tone_curve_red: ToneCurve,
    pub display_tone_curve_green: ToneCurve,
    pub display_tone_curve_blue: ToneCurve,

    /// Decode-time chroma pre-filter strength (#1104, 0..100, default 0, `papp:ChromaPrefilter`).
    pub chroma_prefilter: f32,
    /// Pre-demosaic hot/dead-pixel suppression (#1106, `papp:HotPixelSuppression`).
    pub hot_pixel_suppression: HotPixelSuppressionMode,
    /// BM3D deep denoise strength (#1105, 0..100, default 0, `papp:DeepDenoise`).
    pub deep_denoise: f32,
    /// Geometry — crop rect plus straighten angle (#277, default [`Crop::IDENTITY`]).
    pub crop: Crop,

    // DNG-embedded lens corrections (#376, `crs:LensProfile*`, decode-product parameters).
    pub lens_profile_enable: LensProfileEnable,
    pub lens_correction_distortion: f32, // 0..100, default 100
    pub lens_correction_ca: f32,         // 0..100, default 100
    pub lens_correction_vignetting: f32, // 0..100, default 100

    // Manual geometry (#3410, `crs:Perspective*`, composed into `stages::perspective`).
    pub perspective_vertical: f32,   // -100..100, default 0
    pub perspective_horizontal: f32, // -100..100, default 0
    pub perspective_rotate: f32,     // -10..10 degrees, clockwise-positive, default 0
    pub perspective_scale: f32,      // 50..150 percent, default 100
    pub perspective_aspect: f32,     // -100..100, default 0
    pub perspective_x: f32,          // -100..100, default 0
    pub perspective_y: f32,          // -100..100, default 0
    /// Bayer demosaic kernel override (#3413, decode-product parameter, `papp:Demosaic`).
    pub demosaic: DemosaicChoice,
    // Profile-free lens corrections (#3411, `schema/lens_auto.rs`).
    pub auto_lateral_ca: AutoLateralCa,
    pub defringe_purple_amount: f32, // 0..20, default 0
    pub defringe_purple_hue_lo: f32, // 0..100, default 30
    pub defringe_purple_hue_hi: f32, // 0..100, default 70
    pub defringe_green_amount: f32,  // 0..20, default 0
    pub defringe_green_hue_lo: f32,  // 0..100, default 40
    pub defringe_green_hue_hi: f32,  // 0..100, default 60
    /// Versioned content-addressed LCP selection (#2435, `papp:LensProfile`).
    pub lens_profile: String,
    // Colour-grading zone-isolation controls (#5040, `papp:ColorGrade*`).
    pub color_grade_blending: f32,       // 0..100, default 100
    pub color_grade_shadow_edge: f32,    // 0.10..0.564622, default 0.564622 (MIDTONE_ANCHOR_L)
    pub color_grade_highlight_edge: f32, // 0.564622..0.90, default 0.564622 (MIDTONE_ANCHOR_L)

    // Oklab secondary color curves (#5041, `papp:ColorCurve*`, pre-AgX after `stages::hsl`).
    pub color_curve_hue_vs_hue: ToneCurve,
    pub color_curve_hue_vs_sat: ToneCurve,
    pub color_curve_hue_vs_luma: ToneCurve,
    pub color_curve_luma_vs_sat: ToneCurve,
    pub color_curve_sat_vs_sat: ToneCurve,
    pub color_curve_sat_vs_luma: ToneCurve,
}

/// Fresh-import defaults. Split into a sibling module (#376) so this
/// file stays under the 600-LOC hard budget.
pub(crate) mod defaults;

#[cfg(test)]
mod tests;
