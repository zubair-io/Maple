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
/// carry the bundle frame (dual endpoints, scene_cct ≈ 5520 K) and a
/// present flag — the exact values the #1781 seam analysis measured.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn resolve_on_test_0002_exports_the_bundle_frame() {
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read test_0002.dng");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode test_0002");
    let profile = crate::color::dcp::profile_for(&raw).expect("profile");
    let export = SliderFrameExport::resolve(&raw, &profile);
    assert!(export.is_present());
    assert!(
        (export.scene_cct - 5520.0).abs() < 5.0,
        "scene_cct {} != bundle frame 5520",
        export.scene_cct
    );
    assert!(
        export.cct_warm - export.cct_cold >= 1.0,
        "bundle profile should export dual endpoints"
    );
    assert!(export.as_shot_tint.is_finite());
}
