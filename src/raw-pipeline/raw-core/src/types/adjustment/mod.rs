//! Canonical `AdjustmentModel` and companion enums.
//!
//! This module is the **single source of truth** for the develop-settings
//! schema. Swift (`MapleCore.AdjustmentModel`) and TypeScript
//! (`maple-common/AdjustmentModel`) mirror this shape via the codegen at
//! `tools/codegen.sh`, which reads the [`schema::ADJUSTMENT_SCHEMA`] const
//! table.
//!
//! Layout:
//! - [`mod@self`] — the `AdjustmentModel` struct, its defaults, and the
//!   `HighlightRecoveryMode` / `WhiteBalancePreset` enums.
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
    AdjustmentGroup, FieldKind, FieldSpec, ADJUSTMENT_SCHEMA, NON_COPYABLE_FIELDS,
};

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

/// Highlight reconstruction mode per spec § 3.3a.
///
/// Default is `ChromaticAdaptation` (Path C — `AsShotNeutral`-aware
/// reconstruction). #335 flipped the default after re-measuring the parity
/// harness: the original PR for #325 read the unchanged main-bias numbers
/// as a regression, but a per-case Off-vs-CA diff shows the algorithm is a
/// near-noop on the budget-gated baseline fixtures (ΔΔE ≤ 0.001, bias deltas
/// in the 5th decimal) — there was nothing to tune.
///
/// `Off` skips the stage entirely; users can opt out per-image via
/// `papp:HighlightRecoveryMode="Off"` in the XMP sidecar. `Blend` and
/// `Luminance` are kept for back-compat with XMP sidecars produced before
/// #325; both silently upgrade to `ChromaticAdaptation` at apply time. The
/// old implementations had a wrong-directional pull (`Blend` lerped clipped
/// channels DOWN, magnifying the magenta cast) and a partial single-channel
/// scope (`Luminance` ignored 2-channel clips), so silently fixing them was
/// preferred to preserving a known-broken behavior behind an enum variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HighlightRecoveryMode {
    Off,
    /// Legacy — silently upgraded to `ChromaticAdaptation`. Kept so old XMPs
    /// continue to parse.
    Blend,
    /// Legacy — silently upgraded to `ChromaticAdaptation`. Kept so old XMPs
    /// continue to parse.
    Luminance,
    /// Path C: `AsShotNeutral`-aware reconstruction. Default since #335.
    ChromaticAdaptation,
    /// Post-DCP Oklab chroma reduction (ticket #471). Opt-in. Runs in
    /// scene-linear Rec.2020 D65 (where Oklab is well-defined) after
    /// `dcp::apply_colorimetry` — NOT in camera-native RGB. At each clipped
    /// pixel, scales Oklab `(a, b)` by a factor that brings the worst
    /// channel into gamut; hue (`atan2(b, a)`) is preserved by construction
    /// because both `a` and `b` are scaled by the same factor. The pre-DCP
    /// `apply()` call is a no-op for this variant — see
    /// `stages::highlight_recovery_oklab::apply_post_dcp`.
    OklabChromaReduction,
}

impl Default for HighlightRecoveryMode {
    fn default() -> Self {
        Self::ChromaticAdaptation
    }
}

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
pub use render_enums::{Profile, ToneCurveMode, WbScaleVersion, WhiteBalancePreset};

