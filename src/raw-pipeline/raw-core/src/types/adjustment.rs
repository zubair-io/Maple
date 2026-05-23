//! Canonical `AdjustmentModel` and companion enums.
//!
//! This module is the **single source of truth** for the develop-settings
//! schema. Swift (`MapleCore.AdjustmentModel`) and TypeScript
//! (`maple-common/AdjustmentModel`) mirror this shape today by hand; future
//! codegen (#118 / #119) will consume the [`ADJUSTMENT_SCHEMA`] table below
//! to keep all three platforms in lockstep.
//!
//! [`ADJUSTMENT_SCHEMA`] captures each field's `kind`, range, and the
//! canonical Rust default (`default_f32`). Tests at the bottom of this file
//! assert that `AdjustmentModel::default()` matches the schema's
//! `default_f32` values field-by-field. Per-#326, sharpen defaults now
//! match the reference renderer's import baseline (Sharpness=40, Radius=1.0, Detail=25,
//! EdgeMasking=0) so first-open output is no softer than Lightroom; the
//! Swift hand-written defaults in `AdjustmentModel.swift` mirror this.

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

/// Slice 1+2+5 subset of `AdjustmentModel`. See spec § 01 for the full shape.
///
/// This struct's field order, types, and ranges are the canonical reference
/// for Swift and TypeScript mirrors. The [`ADJUSTMENT_SCHEMA`] table at the
/// bottom of this module describes every field for codegen.
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
        }
    }
}

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
/// The schema is a flat const table rather than a proc-macro so the
/// WASM build stays lean (no `syn` / `quote` pull-in). Generators load
/// `ADJUSTMENT_SCHEMA` via the regular crate-level API.
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

/// Canonical, ordered description of every field on [`AdjustmentModel`].
///
/// Order matches the struct's field declaration order. Adding a field to
/// the struct without adding a matching entry here (or vice versa) is a
/// schema drift — the `schema_matches_struct` test below catches it.
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
        name: "capture_sharpening_radius",
        kind: FieldKind::F32,
        range: (0.5, 2.0),
        default_f32: 1.0,
        enum_name: "",
        doc: "Capture sharpening PSF blur radius in pixels.",
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
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Schema-vs-struct drift guard: every field of the struct must appear
    /// exactly once in the schema, in declaration order. We can't reflect
    /// on Rust structs at compile time, so this test instantiates the
    /// default model and pattern-matches every field — adding a field to
    /// the struct without updating the test (and the schema) is a build
    /// failure.
    #[test]
    fn schema_matches_struct() {
        let m = AdjustmentModel::default();
        // Pattern-match every field. Adding a struct field without
        // updating this list is a compile error.
        let AdjustmentModel {
            temperature,
            tint,
            exposure,
            contrast,
            highlights,
            shadows,
            whites,
            blacks,
            vibrance,
            saturation,
            clarity,
            texture,
            sharpen_amount,
            sharpen_radius,
            sharpen_detail,
            sharpen_masking,
            capture_sharpening_amount,
            capture_sharpening_radius,
            nr_luminance,
            nr_color,
            dehaze,
            highlight_recovery,
        } = m;
        let expected_order = [
            "temperature",
            "tint",
            "exposure",
            "contrast",
            "highlights",
            "shadows",
            "whites",
            "blacks",
            "vibrance",
            "saturation",
            "clarity",
            "texture",
            "sharpen_amount",
            "sharpen_radius",
            "sharpen_detail",
            "sharpen_masking",
            "capture_sharpening_amount",
            "capture_sharpening_radius",
            "nr_luminance",
            "nr_color",
            "dehaze",
            "highlight_recovery",
        ];
        assert_eq!(
            ADJUSTMENT_SCHEMA.len(),
            expected_order.len(),
            "schema length does not match field count"
        );
        for (i, name) in expected_order.iter().enumerate() {
            assert_eq!(
                ADJUSTMENT_SCHEMA[i].name, *name,
                "schema entry {} expected {} got {}",
                i, name, ADJUSTMENT_SCHEMA[i].name
            );
        }
        // Silence unused-variable warnings while still exercising every binding.
        let _ = (
            temperature,
            tint,
            exposure,
            contrast,
            highlights,
            shadows,
            whites,
            blacks,
            vibrance,
            saturation,
            clarity,
            texture,
            sharpen_amount,
            sharpen_radius,
            sharpen_detail,
            sharpen_masking,
            capture_sharpening_amount,
            capture_sharpening_radius,
            nr_luminance,
            nr_color,
            dehaze,
            highlight_recovery,
        );
    }

    /// Every `F32` schema entry's `default_f32` matches the corresponding
    /// field on `AdjustmentModel::default()`.
    #[test]
    fn schema_f32_defaults_match_struct_default() {
        let m = AdjustmentModel::default();
        for spec in ADJUSTMENT_SCHEMA {
            if !matches!(spec.kind, FieldKind::F32) {
                continue;
            }
            let actual = match spec.name {
                "temperature" => m.temperature,
                "tint" => m.tint,
                "exposure" => m.exposure,
                "contrast" => m.contrast,
                "highlights" => m.highlights,
                "shadows" => m.shadows,
                "whites" => m.whites,
                "blacks" => m.blacks,
                "vibrance" => m.vibrance,
                "saturation" => m.saturation,
                "clarity" => m.clarity,
                "texture" => m.texture,
                "sharpen_amount" => m.sharpen_amount,
                "sharpen_radius" => m.sharpen_radius,
                "sharpen_detail" => m.sharpen_detail,
                "sharpen_masking" => m.sharpen_masking,
                "capture_sharpening_amount" => m.capture_sharpening_amount,
                "capture_sharpening_radius" => m.capture_sharpening_radius,
                "nr_luminance" => m.nr_luminance,
                "nr_color" => m.nr_color,
                "dehaze" => m.dehaze,
                other => panic!("unknown f32 field {}", other),
            };
            assert_eq!(
                actual, spec.default_f32,
                "schema default for {} does not match struct default",
                spec.name
            );
        }
    }

    /// Highlight recovery is currently the only enum field; its declared
    /// `enum_name` must agree with the type used on the struct.
    #[test]
    fn highlight_recovery_enum_spec_is_present() {
        let entry = ADJUSTMENT_SCHEMA
            .iter()
            .find(|s| s.name == "highlight_recovery")
            .expect("highlight_recovery missing from schema");
        assert!(matches!(entry.kind, FieldKind::Enum));
        assert_eq!(entry.enum_name, "HighlightRecoveryMode");
    }

    #[test]
    fn white_balance_preset_default_is_as_shot() {
        assert_eq!(WhiteBalancePreset::default(), WhiteBalancePreset::AsShot);
    }
}
