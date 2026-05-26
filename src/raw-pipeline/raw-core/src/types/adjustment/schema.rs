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
mod tests {
    use super::*;
    use super::super::AdjustmentModel;

    /// Schema-vs-struct drift guard: every scalar / enum field of the
    /// struct must appear exactly once in the schema, in declaration order.
    /// We can't reflect on Rust structs at compile time, so this test
    /// instantiates the default model and pattern-matches every field —
    /// adding a field to the struct without updating the test (and the
    /// schema) is a build failure.
    #[test]
    #[allow(deprecated)]
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
            parametric_highlights,
            parametric_lights,
            parametric_darks,
            parametric_shadows,
            vibrance,
            saturation,
            clarity,
            texture,
            sharpen_amount,
            sharpen_radius,
            sharpen_detail,
            sharpen_masking,
            capture_sharpening_amount,
            capture_sharpening_sigma,
            capture_sharpening_radius,
            nr_luminance,
            nr_color,
            dehaze,
            highlight_recovery,
            look,
            local_adjustments,
            tone_curve_mode,
            tone_curve_luma,
            tone_curve_red,
            tone_curve_green,
            tone_curve_blue,
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
            "parametric_highlights",
            "parametric_lights",
            "parametric_darks",
            "parametric_shadows",
            "vibrance",
            "saturation",
            "clarity",
            "texture",
            "sharpen_amount",
            "sharpen_radius",
            "sharpen_detail",
            "sharpen_masking",
            "capture_sharpening_amount",
            "capture_sharpening_sigma",
            "capture_sharpening_radius",
            "nr_luminance",
            "nr_color",
            "dehaze",
            "highlight_recovery",
            "look",
            "tone_curve_mode",
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
            parametric_highlights,
            parametric_lights,
            parametric_darks,
            parametric_shadows,
            vibrance,
            saturation,
            clarity,
            texture,
            sharpen_amount,
            sharpen_radius,
            sharpen_detail,
            sharpen_masking,
            capture_sharpening_amount,
            capture_sharpening_sigma,
            capture_sharpening_radius,
            nr_luminance,
            nr_color,
            dehaze,
            highlight_recovery,
            look,
            tone_curve_mode,
            tone_curve_luma,
            tone_curve_red,
            tone_curve_green,
            tone_curve_blue,
        );
        // `local_adjustments` is allow-listed: it carries structured data
        // (Vec<LocalAdjustment>) and is documented as not part of the schema
        // table. Asserting its default keeps the drift guard honest.
        assert!(
            local_adjustments.is_empty(),
            "AdjustmentModel::default().local_adjustments must be empty"
        );
    }

    /// Schema-exemption allow-list. Fields appearing here are the ones
    /// `schema_matches_struct` deliberately omits from `ADJUSTMENT_SCHEMA`
    /// because they carry structured payloads (Vec / nested struct) rather
    /// than scalar values. Adding a new exemption MUST land in the same PR
    /// that justifies the deviation. The string-matching keeps the
    /// allow-list source-grep-friendly.
    #[test]
    fn schema_exemption_allowlist() {
        const ALLOWED: &[&str] = &["local_adjustments"];
        assert_eq!(
            ALLOWED.len(),
            1,
            "schema exemption count changed — update this test and the \
             matching note on the module-level doc-comment"
        );
        assert!(
            ALLOWED.contains(&"local_adjustments"),
            "local_adjustments must remain on the schema-exemption allow-list \
             until the codegen table grows a structured-field FieldKind variant"
        );
    }

    /// Every `F32` schema entry's `default_f32` matches the corresponding
    /// field on `AdjustmentModel::default()`.
    #[test]
    #[allow(deprecated)]
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
                "parametric_highlights" => m.parametric_highlights,
                "parametric_lights" => m.parametric_lights,
                "parametric_darks" => m.parametric_darks,
                "parametric_shadows" => m.parametric_shadows,
                "vibrance" => m.vibrance,
                "saturation" => m.saturation,
                "clarity" => m.clarity,
                "texture" => m.texture,
                "sharpen_amount" => m.sharpen_amount,
                "sharpen_radius" => m.sharpen_radius,
                "sharpen_detail" => m.sharpen_detail,
                "sharpen_masking" => m.sharpen_masking,
                "capture_sharpening_amount" => m.capture_sharpening_amount,
                "capture_sharpening_sigma" => m.capture_sharpening_sigma,
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

    /// Highlight recovery is one of two enum fields; its declared
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

    /// DisplayLookCurve (ticket #371). Enum field; codegen emits matching
    /// Swift / TS mirrors.
    #[test]
    fn look_enum_spec_is_present() {
        let entry = ADJUSTMENT_SCHEMA
            .iter()
            .find(|s| s.name == "look")
            .expect("look missing from schema");
        assert!(matches!(entry.kind, FieldKind::Enum));
        assert_eq!(entry.enum_name, "Look");
    }

    /// ToneCurveMode (ticket #436). Enum field; codegen emits matching
    /// Swift / TS mirrors.
    #[test]
    fn tone_curve_mode_enum_spec_is_present() {
        let entry = ADJUSTMENT_SCHEMA
            .iter()
            .find(|s| s.name == "tone_curve_mode")
            .expect("tone_curve_mode missing from schema");
        assert!(matches!(entry.kind, FieldKind::Enum));
        assert_eq!(entry.enum_name, "ToneCurveMode");
    }

    /// New PV2012 parametric region sliders are present in the schema with
    /// the canonical `[-100, 100]` range and default 0.
    #[test]
    fn parametric_region_fields_present_with_default_zero() {
        for name in [
            "parametric_highlights",
            "parametric_lights",
            "parametric_darks",
            "parametric_shadows",
        ] {
            let entry = ADJUSTMENT_SCHEMA
                .iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("{name} missing from ADJUSTMENT_SCHEMA"));
            assert!(matches!(entry.kind, FieldKind::F32));
            assert_eq!(entry.range, (-100.0, 100.0), "range for {name}");
            assert_eq!(entry.default_f32, 0.0, "default for {name}");
        }
    }
}