// LensProfileEnable split into its own submodule to stay under the
// 600-LOC hard budget (#1181).
mod lens_correction;
pub use lens_correction::LensProfileEnable;

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

    pub vibrance: f32,                  // -100..100, default 0 (spec § 3.7)
    pub saturation: f32,                // -100..100, default 0
    pub clarity: f32,                   // -100..100, default 0 (unsharp radius 40 per spec § 3.8)
    pub texture: f32,                   // -100..100, default 0 (unsharp radius 3 per spec § 3.8)
    pub sharpen_amount: f32, // 0..150, default 40 (reference-renderer import default; spec § 3.10; 0 = stage skipped, 100 = full RL, >100 overdrive)
    pub sharpen_radius: f32, // 0.5..3.0, default 1.0 (reference-renderer import default; PSF Gaussian sigma)
    pub sharpen_detail: f32, // 0..100, default 25 (edge-attenuation strength)
    pub sharpen_masking: f32, // 0..100, default 0 (edge-mask threshold)
    pub capture_sharpening_amount: f32, // 0..100, default 0 (Richardson–Lucy strength; 0 = stage skipped)
    /// Capture-sharpening Gaussian PSF sigma in pixels (range 0.5..2.0, default 1.0).
    ///
    /// PR #452 swapped the integer-radius tripled-box-blur PSF for a true
    /// Gaussian parameterised by float sigma. The XMP/model field was kept
    /// as `capture_sharpening_radius` at that point — a silent semantic
    /// shift. #456 renames the canonical model field to
    /// `capture_sharpening_sigma`; the legacy `capture_sharpening_radius`
    /// is retained as a `#[deprecated]` alias so external Rust callers
    /// still compile (with a warning) and the XMP parser still reads
    /// `papp:CaptureSharpeningRadius` for back-compat with existing sidecars.
    pub capture_sharpening_sigma: f32,
    /// Deprecated: use [`AdjustmentModel::capture_sharpening_sigma`].
    ///
    /// The field's interpretation changed in PR #452 from integer radius
    /// (tripled-box-blur taps) to float Gaussian sigma in pixels — same
    /// numeric type, different units. #456 renames the canonical field;
    /// this alias remains so source constructing `AdjustmentModel` by name
    /// keeps compiling. No code reads this field anymore — the XMP
    /// back-compat read-path writes `papp:CaptureSharpeningRadius` into
    /// `capture_sharpening_sigma` directly, with no rescale (no shipping
    /// sidecar carries a non-zero value, so rescaling would be a guess).
    #[deprecated(
        since = "0.0.0",
        note = "use `capture_sharpening_sigma`; the field's meaning changed from \
                integer radius to float Gaussian sigma in PR #452"
    )]
    pub capture_sharpening_radius: f32, // 0.5..2.0, default 1.0 (kept as a deprecated alias; see field doc)
    pub nr_luminance: f32, // 0..100, default 0 (spec § 3.11)
    pub nr_color: f32,     // 0..100, default 25 (default = the reference renderer's default)
    pub dehaze: f32,       // -100..100, default 0

    // S5 effects fields (ticket #643 model/UI). Defaults are chosen so an
    // absent-attribute sidecar (or a freshly-created model) produces
    // bit-identical output to the pre-#643 pipeline. All three tools are
    // real pipeline stages now: vignette (#1109), grain (#1110), split
    // tone (#1111).
    //
    // Vignette (#1109, tone/zoom design § 10.1): scene-linear radial EV
    // gain, `stages::vignette`. Drag-bar drives `vignette_amount`;
    // `vignette_feather` maps onto the mask transition width.
    pub vignette_amount: f32, // -100..100, default 0 (negative = darken corners)
    pub vignette_feather: f32, // 0..100, default 50 (transition softness)

    // Grain (#1110, tone/zoom design § 10.2): display-linear deterministic
    // film grain, `stages::grain`. Drag-bar drives `grain_amount`; size +
    // roughness ride the sub-param row.
    pub grain_amount: f32,    // 0..100, default 0
    pub grain_size: f32,      // 0..100, default 25
    pub grain_roughness: f32, // 0..100, default 50

    // Colour grading (#275): display-linear Oklab three-zone tint,
    // `stages::color_grade`. Supersedes split toning (#1111) the way
    // Lightroom's Color Grading panel superseded the Split Toning panel —
    // the shadow/highlight hue+saturation pairs and the balance ARE the
    // split-toning sliders, and keep writing ACR's own `crs:SplitToning*`
    // keys, exactly as ACR does from its Color Grading panel.
    // Hue is in degrees (Lightroom convention); saturation is `[0, 100]`.
    pub split_tone_shadow_hue: f32,           // 0..360, default 0
    pub split_tone_shadow_saturation: f32,    // 0..100, default 0
    pub split_tone_highlight_hue: f32,        // 0..360, default 0
    pub split_tone_highlight_saturation: f32, // 0..100, default 0
    pub split_tone_balance: f32,              // -100..100, default 0

    // The rest of the Color Grading panel (#275): the midtone zone, the
    // three per-zone luminance offsets, and the unweighted global wheel.
    // ACR namespaces these under `crs:ColorGrade*`.
    pub color_grade_shadow_luminance: f32,    // -100..100, default 0
    pub color_grade_midtone_hue: f32,         // 0..360, default 0
    pub color_grade_midtone_saturation: f32,  // 0..100, default 0
    pub color_grade_midtone_luminance: f32,   // -100..100, default 0
    pub color_grade_highlight_luminance: f32, // -100..100, default 0
    pub color_grade_global_hue: f32,          // 0..360, default 0
    pub color_grade_global_saturation: f32,   // 0..100, default 0
    pub color_grade_global_luminance: f32,    // -100..100, default 0

    // HSL 8-band hue/saturation/luminance (#1112, tone/zoom design § 10.4).
    // 24 ACR `crs:` fields: 8 hue adjustments, 8 saturation adjustments,
    // 8 luminance adjustments. All default to 0 (identity). Range −100..+100.
    // Scene-linear Oklab stage positioned after saturation, before clarity.
    // Chroma-gated so the neutral axis is exactly stable.
    // XMP keys: `crs:HueAdjustmentRed` … `crs:HueAdjustmentMagenta`,
    //           `crs:SaturationAdjustmentRed` … `crs:SaturationAdjustmentMagenta`,
    //           `crs:LuminanceAdjustmentRed` … `crs:LuminanceAdjustmentMagenta`.
    // Band order: Red(0), Orange(1), Yellow(2), Green(3),
    //             Aqua(4), Blue(5), Purple(6), Magenta(7).
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

    // Black & white mix (#276). `black_white` toggles the 8-band Oklab
    // stage into its monochrome path; the eight `gray_mixer_*` weights
    // then drive the `L` plane over the SAME hue bands as the HSL panel
    // (`stages::hsl::HUE_CENTERS_DEG` / `BAND_HALF_WIDTH_DEG` /
    // `CHROMA_GATE_C0` — deliberately not a second set of constants) and
    // chroma is forced to zero everywhere. The 24 HSL sliders above are
    // inert while `black_white` is `On`.
    // XMP keys: `crs:ConvertToGrayscale`, `crs:GrayMixerRed` …
    //           `crs:GrayMixerMagenta` (ACR/Lightroom-compatible).
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

    /// Per-image auto-exposure mode (ticket #429). Default `On` — places
    /// scene mid-gray at 0.18 before AgX so every camera/scene lands at
    /// the same point on the AgX sigmoid by default. `exposure` stacks
    /// additively in EV on top: `final = scene * anchor_gain * 2^exposure`.
    /// Set to `Off` for strict scene-referred output.
    pub auto_exposure: AutoExposureMode,

    /// DisplayLookCurve (ticket #371; **retired #443** — Wave-3 closing
    /// step of #416). The empirical 1D u8→u8 LUT was removed; both
    /// `Look::Default` and `Look::Neutral` are now identical no-ops at the
    /// pipeline level. The field is kept so `papp:Look` in pre-#443
    /// sidecars round-trips. Setting this field has **no effect on
    /// rendered output** — gated by `tests::look_field_is_no_op` in the
    /// render module.
    pub look: Look,

    /// Render-shaping profile (Auto Profile Phase 1, ticket #536). Selects
    /// between the per-image curve fit (`Auto`, default) and the
    /// scene-referred AgX view transform (`Neutral`). Pipeline dispatch
    /// is wired in T6; until then this field is parsed and round-trips
    /// through XMP but has no effect on rendered output. See [`Profile`].
    pub profile: Profile,

    /// Local adjustment layers (ticket #280). Each entry pairs a `Mask`
    /// (linear / radial gradient) with a `PartialAdjustments` payload, and
    /// is applied between `dehaze` and `sharpen` in the develop chain. An
    /// empty `Vec` (the default) means the stage short-circuits — bit-for-bit
    /// identical to the pre-#280 pipeline. **Not part of `ADJUSTMENT_SCHEMA`**
    /// (see `schema` module-level doc).
    pub local_adjustments: Vec<super::local_adjustment::LocalAdjustment>,

    /// Baked AI-removal layers (ticket #1486). Each carries a mask region, a
    /// content-hash reference to the synthetic-raw patch
    /// (`.maple/inpaint/<patch_ref>.f16`), and the bake-grade snapshot. The
    /// patch pixels are out-of-band; only this metadata round-trips through XMP
    /// (`papp:InpaintRemovals`). **Not part of `ADJUSTMENT_SCHEMA`** (same
    /// rationale as `local_adjustments`). Empty `Vec` (the default) is a no-op —
    /// the compositor short-circuits.
    pub inpaint_removals: Vec<super::inpaint::Removal>,

    /// Tone-curve application mode (ticket #436). Controls how the
    /// three per-channel `tone_curve_{red,green,blue}` curves are applied:
    /// `PerChannel` (default) treats them as three independent 1-D LUTs
    /// per RGB lane (hue shifts on saturated input); `RatioPreserving`
    /// folds them through Rec.2020 luma to produce one scale factor (hue
    /// preserved). See [`ToneCurveMode`].
    pub tone_curve_mode: ToneCurveMode,

    // Per-channel point curves. Each is a `ToneCurve` of control points in
    // `[0, 1]` × `[0, 1]` authoring space; identity == empty `Vec`. Applied
    // in the same stage as the parametric curve above:
    //
    //   `tone_curve_luma` applies in scene-linear, channels-uniformly via the
    //   Rec.2020 luma weights — like `highlights` step 2, hue is preserved
    //   by construction (uniform scalar from `Y_new / Y_old`).
    //
    //   `tone_curve_red`, `tone_curve_green`, `tone_curve_blue` apply per
    //   `tone_curve_mode` above — `PerChannel` (hue-shifting) or
    //   `RatioPreserving` (hue-preserving via Rec.2020 luma fold).
    //
    // All four short-circuit when the curve is identity (`Vec::is_empty()`).
    pub tone_curve_luma: ToneCurve,
    pub tone_curve_red: ToneCurve,
    pub tone_curve_green: ToneCurve,
    pub tone_curve_blue: ToneCurve,

    /// Decode-time chroma pre-filter strength (#1104, tone/zoom design
    /// § 3.1). Luma-guided sparse cross-bilateral on opponent chroma,
    /// applied inside the decode product (post-DCP, pre auto-exposure) —
    /// see `stages::chroma_prefilter`. 0 (default) is an exact
    /// bit-identical skip. Because it is a decode-product parameter,
    /// changing it invalidates the decoded-image caches (Apple keys the
    /// decode on the baked/stripped model, web on the stripped prefix
    /// model — both carry this field). XMP key `papp:ChromaPrefilter`.
    ///
    /// Declared at the struct tail (not next to `nr_color`) so schema
    /// additions stay append-only — keeps parallel schema PRs (#1129 /
    /// #1133) rebase-mechanical.
    pub chroma_prefilter: f32, // 0..100, default 0

    /// Hot/dead-pixel suppression (#1106, tone/zoom design § 10.6).
    /// Pre-demosaic same-color-neighbor outlier replacement — see
    /// [`HotPixelSuppressionMode`] and `stages::hot_pixel`. `Off`
    /// (default) is an exact bit-identical skip. A decode-product
    /// parameter: carried by the same decoded-image cache keys as
    /// `chroma_prefilter`. XMP key `papp:HotPixelSuppression`.
    pub hot_pixel_suppression: HotPixelSuppressionMode,

    /// BM3D deep denoise strength (#1105, tone/zoom design § 3.2).
    /// Two-stage collaborative filtering on opponent channels, applied
    /// input-referred immediately after `chroma_prefilter` inside the
    /// decode product — see `stages::bm3d`. 0 (default) is an exact
    /// bit-identical skip. A decode-product parameter: the decoded-image
    /// caches key on it like `chroma_prefilter` (Apple #950 baked model,
    /// web stripped prefix model); NOT keyed on sidecar mtime. Never runs
    /// on the tile path (the tile FFI rejects it like dehaze). XMP key
    /// `papp:DeepDenoise`.
    pub deep_denoise: f32, // 0..100, default 0

    /// Geometry — crop rect (normalised to display-oriented dimensions) plus
    /// straighten angle. Default is [`Crop::IDENTITY`] (full frame, 0°), in
    /// which case the crop stage is skipped and the XMP serializer omits the
    /// whole `crs:Crop*` group + `crs:HasCrop` marker per spec § 01 invariant 3.
    /// See [`Crop`] and `stages::crop` for the geometry math.
    pub crop: Crop,

    // DNG-embedded lens corrections (#376). The vendor's own distortion /
    // lateral-CA / vignetting corrections travel inside the DNG as
    // `OpcodeList3` opcodes (`WarpRectilinear`, `FixVignetteRadial`,
    // `GainMap`); these four fields scale them. They are **decode-product**
    // parameters — the opcodes are resampled/multiplied into the demosaiced
    // camera-RGB buffer before DCP, upstream of every per-tick GPU stage —
    // so they belong to the same cache-key family as `chroma_prefilter`,
    // `deep_denoise` and `hot_pixel_suppression`, and there is deliberately
    // no WGSL/Metal mirror of them.
    //
    // Declared at the struct tail so schema additions stay append-only.
    /// Master on/off for the DNG's embedded lens corrections. `Off`
    /// overrides all three scales below. XMP key `crs:LensProfileEnable`.
    pub lens_profile_enable: LensProfileEnable,
    /// Geometric-distortion correction strength — the `WarpRectilinear`
    /// component common to all three planes. XMP key
    /// `crs:LensProfileDistortionScale`.
    pub lens_correction_distortion: f32, // 0..100, default 100
    /// Lateral chromatic-aberration correction strength — each plane's
    /// `WarpRectilinear` deviation from the green reference plane. A DNG
    /// carrying a single coefficient set encodes no CA, so this field has
    /// no effect there. XMP key
    /// `crs:LensProfileChromaticAberrationScale`.
    pub lens_correction_ca: f32, // 0..100, default 100
    /// Vignetting / lens-shading correction strength — the
    /// `FixVignetteRadial` and `GainMap` gain opcodes. XMP key
    /// `crs:LensProfileVignettingScale`.
    pub lens_correction_vignetting: f32, // 0..100, default 100
}

