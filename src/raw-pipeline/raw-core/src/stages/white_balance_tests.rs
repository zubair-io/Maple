//! Unit tests for [`super`] (CAT16 white balance). Split out of
//! `white_balance.rs` under the 600-LOC file-size budget. Contents moved verbatim.

use super::*;

#[test]
fn d65_reference_at_6500k_tint_0() {
    let gains = wb_gains(6500.0, 0.0);
    // Gains should be close to (1, 1, 1) at the pipeline's native white.
    assert!((gains[0] - 1.0).abs() < 0.05, "R gain {}", gains[0]);
    assert!((gains[1] - 1.0).abs() < 1e-6, "G gain {}", gains[1]);
    assert!((gains[2] - 1.0).abs() < 0.05, "B gain {}", gains[2]);
}

#[test]
fn warm_source_cools_image() {
    // The reference renderer's convention: temp slider value = source-light CCT. A warm
    // source (3000K, tungsten) means we apply COOLING to compensate
    // — gain[R] < 1, gain[B] > 1. Reversed in the previous version.
    let gains = wb_gains(3000.0, 0.0);
    assert!(
        gains[0] < 0.85,
        "R should cut to cool a warm-source scene, got {}",
        gains[0]
    );
    assert!(
        gains[2] > 1.20,
        "B should boost to cool a warm-source scene, got {}",
        gains[2]
    );
}

#[test]
fn cool_source_warms_image() {
    // Cool source (10000K, overcast) → apply WARMING to compensate.
    let gains = wb_gains(10000.0, 0.0);
    assert!(
        gains[2] < 0.95,
        "B should cut to warm a cool-source scene, got {}",
        gains[2]
    );
    assert!(
        gains[0] > 1.05,
        "R should boost to warm a cool-source scene, got {}",
        gains[0]
    );
}

#[test]
fn default_is_identity_on_image() {
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.4, 0.5];
    }
    apply(&mut img, 6500.0, 0.0, WbMethod::Cat16);
    for p in &img.pixels {
        assert_eq!(p, &[0.3, 0.4, 0.5]);
    }
}

#[test]
fn non_default_mutates_pixels() {
    // Warm source = 3000K → cooling correction → R cut, B boost.
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.3, 0.3];
    }
    apply(&mut img, 3000.0, 0.0, WbMethod::DiagonalRec2020);
    for p in &img.pixels {
        assert!(
            p[0] < 0.3,
            "R should cut for warm-source cooling, got {}",
            p[0]
        );
        assert!(
            p[2] > 0.3,
            "B should boost for warm-source cooling, got {}",
            p[2]
        );
    }
}

#[test]
fn legacy_diagonal_negative_tint_adds_magenta() {
    // Legacy `DiagonalRec2020` path: tint sign was inverted vs the
    // reference renderer, so tint=-100 produces a magenta image.
    // The CAT16 default flips this — see `cat16_tint_plus_adds_magenta`
    // below for the corrected convention.
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.3, 0.3];
    }
    apply(&mut img, 6500.0, -100.0, WbMethod::DiagonalRec2020);
    for p in &img.pixels {
        assert!(
            p[0] > p[1],
            "R should exceed G for legacy-diagonal magenta tint, got R={} G={}",
            p[0],
            p[1]
        );
        assert!(
            p[2] > p[1],
            "B should exceed G for legacy-diagonal magenta tint, got B={} G={}",
            p[2],
            p[1]
        );
    }
}

#[test]
fn extreme_warm_2000k_cools_strongly() {
    // The reference renderer exposes 2000K at the cool end of the Temperature slider.
    // Krystek's daylight polynomial under-cools at 2000K vs the reference renderer;
    // Hernández-Andrés's Planckian polynomial cools much harder
    // (R drops to ~0.41, B rises to ~5.34 at 2000K).
    let gains = wb_gains(2000.0, 0.0);
    assert!(
        gains[0] < 0.6,
        "R should fall below 0.6 to deeply cool a 2000K source, got {}",
        gains[0]
    );
    assert!(
        gains[2] > 3.0,
        "B should exceed 3.0 to deeply cool a 2000K source, got {}",
        gains[2]
    );
}

#[test]
fn extreme_cool_50000k_warms_strongly() {
    // The reference renderer exposes 50000K at the warm end of the Temperature slider.
    // Hernández-Andrés is defined only to 25000K, so the polynomial
    // clamps above that — matches the reference renderer's apparent behaviour. At the
    // 25000K clamp R~1.18 (warming) and B~0.57 (cool-source kill).
    let gains = wb_gains(50000.0, 0.0);
    assert!(
        gains[0] > 1.15,
        "R should boost above 1.15 to warm a 50000K (clamped 25000K) source, got {}",
        gains[0]
    );
    assert!(
        gains[2] < 0.6,
        "B should fall below 0.6 to warm a 50000K source, got {}",
        gains[2]
    );
}

