//! Unit tests for [`SliderFrameExport`] (#1781) — sibling file per the
//! 600-LOC budget, mirroring the `wb_camera_frame_tests.rs` split.

use super::SliderFrameExport;
use crate::image::{ColorSpace, Image};
use crate::math::Matrix3;
use crate::stages::white_balance::wb_cat16_matrix;

/// A plausible dual-illuminant frame: the DNG-spec-shaped XYZ→camera
/// calibration pair of a generic wide-gamut sensor (values in the range
/// real bundle profiles carry; well-conditioned, non-identity).
fn synthetic_frame() -> SliderFrameExport {
    SliderFrameExport {
        m_cold: Matrix3([
            [0.8924, -0.1041, 0.0866],
            [-0.4351, 1.2101, 0.2260],
            [-0.0350, 0.1470, 0.7654],
        ]),
        cct_cold: 2856.0,
        m_warm: Matrix3([
            [0.7534, -0.0682, -0.0512],
            [-0.4351, 1.2101, 0.2260],
            [-0.0996, 0.2327, 0.6567],
        ]),
        cct_warm: 6504.0,
        scene_cct: 5520.0,
        as_shot_tint: -12.0,
        render_cm: Matrix3([[0.0; 3]; 3]),
    }
}

#[test]
fn absent_export_is_not_present() {
    assert!(!SliderFrameExport::ABSENT.is_present());
    // A NaN/negative scene_cct is absent too (defensive).
    let mut f = synthetic_frame();
    f.scene_cct = f32::NAN;
    assert!(!f.is_present());
    f.scene_cct = -100.0;
    assert!(!f.is_present());
    assert!(synthetic_frame().is_present());
}

#[test]
fn delta_matrix_is_exact_identity_when_target_equals_decoded() {
    let f = synthetic_frame();
    // Bit-exact IDENTITY inside the half-Kelvin/half-tint band — the GPU
    // multiplies by this matrix, so "approximately identity" would break
    // the live == decoded bit-exactness contract.
    let m = f.rec2020_delta_matrix((5520.0, -12.0), (5520.0, -12.0));
    assert_eq!(m.0, Matrix3::IDENTITY.0);
    let m = f.rec2020_delta_matrix((5520.2, -11.8), (5520.0, -12.0));
    assert_eq!(m.0, Matrix3::IDENTITY.0);
}

#[test]
fn delta_matrix_round_trips_through_the_anchor() {
    // delta(a→b) · delta(b→a) ≈ I: the two conjugations share C_f, so the
    // product collapses to C·diag(g_ab·g_ba)·C⁻¹ = C·I·C⁻¹ exactly up to
    // f32 rounding.
    let f = synthetic_frame();
    let ab = f.rec2020_delta_matrix((6282.0, -44.0), (6500.0, 0.0));
    let ba = f.rec2020_delta_matrix((6500.0, 0.0), (6282.0, -44.0));
    let prod = ab.mul_mat(&ba);
    for r in 0..3 {
        for c in 0..3 {
            let expected = if r == c { 1.0 } else { 0.0 };
            assert!(
                (prod.0[r][c] - expected).abs() < 1e-4,
                "round trip [{r}][{c}] = {} (expected {expected})",
                prod.0[r][c]
            );
        }
    }
}

#[test]
fn warmer_target_pushes_red_over_blue() {
    // Moving the slider warmer than the anchor must warm the image:
    // a neutral grey through the delta gains more R than B.
    let f = synthetic_frame();
    let m = f.rec2020_delta_matrix((f.scene_cct + 2000.0, 0.0), (f.scene_cct, 0.0));
    let out = m.mul_vec([0.5, 0.5, 0.5]);
    assert!(
        out[0] > out[2],
        "warmer-than-anchor target should give R > B, got {out:?}"
    );
}

#[test]
fn singular_frame_falls_back_to_generic_cat16_delta() {
    let f = SliderFrameExport {
        m_cold: Matrix3([[0.0; 3]; 3]),
        cct_cold: 2856.0,
        m_warm: Matrix3([[0.0; 3]; 3]),
        cct_warm: 6504.0,
        // Present (scene_cct > 0) but the calibration is singular — the
        // conjugation cannot be built.
        scene_cct: 5500.0,
        as_shot_tint: 0.0,
        render_cm: Matrix3([[0.0; 3]; 3]),
    };
    let m = f.rec2020_delta_matrix((6282.0, -44.0), (6500.0, 0.0));
    let legacy =
        wb_cat16_matrix(6282.0, -44.0).mul_mat(&wb_cat16_matrix(6500.0, 0.0).inverse().unwrap());
    assert_eq!(
        m.0, legacy.0,
        "singular frame must reproduce the legacy delta"
    );
}