impl Default for AdjustmentModel {
    fn default() -> Self {
        Self {
            temperature: 6500.0,
            tint: 0.0,
            temperature_seen: false,
            tint_seen: false,
            wb_method: WbMethod::Cat16,
            wb_scale_version: WbScaleVersion::V5,
            exposure: 0.0,
            brightness: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            parametric_highlights: 0.0,
            parametric_lights: 0.0,
            parametric_darks: 0.0,
            parametric_shadows: 0.0,
            vibrance: 0.0,
            saturation: 0.0,
            clarity: 0.0,
            texture: 0.0,
            // Sharpen defaults converge to the reference renderer's fresh-import baseline
            // (Sharpness=40, Radius=1.0, Detail=25, EdgeMasking=0) per #326.
            // Prior identity defaults (amount=0, radius=0.5) shipped soft
            // first-open output and conflated calibration drift with a
            // defaults mismatch in the perceptual harness.
            sharpen_amount: 40.0,
            sharpen_radius: 1.0,
            sharpen_detail: 25.0,
            sharpen_masking: 0.0,
            capture_sharpening_amount: 0.0,
            capture_sharpening_sigma: 1.0,
            #[allow(deprecated)]
            capture_sharpening_radius: 1.0,
            nr_luminance: 0.0,
            nr_color: 25.0,
            dehaze: 0.0,
            // Per-#643: S5 effects fields (vignette / grain / split tone).
            // Identity-stub defaults so first-open output is unchanged.
            vignette_amount: 0.0,
            vignette_feather: 50.0,
            grain_amount: 0.0,
            grain_size: 25.0,
            grain_roughness: 50.0,
            split_tone_shadow_hue: 0.0,
            split_tone_shadow_saturation: 0.0,
            split_tone_highlight_hue: 0.0,
            split_tone_highlight_saturation: 0.0,
            split_tone_balance: 0.0,
            // Colour grading (#275) — the remaining wheels. All 0, so the
            // stage short-circuits to a bit-identical no-op.
            color_grade_shadow_luminance: 0.0,
            color_grade_midtone_hue: 0.0,
            color_grade_midtone_saturation: 0.0,
            color_grade_midtone_luminance: 0.0,
            color_grade_highlight_luminance: 0.0,
            color_grade_global_hue: 0.0,
            color_grade_global_saturation: 0.0,
            color_grade_global_luminance: 0.0,
            // HSL 8-band defaults: all 0 (identity; stage short-circuits).
            hue_adjustment_red: 0.0,
            hue_adjustment_orange: 0.0,
            hue_adjustment_yellow: 0.0,
            hue_adjustment_green: 0.0,
            hue_adjustment_aqua: 0.0,
            hue_adjustment_blue: 0.0,
            hue_adjustment_purple: 0.0,
            hue_adjustment_magenta: 0.0,
            saturation_adjustment_red: 0.0,
            saturation_adjustment_orange: 0.0,
            saturation_adjustment_yellow: 0.0,
            saturation_adjustment_green: 0.0,
            saturation_adjustment_aqua: 0.0,
            saturation_adjustment_blue: 0.0,
            saturation_adjustment_purple: 0.0,
            saturation_adjustment_magenta: 0.0,
            luminance_adjustment_red: 0.0,
            luminance_adjustment_orange: 0.0,
            luminance_adjustment_yellow: 0.0,
            luminance_adjustment_green: 0.0,
            luminance_adjustment_aqua: 0.0,
            luminance_adjustment_blue: 0.0,
            luminance_adjustment_purple: 0.0,
            luminance_adjustment_magenta: 0.0,
            // Black & white mix (#276): colour render, flat mixer. Both
            // halves are identity — the 8-band stage keeps its HSL path.
            black_white: BlackWhiteMode::Off,
            gray_mixer_red: 0.0,
            gray_mixer_orange: 0.0,
            gray_mixer_yellow: 0.0,
            gray_mixer_green: 0.0,
            gray_mixer_aqua: 0.0,
            gray_mixer_blue: 0.0,
            gray_mixer_purple: 0.0,
            gray_mixer_magenta: 0.0,
            highlight_recovery: HighlightRecoveryMode::ChromaticAdaptation,
            // Per-#429: scene-anchor on by default — places mid-gray at
            // 0.18 before AgX. Users can opt out per-image for strict
            // scene-referred output.
            auto_exposure: AutoExposureMode::On,
            look: Look::Default,
            // Per-#536: Auto Profile is the new default — per-image curve
            // fit at render time. Users opt out per-image via
            // `papp:Profile="Neutral"` (AgX scene-referred view transform).
            profile: Profile::Auto,
            local_adjustments: Vec::new(),
            inpaint_removals: Vec::new(),
            // Per-#436: `PerChannel` is the pre-existing behavior. Default
            // chosen for backward compatibility — `RatioPreserving` is opt-in.
            tone_curve_mode: ToneCurveMode::PerChannel,
            // Per-channel point curves default to identity (empty `Vec`).
            // See the field-level docs above on the struct.
            tone_curve_luma: ToneCurve::default(),
            tone_curve_red: ToneCurve::default(),
            tone_curve_green: ToneCurve::default(),
            tone_curve_blue: ToneCurve::default(),
            // Per-#1104: decode-time chroma pre-filter ships default-off.
            chroma_prefilter: 0.0,
            // Per-#1106: off until a harness sweep shows enabling is free.
            hot_pixel_suppression: HotPixelSuppressionMode::Off,
            // Per-#1105: heavy opt-in stage, always default-off.
            deep_denoise: 0.0,
            // Per-#277: geometry stage defaults to full-frame identity.
            crop: Crop::IDENTITY,
            // Per-#376: the vendor's embedded corrections are authoritative,
            // so they apply at full strength by default — matching ACR,
            // which enables its lens profile whenever the DNG carries one.
            // A RAW without `OpcodeList3` has nothing to scale, so these
            // defaults are a no-op there.
            lens_profile_enable: LensProfileEnable::On,
            lens_correction_distortion: 100.0,
            lens_correction_ca: 100.0,
            lens_correction_vignetting: 100.0,
        }
    }
}

#[cfg(test)]
mod tests;
