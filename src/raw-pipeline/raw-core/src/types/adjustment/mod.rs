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
//! - [`schema`] — `FieldSpec` + `ADJUSTMENT_SCHEMA` codegen table (scalars
//!   and enums only; tone-curve point lists are deliberately omitted, see
//!   that module's docstring).
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
pub use schema::{FieldKind, FieldSpec, ADJUSTMENT_SCHEMA};

// Re-export the Look enum at the canonical `crate::types::adjustment` path
// so `AdjustmentModel.look: Look` resolves without leaking the `view::`
// module structure into call sites that don't care about it. Defined in
// `crate::view::look` because the algorithm lives there.
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
}

impl Default for HighlightRecoveryMode {
    fn default() -> Self {
        Self::ChromaticAdaptation
    }
}

/// White balance preset name as recorded in `crs:WhiteBalance` in the XMP
/// sidecar. `AsShot`, `Auto`, and `Custom` carry no preset (temp,tint) pair —
/// the values stored on `AdjustmentModel` are authoritative when one of those
/// is selected. The named daylight presets map to fixed (temperature, tint)
/// per the reference renderer; see `crate::xmp::wb_preset` for the mapping table.
///
/// TypeScript already has a hand-rolled `WhiteBalancePreset` union; lifting
/// the enum into raw-core gives the codegen a single canonical declaration
/// to emit from in #119.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WhiteBalancePreset {
    AsShot,
    Auto,
    Daylight,
    Cloudy,
    Shade,
    Tungsten,
    Fluorescent,
    Flash,
    Custom,
}

impl Default for WhiteBalancePreset {
    fn default() -> Self {
        Self::AsShot
    }
}

/// Per-image develop settings.
///
/// This struct's field order, types, and ranges are the canonical reference
/// for Swift and TypeScript mirrors. The [`ADJUSTMENT_SCHEMA`] table in
/// [`schema`] describes every scalar / enum field for codegen.
///
/// **Tone-curve fields are excluded from the codegen schema** — Swift and
/// TypeScript currently mirror these four `tone_curve_*` fields by hand
/// (planned: extend `FieldKind` to carry a `ToneCurve` variant, see ticket
/// #273 follow-up). Identity defaults (empty curve / zero parametric
/// scalars) guarantee that adding these fields does not perturb the
/// pixel-parity harness against the pre-tone-curve baseline.
#[derive(Clone, Debug, PartialEq)]
pub struct AdjustmentModel {
    pub temperature: f32, // 2000..12000, default 6500
    pub tint: f32,        // -100..100, default 0
    pub exposure: f32,    // -4..+4 EV, default 0
    pub contrast: f32,    // -100..100, default 0 (routed to AgX slope per spec § 3.6a)
    pub highlights: f32,  // -100..100, default 0
    pub shadows: f32,     // -100..100, default 0
    pub whites: f32,      // -100..100, default 0
    pub blacks: f32,      // -100..100, default 0

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

    pub vibrance: f32,    // -100..100, default 0 (spec § 3.7)
    pub saturation: f32,  // -100..100, default 0
    pub clarity: f32,     // -100..100, default 0 (unsharp radius 40 per spec § 3.8)
    pub texture: f32,     // -100..100, default 0 (unsharp radius 3 per spec § 3.8)
    pub sharpen_amount: f32, // 0..150, default 40 (reference-renderer import default; spec § 3.10; 0 = stage skipped, 100 = full RL, >100 overdrive)
    pub sharpen_radius: f32, // 0.5..3.0, default 1.0 (reference-renderer import default; PSF Gaussian sigma)
    pub sharpen_detail: f32, // 0..100, default 25 (edge-attenuation strength)
    pub sharpen_masking: f32, // 0..100, default 0 (edge-mask threshold)
    pub capture_sharpening_amount: f32, // 0..100, default 0 (Richardson–Lucy strength; 0 = stage skipped)
    pub capture_sharpening_radius: f32, // 0.5..2.0, default 1.0 (PSF blur radius — see stages::capture_sharpening)
    pub nr_luminance: f32,   // 0..100, default 0 (spec § 3.11)
    pub nr_color: f32,       // 0..100, default 25 (default = the reference renderer's default)
    pub dehaze: f32,         // -100..100, default 0
    pub highlight_recovery: HighlightRecoveryMode,

    /// DisplayLookCurve (ticket #371). `Look::Default` ships the empirically-
    /// derived 1D LUT that closes ~65% of the bias-to-ACR gap; `Look::Neutral`
    /// short-circuits the stage for strict scene-referred output. Defaults to
    /// `Look::Default` — new users want the punch.
    pub look: Look,

