//! Per-field presence tests for the `ADJUSTMENT_SCHEMA` codegen table —
//! the enum specs and the "this feature's fields reached the schema"
//! group. Sibling of `tests.rs`; split out under the 600-LOC hard cap
//! once the black & white mix (#276) landed alongside HSL (#274).
//! Contents moved verbatim.

#![cfg(test)]

use super::super::AdjustmentModel;
use super::*;

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

/// WbMethod (ticket #431). Enum field; codegen emits matching
/// Swift / TS mirrors.
#[test]
fn wb_method_enum_spec_is_present() {
    let entry = ADJUSTMENT_SCHEMA
        .iter()
        .find(|s| s.name == "wb_method")
        .expect("wb_method missing from schema");
    assert!(matches!(entry.kind, FieldKind::Enum));
    assert_eq!(entry.enum_name, "WbMethod");
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

/// Per-channel point curves (#273, codegen'd in #366). All four are
/// `FieldKind::ToneCurve` entries sitting directly after `tone_curve_mode`,
/// and every one of them is identity (empty) on a default model — the
/// invariant that keeps a fresh `AdjustmentModel` bit-identical to the
/// pre-tone-curve pipeline output.
#[test]
fn tone_curve_fields_present_in_schema() {
    let names = [
        "tone_curve_luma",
        "tone_curve_red",
        "tone_curve_green",
        "tone_curve_blue",
    ];
    let m = AdjustmentModel::default();
    let curves = [
        &m.tone_curve_luma,
        &m.tone_curve_red,
        &m.tone_curve_green,
        &m.tone_curve_blue,
    ];
    for (name, curve) in names.iter().zip(curves) {
        let entry = ADJUSTMENT_SCHEMA
            .iter()
            .find(|s| s.name == *name)
            .unwrap_or_else(|| panic!("{name} missing from ADJUSTMENT_SCHEMA"));
        assert!(
            matches!(entry.kind, FieldKind::ToneCurve),
            "{name} should be a ToneCurve field"
        );
        assert_eq!(
            entry.enum_name, "",
            "{name} carries no enum name — the curve type is always ToneCurve"
        );
        assert!(
            curve.is_identity(),
            "AdjustmentModel::default().{name} must be the identity curve"
        );
    }
    // Order: the four curves follow `tone_curve_mode` immediately, matching
    // the struct's declaration order.
    let mode_idx = ADJUSTMENT_SCHEMA
        .iter()
        .position(|s| s.name == "tone_curve_mode")
        .expect("tone_curve_mode missing from schema");
    for (offset, name) in names.iter().enumerate() {
        assert_eq!(ADJUSTMENT_SCHEMA[mode_idx + 1 + offset].name, *name);
    }
}

/// S5 effects fields (ticket #643): vignette / grain / split-tone scalars
/// are present in the schema with the documented ranges and defaults.
/// Each one is an `F32`; no new enums were introduced.
#[test]
fn s5_effects_fields_present_in_schema() {
    let expect: &[(&str, (f32, f32), f32)] = &[
        ("vignette_amount", (-100.0, 100.0), 0.0),
        ("vignette_feather", (0.0, 100.0), 50.0),
        ("grain_amount", (0.0, 100.0), 0.0),
        ("grain_size", (0.0, 100.0), 25.0),
        ("grain_roughness", (0.0, 100.0), 50.0),
        ("split_tone_shadow_hue", (0.0, 360.0), 0.0),
        ("split_tone_shadow_saturation", (0.0, 100.0), 0.0),
        ("split_tone_highlight_hue", (0.0, 360.0), 0.0),
        ("split_tone_highlight_saturation", (0.0, 100.0), 0.0),
        ("split_tone_balance", (-100.0, 100.0), 0.0),
    ];
    for (name, range, default) in expect {
        let entry = ADJUSTMENT_SCHEMA
            .iter()
            .find(|s| s.name == *name)
            .unwrap_or_else(|| panic!("{name} missing from ADJUSTMENT_SCHEMA"));
        assert!(matches!(entry.kind, FieldKind::F32), "{name} should be F32");
        assert_eq!(entry.range, *range, "range for {name}");
        assert_eq!(entry.default_f32, *default, "default for {name}");
    }
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
