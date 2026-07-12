//! `resolve_wb` tests (#1725 / #1729 / #1893) — the exhaustive
//! `(temperature_seen, tint_seen)` resolution table plus the
//! version-authored tint conversion. Split from
//! `white_balance_tests.rs` for the 600-line hard budget (the #1893
//! conversion tests pushed it over); same `#[path]` sibling pattern.

use super::*;

// ── resolve_wb tests (#1725 / #1729) ────────────────────────────────────────
//
// One test per cell of the exhaustive (temperature_seen, tint_seen) × source
// table in `resolve_wb`'s doc-comment.  Covers the four flag combinations plus
// the FFI-shaped path (both flags true, explicit non-default values).

/// (true, true) — XMP Custom with both Temperature and Tint: values passed
/// through unchanged.
#[test]
fn resolve_wb_both_seen_passes_through() {
    let model = crate::xmp::AdjustmentModel {
        temperature: 4500.0,
        tint: 25.0,
        temperature_seen: true,
        tint_seen: true,
        ..Default::default()
    };
    let (t, tnt) = resolve_wb(&model);
    assert_eq!(
        t, 4500.0,
        "temperature must pass through when temperature_seen=true"
    );
    assert_eq!(tnt, 25.0, "tint must pass through when tint_seen=true");
}

/// Version-authored tint conversion (#1875 axis, #1893 scale): an authored
/// tint stamped with a pre-V4 `WbScaleVersion` re-expresses in the V4
/// axis + scale, preserving the uv displacement it encoded when written.
/// Presets and defaults never set `tint_seen` and are untouched (covered
/// by the neither-seen tests below).
#[test]
fn resolve_wb_versioned_authored_tint_converts_to_v4() {
    use crate::xmp::WbScaleVersion as V;
    let model_at = |version: V| crate::xmp::AdjustmentModel {
        temperature: 4500.0,
        tint: 25.0,
        temperature_seen: true,
        tint_seen: true,
        wb_scale_version: version,
        ..Default::default()
    };
    // V1/V3: ACR direction at the legacy 1e-4 scale → ×0.3.
    assert_eq!(resolve_wb(&model_at(V::V1)).1, 25.0 * TINT_SCALE_V3_TO_V4);
    assert_eq!(resolve_wb(&model_at(V::V3)).1, 25.0 * TINT_SCALE_V3_TO_V4);
    // V2: inverted axis at the legacy scale → negate AND ×0.3.
    assert_eq!(resolve_wb(&model_at(V::V2)).1, -25.0 * TINT_SCALE_V3_TO_V4);
    // V4/V5: kTintScale magnitude → passthrough on this tier (the
    // fallback tier's legacy-locus map reads both identically; the
    // camera-space tiers convert V4's locus difference separately).
    assert_eq!(resolve_wb(&model_at(V::V4)).1, 25.0);
    assert_eq!(resolve_wb(&model_at(V::V5)).1, 25.0);
}

/// (true, false) — XMP temperature-only Custom WB: temperature passes
/// through, tint resolves to 0 (neutral, the ACR 'absent tint' value).
#[test]
fn resolve_wb_temperature_only_zeroes_tint() {
    let model = crate::xmp::AdjustmentModel {
        temperature: 4500.0,
        tint: 99.0, // must be ignored
        temperature_seen: true,
        tint_seen: false,
        ..Default::default()
    };
    let (t, tnt) = resolve_wb(&model);
    assert_eq!(
        t, 4500.0,
        "temperature must pass through when temperature_seen=true"
    );
    assert_eq!(tnt, 0.0, "tint must be 0 when tint_seen=false");
}

/// (false, true) — XMP tint-only Custom WB: absent temperature anchors to
/// 6500 K (D65 identity in the post-DCP space), tint passes through.
#[test]
fn resolve_wb_tint_only_anchors_temperature_to_6500() {
    let model = crate::xmp::AdjustmentModel {
        temperature: 2850.0, // must be ignored — replaced by 6500 K
        tint: 15.0,
        temperature_seen: false,
        tint_seen: true,
        ..Default::default()
    };
    let (t, tnt) = resolve_wb(&model);
    assert_eq!(
        t, 6500.0,
        "absent temperature in tint-only Custom WB must anchor to 6500 K (D65)"
    );
    assert_eq!(tnt, 15.0, "tint must pass through when tint_seen=true");
}

/// (false, false) — Default model / no sidecar: both values pass through
/// from model.  Default carries (6500, 0) which is a no-op at the WB stage.
#[test]
fn resolve_wb_neither_seen_passes_model_values() {
    let model = crate::xmp::AdjustmentModel::default();
    // Default carries temperature=6500, tint=0, both seen=false.
    let (t, tnt) = resolve_wb(&model);
    assert_eq!(t, 6500.0, "default model temperature must pass through");
    assert_eq!(tnt, 0.0, "default model tint must pass through");
}