#[test]
fn apply_delta_rec2020_is_bit_exact_noop_at_anchor() {
    let f = synthetic_frame();
    let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
    img.pixels = vec![[0.1, 0.5, 0.9]; 4];
    let before = img.pixels.clone();
    f.apply_delta_rec2020(&mut img, (5520.0, -12.0), (5520.0, -12.0));
    assert_eq!(img.pixels, before);
}

#[test]
fn apply_delta_rec2020_matches_the_matrix() {
    let f = synthetic_frame();
    let m = f.rec2020_delta_matrix((6282.0, -44.0), (6500.0, 0.0));
    let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    img.pixels = vec![[0.2, 0.4, 0.6]];
    f.apply_delta_rec2020(&mut img, (6282.0, -44.0), (6500.0, 0.0));
    assert_eq!(img.pixels[0], m.mul_vec([0.2, 0.4, 0.6]));
}

/// Fixture-gated: the export resolved from the real test_0002 body must
/// now (#1894 item 6) carry the SINGLE EMBEDDED CM frame — not the bundle
/// — because `SliderFrame::resolve` accepts a lone non-identity embedded
/// `ColorMatrix` instead of falling through to the render profile.
/// test_0002 (H2D-39) ships exactly one embedded CM (tagged D65,
/// cct-of-tag 6504); its `scene_cct` is the direct (non-iterative)
/// Robertson solve at that CM: `inv(cm) · as_shot_neutral` normalizes to
/// xy ≈ (0.35445, 0.33086), and
/// `dng_temperature::xy_to_temp_tint` of that point is ≈ 4522.4 K —
/// measured directly against this fixture (`wb_1894_acceptance_probe`
/// during #1894 development; NOT the bundle's 5520 K this test asserted
/// pre-#1894, nor the McCamy-based 4539.8 K the pre-#1894 embedded-frame
/// investigation quoted — Robertson's isotherm search is a materially
/// different curve fit from both).
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn resolve_on_test_0002_exports_the_single_embedded_cm_frame() {
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read test_0002.dng");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode test_0002");
    let profile = crate::color::dcp::profile_for(&raw).expect("profile");
    let export = SliderFrameExport::resolve(&raw, &profile);
    assert!(export.is_present());
    assert!(
        (export.scene_cct - 4522.4).abs() < 5.0,
        "scene_cct {} != single embedded CM frame's Robertson solve ≈ 4522.4",
        export.scene_cct
    );
    assert!(
        export.cct_warm - export.cct_cold < 1.0,
        "a single embedded CM must export as a degenerate (non-dual) pair, not the bundle's endpoints"
    );
    assert!(export.as_shot_tint.is_finite());
}

// ---- as-shot tint export ↔ slider forward-model consistency (#1870) ----
//
// The exported `as_shot_tint` seeds the app's Tint slider on a fresh open,
// and every calibrated-tier render path interprets that slider through
// `wb_camera::camera_wb_gain` (the `tint_sign_positive_v = true` axis —
// ACR direction, #1875).
// The export is only a correct As-Shot seed if the develop at the seeded
// pair is a WB no-op — i.e. `camera_wb_gain(frame, asn, scene_cct,
// as_shot_tint) ≈ [1, 1, 1]`. Pre-#1870 the estimate was projected on the
// OPPOSITE axis (and clamped at ±100), so the seeded init rendered a
// visible cast on every calibrated body. #1894 moved BOTH the estimate
// (`SliderFrameExport::resolve`, via `super::robertson_as_shot_tint`) and
// the render's forward map (`wb_camera::target_xyz`, via
// `slider_source_xy`) onto the Robertson mapping together, so the
// estimator/render invariant this test pins holds under the new mapping
// exactly as it did under the old one.

use crate::stages::wb_camera::camera_wb_gain;
use crate::stages::white_balance::{slider_source_xy, xy_to_xyz};

/// The camera-native `AsShotNeutral` the synthetic frame's sensor would
/// report for an illuminant displaced `tint_true` (ACR convention —
/// the `true` axis `camera_wb_gain` consumes, #1875) off the locus at the
/// frame's own `scene_cct`, via the #1894 Robertson mapping
/// (`slider_source_xy` — the same forward map `wb_camera::target_xyz`
/// uses) rather than the legacy Hernández-Andrés perpendicular
/// displacement.
fn as_shot_neutral_at_tint(export: &SliderFrameExport, tint_true: f32) -> [f32; 3] {
    let (wx, wy) = slider_source_xy(export.scene_cct, tint_true);
    let xyz = xy_to_xyz(wx, wy, 1.0);
    export.to_frame().cm_as_shot.mul_vec(xyz)
}