    /// Local adjustment layers (ticket #280). Each entry pairs a `Mask`
    /// (linear / radial gradient) with a `PartialAdjustments` payload, and
    /// is applied between `dehaze` and `sharpen` in the develop chain. An
    /// empty `Vec` (the default) means the stage short-circuits — bit-for-bit
    /// identical to the pre-#280 pipeline. **Not part of `ADJUSTMENT_SCHEMA`**
    /// (see `schema` module-level doc).
    pub local_adjustments: Vec<super::local_adjustment::LocalAdjustment>,

    // Per-channel point curves. Each is a `ToneCurve` of control points in
    // `[0, 1]` × `[0, 1]` authoring space; identity == empty `Vec`. Applied
    // in the same stage as the parametric curve above:
    //
    //   `tone_curve_luma` applies in scene-linear, channels-uniformly via the
    //   Rec.2020 luma weights — like `highlights` step 2, hue is preserved
    //   by construction (uniform scalar from `Y_new / Y_old`).
    //
    //   `tone_curve_red`, `tone_curve_green`, `tone_curve_blue` apply
    //   per-channel post-luma. Per-channel curves CAN shift hue — that is
    //   their purpose (cross-channel cast control per the ticket).
    //
    // All four short-circuit when the curve is identity (`Vec::is_empty()`).
    pub tone_curve_luma: ToneCurve,
    pub tone_curve_red: ToneCurve,
    pub tone_curve_green: ToneCurve,
    pub tone_curve_blue: ToneCurve,
}

impl Default for AdjustmentModel {
    fn default() -> Self {
        Self {
            temperature: 6500.0,
            tint: 0.0,
            exposure: 0.0,
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
            capture_sharpening_radius: 1.0,
            nr_luminance: 0.0,
            nr_color: 25.0,
            dehaze: 0.0,
            highlight_recovery: HighlightRecoveryMode::ChromaticAdaptation,
            look: Look::Default,
            local_adjustments: Vec::new(),
            // Per-channel point curves default to identity (empty `Vec`).
            // See the field-level docs above on the struct.
            tone_curve_luma: ToneCurve::default(),
            tone_curve_red: ToneCurve::default(),
            tone_curve_green: ToneCurve::default(),
            tone_curve_blue: ToneCurve::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_unchanged_for_existing_scalars() {
        let m = AdjustmentModel::default();
        assert_eq!(m.temperature, 6500.0);
        assert_eq!(m.tint, 0.0);
        assert_eq!(m.exposure, 0.0);
        assert_eq!(m.contrast, 0.0);
        assert_eq!(m.highlights, 0.0);
        assert_eq!(m.shadows, 0.0);
        assert_eq!(m.whites, 0.0);
        assert_eq!(m.blacks, 0.0);
        // Per-#326 sharpening defaults converge to the reference renderer's
        // fresh-import baseline.
        assert_eq!(m.sharpen_amount, 40.0);
        assert_eq!(m.sharpen_radius, 1.0);
        assert_eq!(m.sharpen_detail, 25.0);
        assert_eq!(m.sharpen_masking, 0.0);
        assert_eq!(m.nr_color, 25.0);
        assert_eq!(m.highlight_recovery, HighlightRecoveryMode::ChromaticAdaptation);
    }

    #[test]
    fn parametric_region_defaults_are_zero() {
        let m = AdjustmentModel::default();
        assert_eq!(m.parametric_highlights, 0.0);
        assert_eq!(m.parametric_lights, 0.0);
        assert_eq!(m.parametric_darks, 0.0);
        assert_eq!(m.parametric_shadows, 0.0);
    }

    #[test]
    fn per_channel_tone_curves_default_to_identity() {
        let m = AdjustmentModel::default();
        assert!(m.tone_curve_luma.is_identity());
        assert!(m.tone_curve_red.is_identity());
        assert!(m.tone_curve_green.is_identity());
        assert!(m.tone_curve_blue.is_identity());
    }

    #[test]
    fn white_balance_preset_default_is_as_shot() {
        assert_eq!(WhiteBalancePreset::default(), WhiteBalancePreset::AsShot);
    }

    #[test]
    fn look_defaults_to_default_variant() {
        // Per ticket #371: new users get the empirical Look, not Neutral.
        let m = AdjustmentModel::default();
        assert_eq!(m.look, Look::Default);
    }
}