/// (false, false) with a named WB preset already resolved by the XMP parser
/// (e.g. Tungsten → 2850 K, 0 tint): the neither-seen fall-through preserves
/// the preset's resolved (temperature, tint).  Presets do NOT set the seen
/// flags (they populate model.temperature/model.tint from wb_preset() at parse
/// time without setting temperature_seen/tint_seen).
#[test]
fn resolve_wb_neither_seen_preserves_preset_resolved_values() {
    // Simulate what the XMP parser does for crs:WhiteBalance="Tungsten".
    let model = crate::xmp::AdjustmentModel {
        temperature: 2850.0,
        tint: 0.0,
        temperature_seen: false, // presets don't set the flag
        tint_seen: false,
        ..Default::default()
    };
    let (t, tnt) = resolve_wb(&model);
    assert_eq!(
        t, 2850.0,
        "preset-resolved temperature must pass through (neither-seen)"
    );
    assert_eq!(
        tnt, 0.0,
        "preset-resolved tint must pass through (neither-seen)"
    );
}

/// FFI-shaped path: simulates what `maple_apply_scene_linear_chain` does when
/// the Apple host supplies temperature=4500 K and tint=+30 via the C-ABI struct
/// (i.e. both seen-flags set to true, values != default).  The tint must survive
/// `resolve_wb` unchanged — this is the regression test for the horizontal-band
/// bug (#1725) where tint was zeroed because the FFI conversion did not set
/// `tint_seen=true`.
#[test]
fn resolve_wb_ffi_shaped_model_preserves_tint() {
    // This is how `maple_apply_scene_linear_chain` now builds the model:
    // copy temperature + tint from params, then set both seen-flags.
    let mut model = crate::xmp::AdjustmentModel::default();
    model.temperature = 4500.0;
    model.tint = 30.0;
    model.temperature_seen = true; // fixed in #1725
    model.tint_seen = true; // fixed in #1725 — was missing, causing tint → 0

    let (t, tnt) = resolve_wb(&model);
    assert_eq!(t, 4500.0, "FFI temperature must pass through");
    assert_eq!(
        tnt, 30.0,
        "FFI tint must pass through (was zeroed before #1725 fix: tint_seen was false)"
    );
}

/// Cross-check: a model shaped like the pre-#1725 FFI state (temperature_seen
/// and tint_seen both false, despite the FFI caller having supplied an
/// explicit non-default temperature/tint pair) now falls into the
/// neither-seen row and passes BOTH values through unchanged. Before the
/// FFI conversion fix (this ticket, setting both seen-flags), tint_seen was
/// incorrectly false here, so `resolve_wb` needed to preserve the value
/// regardless — the true fix is at the FFI boundary (set the flags), and
/// `resolve_wb` correctly treats neither-seen as "pass model values through"
/// (named-preset / default semantics), not as "zero the tint".
#[test]
fn resolve_wb_pre_fix_ffi_model_would_zero_tint() {
    // Shape: temperature_seen=false, tint_seen=false, non-default values.
    let mut model = crate::xmp::AdjustmentModel::default();
    model.temperature = 4500.0;
    model.tint = 30.0;

    let (t, tnt) = resolve_wb(&model);
    // temperature_seen=false + tint_seen=false → neither-seen → model.temperature
    assert_eq!(t, 4500.0);
    // neither-seen → model.tint passes through (this is also the named-preset
    // row: a Fluorescent preset's non-zero tint must survive resolve_wb).
    assert_eq!(
        tnt, 30.0,
        "neither-seen must pass model.tint through unchanged (matches the documented truth table)"
    );
}

/// (false, false) with a non-zero tint simulating a named preset that carries
/// tint (e.g. a hypothetical Fluorescent preset with +10 green cast): the
/// neither-seen row must preserve it, not silently zero it. This is the
/// regression guard for the truth-table violation where `effective_tint`
/// was gated on `tint_seen` alone.
#[test]
fn resolve_wb_preserves_preset_tint() {
    let model = crate::xmp::AdjustmentModel {
        temperature: 4200.0,
        tint: 10.0,
        temperature_seen: false,
        tint_seen: false,
        ..Default::default()
    };
    let (t, tnt) = resolve_wb(&model);
    assert_eq!(t, 4200.0, "preset-resolved temperature must pass through");
    assert_eq!(
        tnt, 10.0,
        "preset-resolved non-zero tint (e.g. Cloudy +10) must survive resolve_wb, not zero out"
    );
}
