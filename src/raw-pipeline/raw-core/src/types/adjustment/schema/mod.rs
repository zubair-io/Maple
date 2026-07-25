//! Codegen-facing description of every scalar, enum, and point-curve field
//! on [`super::AdjustmentModel`]. Flat const table (no proc-macro) for lean
//! WASM builds. [`FieldKind`] and [`FieldSpec`] types live in
//! `schema/types.rs`.
//!
//! `local_adjustments` (ticket #280) is intentionally absent — it is a
//! `Vec<LocalAdjustment>` with its own schema; the drift test allow-lists it.
//!
//! Single source of truth for the develop-settings schema: `tools/codegen.sh`
//! emits the Swift and TypeScript mirrors from this table (#118), and the
//! `codegen-drift` CI job re-generates them to prove the committed copies
//! match. Only the NESTED value types those fields carry — `Crop`,
//! `ToneCurve` — stay hand-written per platform, because a flat table cannot
//! describe them. `whiteBalancePreset` remains a hand-written web-only field
//! pending #119.
//!
//! `F32`, `Enum`, and `ToneCurve` fields are captured — the four
//! `tone_curve_*` point curves joined the table in #366, carried by the
//! [`FieldKind::ToneCurve`] variant. `FieldKind` and `FieldSpec` are
//! re-exported from `types.rs`.

// FieldKind and FieldSpec split into a sibling submodule to stay under the
// 600-LOC hard budget (#1181).
mod types;
pub use types::{FieldKind, FieldSpec};

// The 24 HSL band entries live in a sibling submodule for the same reason
// (#366 pushed this file past the budget); `ADJUSTMENT_SCHEMA` lists them
// in place so schema order still matches struct order.
mod hsl;