#[test]
fn legacy_diagonal_positive_tint_adds_green() {
    // Legacy `DiagonalRec2020` path: tint+100 (sign-inverted vs the
    // reference renderer) drops R and B below G, producing a green image.
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.3, 0.3];
    }
    apply(&mut img, 6500.0, 100.0, WbMethod::DiagonalRec2020);
    for p in &img.pixels {
        assert!(
            p[1] > p[0],
            "G should exceed R for legacy-diagonal green tint, got G={} R={}",
            p[1],
            p[0]
        );
        assert!(
            p[1] > p[2],
            "G should exceed B for legacy-diagonal green tint, got G={} B={}",
            p[1],
            p[2]
        );
    }
}

#[test]
fn apply_delta_identity_when_live_equals_decoded() {
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.4, 0.5];
    }
    apply_delta(&mut img, 5000.0, 10.0, 5000.0, 10.0, WbMethod::Cat16);
    for p in &img.pixels {
        assert_eq!(p, &[0.3, 0.4, 0.5]);
    }
}

#[test]
fn apply_delta_decoded_at_default_matches_apply() {
    for method in [WbMethod::Cat16, WbMethod::DiagonalRec2020] {
        let mut img_a = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        let mut img_b = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for (a, b) in img_a.pixels.iter_mut().zip(img_b.pixels.iter_mut()) {
            *a = [0.4, 0.4, 0.4];
            *b = [0.4, 0.4, 0.4];
        }
        apply(&mut img_a, 3000.0, -50.0, method);
        apply_delta(&mut img_b, 3000.0, -50.0, 6500.0, 0.0, method);
        for (a, b) in img_a.pixels.iter().zip(img_b.pixels.iter()) {
            for c in 0..3 {
                let rel_err = (a[c] - b[c]).abs() / a[c].max(1e-6);
                assert!(
                    rel_err < 0.01,
                    "method {:?} channel {} apply={} apply_delta={} rel_err={}",
                    method,
                    c,
                    a[c],
                    b[c],
                    rel_err
                );
            }
        }
    }
}

#[test]
fn apply_delta_round_trip_undoes_decoded() {
    for method in [WbMethod::Cat16, WbMethod::DiagonalRec2020] {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels {
            *p = [0.4, 0.4, 0.4];
        }
        apply(&mut img, 3000.0, 0.0, method);
        apply_delta(&mut img, 6500.0, 0.0, 3000.0, 0.0, method);
        for p in &img.pixels {
            for c in 0..3 {
                let err = (p[c] - 0.4).abs();
                assert!(
                    err < 0.005,
                    "method {:?} round-trip channel {}: got {}, expected ~0.4 (err={})",
                    method,
                    c,
                    p[c],
                    err
                );
            }
        }
    }
}

// ---- CAT16 path (ticket #431) ----

#[test]
fn cat16_neutral_at_default_is_identity() {
    // At the slider default (6500, 0) the matrix collapses to
    // identity via the short-circuit, so a neutral patch passes
    // through unchanged. (CAT, like every chromatic adaptation
    // `D65 → source(T)`, intentionally shifts neutrals away from
    // R=G=B once `source ≠ D65`; that's what the WB slider *does*.
    // See `cat16_warm_source_cools_image` etc. for that direction.)
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.4, 0.4, 0.4];
    }
    apply(&mut img, 6500.0, 0.0, WbMethod::Cat16);
    for p in &img.pixels {
        assert_eq!(p, &[0.4, 0.4, 0.4]);
    }
}

#[test]
fn cat16_warm_source_cools_image() {
    // 3000K source (tungsten) → cooling correction → R cut, B boost
    // on a neutral patch.
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.3, 0.3];
    }
    apply(&mut img, 3000.0, 0.0, WbMethod::Cat16);
    for p in &img.pixels {
        assert!(
            p[0] < 0.3,
            "CAT16: R should cut to cool a warm-source patch, got {}",
            p[0]
        );
        assert!(
            p[2] > 0.3,
            "CAT16: B should boost to cool a warm-source patch, got {}",
            p[2]
        );
    }
}

#[test]
fn cat16_cool_source_warms_image() {
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.3, 0.3];
    }
    apply(&mut img, 10000.0, 0.0, WbMethod::Cat16);
    for p in &img.pixels {
        assert!(
            p[0] > 0.3,
            "CAT16: R should boost to warm a cool-source patch, got {}",
            p[0]
        );
        assert!(
            p[2] < 0.3,
            "CAT16: B should cut to warm a cool-source patch, got {}",
            p[2]
        );
    }
}

#[test]
fn cat16_tint_plus_adds_magenta() {
    // Reference-renderer convention: tint+ = magenta image (R+B up vs G).
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.3, 0.3];
    }
    apply(&mut img, 6500.0, 50.0, WbMethod::Cat16);
    for p in &img.pixels {
        let rb_minus_2g = (p[0] + p[2]) - 2.0 * p[1];
        assert!(
            rb_minus_2g > 0.0,
            "CAT16: tint+50 should push (R+B) > 2G (magenta), got R={} G={} B={}",
            p[0],
            p[1],
            p[2]
        );
    }
}

