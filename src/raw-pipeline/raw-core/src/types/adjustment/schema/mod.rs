//! Codegen-facing description of every scalar / enum field on
//! [`super::AdjustmentModel`].
//!
//! The schema is a flat const table rather than a proc-macro so the WASM
//! build stays lean (no `syn` / `quote` pull-in). Generators load
//! [`ADJUSTMENT_SCHEMA`] via the regular crate-level API.
//!
//! The `local_adjustments` array (per ticket #280) is a `Vec<LocalAdjustment>`
//! that defaults to empty. It is intentionally **not** part of
//! `ADJUSTMENT_SCHEMA` because the schema table only describes scalar / enum
//! fields for codegen; the local-adjustment layer carries its own structured
//! schema in `crate::types::local_adjustment`. The `schema_matches_struct`
//! drift test below allow-lists `local_adjustments` as a known exception.
//!
//! This module is the **single source of truth** for the develop-settings
//! schema. Swift (`MapleCore.AdjustmentModel`) and TypeScript
//! (`maple-common/AdjustmentModel`) mirror this shape today by hand; future
//! codegen (#118 / #119) will consume the [`ADJUSTMENT_SCHEMA`] table below
//! to keep all three platforms in lockstep.
//!
//! Note: the schema captures only `F32` and `Enum` fields. The tone-curve
//! point lists (`tone_curve_*`) and the parametric region scalars
//! intentionally route through the schema too — the parametric scalars are
//! `F32` (same as `highlights` etc.), and the tone-curve point lists are
//! omitted entirely. Cross-language mirroring of the curve type is a
//! follow-up ticket to #273; codegen for tone curves needs a new
//! `FieldKind::ToneCurve` variant and matching emit logic on Swift / TS.


/// Kind of value carried by an `AdjustmentModel` field, for codegen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldKind {
    /// 32-bit float scalar with a `[min, max]` range and an f32 default.
    F32,
    /// Tagged enum. The `enum_name` slot on [`FieldSpec`] is populated for
    /// this variant; the `range` / `default_f32` slots are meaningless.
    Enum,
}

/// Codegen-facing description of a single `AdjustmentModel` field.
///
/// For `F32` fields: `range` is `(min, max)`, `default_f32` is the
/// raw-core default. For `Enum` fields: `enum_name` is the Rust enum's
/// short type name (e.g. `"HighlightRecoveryMode"`) and the numeric slots
/// are unused (set to `(0.0, 0.0)` / `0.0`).
#[derive(Clone, Copy, Debug)]
pub struct FieldSpec {
    /// Rust identifier on `AdjustmentModel` (snake_case).
    pub name: &'static str,
    /// Field kind: scalar or tagged enum.
    pub kind: FieldKind,
    /// `(min, max)` for `F32`; unused for `Enum`.
    pub range: (f32, f32),
    /// Raw-core default for `F32`; unused for `Enum`.
    pub default_f32: f32,
    /// Short Rust type name for `Enum`; empty for `F32`.
    pub enum_name: &'static str,
    /// Human-readable doc comment, single line.
    pub doc: &'static str,
}