/// Canonical, ordered description of every codegen-eligible field on
/// [`AdjustmentModel`].
///
/// Order matches the struct's field declaration order. Adding a scalar,
/// enum, or point-curve field to the struct without adding a matching entry
/// here (or vice versa) is a schema drift — the `schema_matches_struct`
/// test catches it. Structured payloads that are not codegen-eligible
/// (`local_adjustments`, `inpaint_removals`, `crop`) stay out of the table
/// and ride the drift test's allow-list instead.
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
        range: (-150.0, 150.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "White balance green/magenta tint. Range matches ACR's crs:Tint span (#1870).",
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
        name: "brightness",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Brightness — scene-linear midtone-band gain (#1102, tone/zoom design spec § 4.1). XMP key `papp:Brightness` (NOT `crs:Brightness`, an ACR PV2010 key with different semantics).",
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
    // S5 effects fields (ticket #643 model/UI; pipeline stages landed per
    // tool — vignette #1109, grain #1110, split tone #1111). See the
    // `AdjustmentModel` struct docs.
    FieldSpec {
        name: "vignette_amount",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Vignette amount — scene-linear radial EV gain (#1109, tone/zoom design spec § 10.1); negative darkens corners, positive lightens them.",
    },
    FieldSpec {
        name: "vignette_feather",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 50.0,
        enum_name: "",
        doc: "Vignette transition softness from center to edge (#1109) — maps onto mask width 0.05–0.9 around the fixed 0.7 midpoint.",
    },
    FieldSpec {
        name: "grain_amount",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Grain intensity — display-linear deterministic film grain (#1110, tone/zoom design spec § 10.2); 0 disables the stage.",
    },
    FieldSpec {
        name: "grain_size",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 25.0,
        enum_name: "",
        doc: "Grain particle size (#1110) — maps onto the noise pitch 1–6 px at a 2000-px long edge (resolution-stable).",
    },
    FieldSpec {
        name: "grain_roughness",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 50.0,
        enum_name: "",
        doc: "Grain roughness (#1110) — mixes a second noise octave at 2x frequency.",
    },
    FieldSpec {
        name: "split_tone_shadow_hue",
        kind: FieldKind::F32,
        range: (0.0, 360.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Split-tone shadow hue in degrees (#1111, tone/zoom design spec § 10.3) — display-linear Oklab tint.",
    },
    FieldSpec {
        name: "split_tone_shadow_saturation",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Split-tone shadow saturation (#1111); 0 disables the shadow tint.",
    },
    FieldSpec {
        name: "split_tone_highlight_hue",
        kind: FieldKind::F32,
        range: (0.0, 360.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Split-tone highlight hue in degrees (#1111).",
    },
    FieldSpec {
        name: "split_tone_highlight_saturation",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Split-tone highlight saturation (#1111); 0 disables the highlight tint.",
    },
    FieldSpec {
        name: "split_tone_balance",
        kind: FieldKind::F32,
        range: (-100.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Split-tone balance — shifts the shadow/highlight crossover via exp2(bal/100) weight exponents (#1111). Primary drag-bar field for the Split Tone tool.",
    },
    // HSL 8-band hue/saturation/luminance (#1112, tone/zoom design § 10.4).
    // 24 `crs:` fields (ACR-compatible, Lightroom interop). All range -100..100,
    // default 0. Band order: Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta.
    // The entries themselves live in `hsl.rs` (file-budget split, #366).
    hsl::HUE_ADJUSTMENT_RED,
    hsl::HUE_ADJUSTMENT_ORANGE,
    hsl::HUE_ADJUSTMENT_YELLOW,
    hsl::HUE_ADJUSTMENT_GREEN,
    hsl::HUE_ADJUSTMENT_AQUA,
    hsl::HUE_ADJUSTMENT_BLUE,
    hsl::HUE_ADJUSTMENT_PURPLE,
    hsl::HUE_ADJUSTMENT_MAGENTA,
    hsl::SATURATION_ADJUSTMENT_RED,
    hsl::SATURATION_ADJUSTMENT_ORANGE,
    hsl::SATURATION_ADJUSTMENT_YELLOW,
    hsl::SATURATION_ADJUSTMENT_GREEN,
    hsl::SATURATION_ADJUSTMENT_AQUA,
    hsl::SATURATION_ADJUSTMENT_BLUE,
    hsl::SATURATION_ADJUSTMENT_PURPLE,
    hsl::SATURATION_ADJUSTMENT_MAGENTA,
    hsl::LUMINANCE_ADJUSTMENT_RED,
    hsl::LUMINANCE_ADJUSTMENT_ORANGE,
    hsl::LUMINANCE_ADJUSTMENT_YELLOW,
    hsl::LUMINANCE_ADJUSTMENT_GREEN,
    hsl::LUMINANCE_ADJUSTMENT_AQUA,
    hsl::LUMINANCE_ADJUSTMENT_BLUE,
    hsl::LUMINANCE_ADJUSTMENT_PURPLE,
    hsl::LUMINANCE_ADJUSTMENT_MAGENTA,
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
        doc: "DisplayLookCurve (ticket #371; retired in #443). Both variants are now identical no-ops; kept for sidecar back-compat so pre-#443 `papp:Look` round-trips.",
    },
    FieldSpec {
        name: "profile",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "Profile",
        doc: "Render-shaping profile (Auto Profile Phase 1, ticket #536). 'Auto' (default) fits a per-image curve from the embedded JPEG preview; 'Neutral' runs the scene-referred AgX view transform. Migrates from legacy `papp:Look` on parse (Default→Auto, Neutral→Neutral).",
    },
    FieldSpec {
        name: "tone_curve_mode",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "ToneCurveMode",
        doc: "Tone-curve application mode (ticket #436). 'PerChannel' applies the three R/G/B curves independently (hue shifts); 'RatioPreserving' folds them through Rec.2020 luma to preserve hue.",
    },
    // Per-channel point curves (#273 slice 1, codegen'd in #366). Each is a
    // `ToneCurve` — an ordered list of `(x, y)` control points in the curve
    // editor's `[0, 1]` authoring domain, identity when empty.
    FieldSpec {
        name: "tone_curve_luma",
        kind: FieldKind::ToneCurve,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Luma point curve (#273). Applied in scene-linear channels-uniformly via the Rec.2020 luma weights, so hue is preserved by construction. Identity (empty) by default.",
    },
    FieldSpec {
        name: "tone_curve_red",
        kind: FieldKind::ToneCurve,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Red-channel point curve (#273). Applied per `tone_curve_mode` — independently in 'PerChannel', or folded through Rec.2020 luma in 'RatioPreserving'. Identity (empty) by default.",
    },
    FieldSpec {
        name: "tone_curve_green",
        kind: FieldKind::ToneCurve,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Green-channel point curve (#273). Applied per `tone_curve_mode`. Identity (empty) by default.",
    },
    FieldSpec {
        name: "tone_curve_blue",
        kind: FieldKind::ToneCurve,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Blue-channel point curve (#273). Applied per `tone_curve_mode`. Identity (empty) by default.",
    },
    FieldSpec {
        name: "chroma_prefilter",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "Decode-time chroma pre-filter strength (#1104, tone/zoom design spec § 3.1). Luma-guided sparse cross-bilateral on opponent chroma inside the decode product; 0 (default) skips the stage bit-identically. XMP key `papp:ChromaPrefilter`. Part of the decoded-image cache key.",
    },
    FieldSpec {
        name: "hot_pixel_suppression",
        kind: FieldKind::Enum,
        range: (0.0, 0.0),
        default_f32: 0.0,
        enum_name: "HotPixelSuppressionMode",
        doc: "Hot/dead-pixel suppression (#1106, tone/zoom design spec § 10.6). Pre-demosaic same-color-neighbor outlier replacement inside the decode product; 'Off' (default) skips the stage bit-identically. XMP key `papp:HotPixelSuppression`. Part of the decoded-image cache key.",
    },
    FieldSpec {
        name: "deep_denoise",
        kind: FieldKind::F32,
        range: (0.0, 100.0),
        default_f32: 0.0,
        enum_name: "",
        doc: "BM3D deep denoise strength (#1105, tone/zoom design spec § 3.2). Two-stage collaborative filtering, input-referred inside the decode product; 0 (default) skips the stage bit-identically. XMP key `papp:DeepDenoise`. Part of the decoded-image cache key.",
    },
];

#[cfg(test)]
mod tests;