#[test]
fn cat16_tint_minus_adds_green() {
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    for p in &mut img.pixels {
        *p = [0.3, 0.3, 0.3];
    }
    apply(&mut img, 6500.0, -50.0, WbMethod::Cat16);
    for p in &img.pixels {
        let rb_minus_2g = (p[0] + p[2]) - 2.0 * p[1];
        assert!(
            rb_minus_2g < 0.0,
            "CAT16: tint-50 should push (R+B) < 2G (green), got R={} G={} B={}",
            p[0],
            p[1],
            p[2]
        );
    }
}

#[test]
fn cat16_temperature_pm_1000k_is_symmetric() {
    // The legacy diagonal path produced a ~9x asymmetry between +1000K
    // and -1000K relative to the 6500K reference: warm |R-B| of 0.013
    // vs cool |R-B| of 0.115 (test_grey_adjustments `temp_symmetric`).
    // CAT16 collapses this to ~1.0 within ~10%.
    let mut warm = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    let mut cool = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    warm.pixels[0] = [0.18, 0.18, 0.18];
    cool.pixels[0] = [0.18, 0.18, 0.18];
    apply(&mut warm, 7500.0, 0.0, WbMethod::Cat16);
    apply(&mut cool, 5500.0, 0.0, WbMethod::Cat16);
    let warm_d = (warm.pixels[0][0] - warm.pixels[0][2]).abs();
    let cool_d = (cool.pixels[0][0] - cool.pixels[0][2]).abs();
    let ratio = warm_d / cool_d.max(1e-6);
    // The grey-adjustment `temp_symmetric` predictor gates `0.3 < ratio < 3.0`.
    // Main's diagonal path produces 8.98; CAT16 lands near 0.6 (order-of-
    // magnitude tighter). Local tolerance gives margin without overclaiming.
    assert!(
        ratio > 0.4 && ratio < 2.5,
        "CAT16 +/-1000K asymmetry too large: warm |R-B|={}, cool |R-B|={}, ratio={}",
        warm_d,
        cool_d,
        ratio
    );
}

#[test]
fn cached_cat16_inverse_matches_fresh_inverse() {
    // Sanity: the OnceLock-cached CAT16 inverse used on the hot path
    // is bit-equivalent to a freshly computed inverse. If this ever
    // drifts, every CAT16 WB tile silently shifts.
    let fresh = CAT16.inverse().expect("CAT16 is non-singular");
    let cached = cat16_inverse();
    for r in 0..3 {
        for c in 0..3 {
            assert!(
                (cached.0[r][c] - fresh.0[r][c]).abs() < 1e-12,
                "cached CAT16 inverse [{r}][{c}]={} != fresh={}",
                cached.0[r][c],
                fresh.0[r][c]
            );
        }
    }
    // And the cache is sticky — second call returns the same pointer.
    assert!(std::ptr::eq(cat16_inverse(), cached));
}

/// Regression guard: `locus_tangent_uv` must clamp the CENTER cct before
/// stepping ±delta_k, not clamp each finite-difference endpoint
/// independently. Independent clamping breaks down above 25000 K (or below
/// 2000 K): e.g. at cct=30000, the "+50 K" sample rails to 25000 while the
/// "-50 K" sample evaluates at 29950 — putting the "plus" sample BELOW the
/// "minus" sample and reversing the tangent (flipping the tint axis), or
/// collapsing to a zero vector if both rail to the same clamp.
///
/// With the center clamped first, any cct >= 25000 K produces the exact same
/// tangent as cct == 25000 K (both evaluate the finite difference at the
/// same clamped center) — no reversal, no zero vector.
#[test]
fn locus_tangent_uv_no_reversal_above_25000k() {
    let (du_25000, dv_25000) = locus_tangent_uv(25000.0);
    let (du_30000, dv_30000) = locus_tangent_uv(30000.0);
    assert_eq!(
        (du_25000, dv_25000),
        (du_30000, dv_30000),
        "tangent at cct=30000 must equal tangent at the 25000K clamp boundary"
    );
    // Guard against the degenerate "both fixed" false-pass: the tangent must
    // be a genuine unit vector, not the zero vector the bug can also produce.
    let len = (du_30000 * du_30000 + dv_30000 * dv_30000).sqrt();
    assert!(
        (len - 1.0).abs() < 1e-4,
        "tangent at cct=30000 must be a unit vector, got length {len}"
    );

    // Same check at the cold boundary (2000 K).
    let (du_2000, dv_2000) = locus_tangent_uv(2000.0);
    let (du_neg, dv_neg) = locus_tangent_uv(500.0);
    assert_eq!(
        (du_2000, dv_2000),
        (du_neg, dv_neg),
        "tangent at cct=500 must equal tangent at the 2000K clamp boundary"
    );
}

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