/// Estimate + unity-gain check for one true tint value. The estimate comes
/// from [`super::robertson_as_shot_tint`] — the SAME function
/// `SliderFrameExport::resolve` calls to populate `as_shot_tint` — so this
/// exercises the real production estimator, not a reimplementation of it.
fn assert_estimate_nulls_gain(tint_true: f32) {
    let export = synthetic_frame();
    let frame = export.to_frame();
    let asn = as_shot_neutral_at_tint(&export, tint_true);
    let est = super::robertson_as_shot_tint(&frame, asn);
    // Robertson round trip through one forward (`slider_source_xy`) + one
    // inverse (`xy_to_temp_tint`) hop at a FIXED cct is tight — no
    // fixed-point iteration is involved here (unlike
    // `wb_camera_scale::invert_frame_target`), so table-breakpoint
    // discontinuities don't compound; `dng_temperature`'s own
    // `round_trip_temp_tint_through_xy` test uses the same 1.5-unit bound
    // for exactly this single-hop shape.
    assert!(
        (est - tint_true).abs() <= 1.5,
        "estimate must be in the slider convention: true tint {tint_true}, estimated {est}"
    );
    let gain = camera_wb_gain(&frame, asn, export.scene_cct, est);
    for (c, g) in gain.iter().enumerate() {
        assert!(
            (g - 1.0).abs() < 5e-3,
            "develop at the seeded pair must be a WB no-op: tint_true={tint_true} est={est} gain[{c}]={g}"
        );
    }
}

#[test]
fn as_shot_tint_estimate_nulls_camera_wb_gain_in_range() {
    for &t in &[-80.0_f32, -40.0, 0.0, 40.0, 80.0] {
        assert_estimate_nulls_gain(t);
    }
}

#[test]
fn as_shot_tint_estimate_nulls_camera_wb_gain_past_the_old_rail() {
    // The H2D-39 shape: a true as-shot tint past the old ±100 clamp but
    // inside the authored ±150 range (ACR's own crs:Tint span).
    assert_estimate_nulls_gain(143.5);
    assert_estimate_nulls_gain(-143.5);
}

/// Fixture-gated (#1870/#1875/#1894): the real test_0002 body's exported
/// as-shot tint must null the camera gain — the As-Shot init render is a
/// WB no-op — regardless of which value-mapping curve produced the
/// number. The unity-gain property is a SELF-consistency invariant
/// (estimator and render share `robertson_as_shot_tint`/`slider_source_xy`,
/// #1894) and holds independent of the specific `(cct, tint)` the mapping
/// produces.
///
/// The as-shot tint VALUE itself moved twice since #1875's −143.5
/// (measured on the pre-#1894 BUNDLE frame, 1e-4-uv-per-unit scale): first
/// #1893's kTintScale rescale (−143.5 × 0.3 ≈ −43, though the bundle
/// frame's exact projection differs slightly), and then #1894 item 6
/// switched this fixture onto the single EMBEDDED CM frame (not the
/// bundle) with the Robertson mapping. The current value, ≈ −43.79,
/// was measured directly against this fixture during #1894 development
/// (`wb_1894_acceptance_probe`) — it is NOT independently re-derived from
/// a closed-form formula here (the isotherm-table search has no closed
/// form), so this assertion pins the CURRENT measured output rather than
/// a value computed from first principles in-comment.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn test_0002_as_shot_tint_export_is_a_wb_no_op() {
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read test_0002.dng");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode test_0002");
    let profile = crate::color::dcp::profile_for(&raw).expect("profile");
    let export = SliderFrameExport::resolve(&raw, &profile);
    assert!(
        (export.as_shot_tint - (-43.79)).abs() < 3.0,
        "H2D-39 as-shot tint (single embedded CM, Robertson) is ≈ −43.79, got {}",
        export.as_shot_tint
    );
    let gain = camera_wb_gain(
        &export.to_frame(),
        raw.as_shot_neutral,
        export.scene_cct,
        export.as_shot_tint,
    );
    for (c, g) in gain.iter().enumerate() {
        assert!(
            (g - 1.0).abs() < 5e-3,
            "as-shot init must be a WB no-op, gain[{c}]={g}"
        );
    }
}