/// Canonical, ordered description of every codegen-eligible field on
/// [`AdjustmentModel`].
///
/// Order matches the struct's field declaration order. Adding a scalar or
/// enum field to the struct without adding a matching entry here (or vice
/// versa) is a schema drift — the `schema_matches_struct` test below catches
/// it. Tone-curve point lists are deliberately absent; see the module
/// docstring.
pub const ADJUSTMENT_SCHEMA: &[FieldSpec] = &[
    FieldSpec {
        name: "temperature",
        kind: FieldKind::F32,
        range: (2000.0, 12000.0),
        default_f32: 6500.0,
        enum_name: "",
        doc: "White balance correlated color temperature in Kelvin.",
    },
    FieldSpec {
        name: "tint",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "White balance green/magenta tint.",
    },
    FieldSpec {
        name: "wb_method",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "WbMethod",
        doc: "User white-balance method (ticket #431). 'Cat16' performs proper chromatic adaptation in CAT16 cone space (default); 'DiagonalRec2020' is the legacy per-channel diagonal-gain path retained for parity A/B.",
    },
    FieldSpec {
        name: "exposure",
        kind: FieldKind::F32,
        range: (-4.0, 4.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Linear exposure in EV stops applied in scene-linear.",
    },
    FieldSpec {
        name: "contrast",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Contrast — routed to AgX slope per spec § 3.6a.",
    },
    FieldSpec {
        name: "highlights",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Highlights tone-region control.",
    },
    FieldSpec {
        name: "shadows",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Shadows tone-region control.",
    },
    FieldSpec {
        name: "whites",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Whites tone-region control.",
    },
    FieldSpec {
        name: "blacks",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Blacks tone-region control.",
    },
    FieldSpec {
        name: "parametric_highlights",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Parametric tone curve — highlights region (PV2012, upper quarter).",
    },
    FieldSpec {
        name: "parametric_lights",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Parametric tone curve — lights region (PV2012, upper midtones).",
    },
    FieldSpec {
        name: "parametric_darks",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Parametric tone curve — darks region (PV2012, lower midtones).",
    },
    FieldSpec {
        name: "parametric_shadows",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Parametric tone curve — shadows region (PV2012, lower quarter).",
    },
    FieldSpec {
        name: "vibrance",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Vibrance (saturation with skin-tone protection) per spec § 3.7.",
    },
    FieldSpec {
        name: "saturation",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Global saturation.",
    },
    FieldSpec {
        name: "clarity",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Midtone local contrast (unsharp radius 40 per spec § 3.8).",
    },
    FieldSpec {
        name: "texture",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Fine texture (unsharp radius 3 per spec § 3.8).",
    },
    FieldSpec {
        name: "sharpen_amount",
        kind: FieldKind::F32,
        range: (0.0, 150.0),
        default_f32: 40.0,
        enum_name: "",
        doc: "Sharpening amount per spec § 3.10 (0 = stage skipped, 100 = full RL). Default = reference-renderer import (40).",
    },
    FieldSpec {
        name: "sharpen_radius",
        kind: FieldKind::F32,
        range: (0.5, 3.0),
        default_f32: 1.0,
        enum_name: "",
        doc: "Sharpening PSF Gaussian sigma. Default = reference-renderer import (1.0).",
    },
    FieldSpec {
        name: "sharpen_detail",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 25.0,
        enum_name: "",
        doc: "Sharpening edge-attenuation strength.",
    },
    FieldSpec {
        name: "sharpen_masking",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Sharpening edge-mask threshold.",
    },
    FieldSpec {
        name: "capture_sharpening_amount",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Capture sharpening strength (Richardson-Lucy deconvolution; 0 = stage skipped).",
    },
    FieldSpec {
        name: "capture_sharpening_sigma",
        kind: FieldKind::F32,
        range: (0.5, 2.0),
        default_f32: 1.0,
        enum_name: "",
        doc: "Capture sharpening Gaussian PSF sigma in pixels (ticket #456: renamed from `capture_sharpening_radius` after PR #452 swapped the PSF for a true Gaussian).",
    },
    FieldSpec {
        name: "capture_sharpening_radius",
        kind: FieldKind::F32,
        range: (0.5, 2.0),
        default_f32: 1.0,
        enum_name: "",
        doc: "Deprecated: use `capture_sharpening_sigma`. Kept as a back-compat alias for source-level callers and the XMP `papp:CaptureSharpeningRadius` read-path; no code reads this field after parse.",
    },
    FieldSpec {
        name: "nr_luminance",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Luminance noise reduction strength per spec § 3.11.",
    },
    FieldSpec {
        name: "nr_color",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 25.0,
        enum_name: "",
        doc: "Color noise reduction strength (default = the reference renderer's default).",
    },
    FieldSpec {
        name: "dehaze",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Dehaze strength.",
    },
    FieldSpec {
        name: "highlight_recovery",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "HighlightRecoveryMode",
        doc: "Highlight reconstruction mode per spec § 3.3a.",
    },
    FieldSpec {
        name: "auto_exposure",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "AutoExposureMode",
        doc: "Per-image auto-exposure mode (ticket #429). 'On' (default) anchors scene mid-gray to 0.18 before AgX; 'Off' is strict scene-referred. The `exposure` slider stacks additively in EV on top.",
    },
    FieldSpec {
        name: "look",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "Look",
        doc: "DisplayLookCurve (ticket #371). 'Default' applies the empirical 1D LUT; 'Neutral' is the strict scene-referred identity.",
    },
    FieldSpec {
        name: "tone_curve_mode",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "ToneCurveMode",
        doc: "Tone-curve application mode (ticket #436). 'PerChannel' applies the three R/G/B curves independently (hue shifts); 'RatioPreserving' folds them through Rec.2020 luma to preserve hue.",
    },
];


#[cfg(test)]
mod tests;
