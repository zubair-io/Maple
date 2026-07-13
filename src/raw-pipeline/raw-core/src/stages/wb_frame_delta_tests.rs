//! Unit tests for [`SliderFrameExport`] (#1781) — sibling file per the
//! 600-LOC budget, mirroring the `wb_camera_frame_tests.rs` split.

use super::SliderFrameExport;
use crate::image::{ColorSpace, Image};
use crate::math::Matrix3;
use crate::stages::white_balance::wb_cat16_matrix;

/// A plausible dual-illuminant frame: the DNG-spec-shaped XYZ→camera
/// calibration pair of a generic wide-gamut sensor (values in the range
/// real bundle profiles carry; well-conditioned, non-identity).
///
/// Carries NO render-profile detail (`render_cm` and every `render_*`
/// field zero) — exercises the #1904 fixed-C fallback tier (the value
/// frame's own transform, since `render_cm` absent ⇒ `to_frame` falls
/// back to `cm_as_shot`). [`synthetic_frame_with_render_profile`] below
/// is the #1967 exact-C sibling.
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
        render_forward_matrix: Matrix3([[0.0; 3]; 3]),
        render_scene_white_xyz: [0.0; 3],
        render_wb_already_baked: 0.0,
        render_cm_cold: Matrix3([[0.0; 3]; 3]),
        render_cct_cold: 0.0,
        render_cm_warm: Matrix3([[0.0; 3]; 3]),
        render_cct_warm: 0.0,
        render_fm_cold: Matrix3([[0.0; 3]; 3]),
        render_fm_warm: Matrix3([[0.0; 3]; 3]),
    }
}

/// [`synthetic_frame`] plus a plausible dual-illuminant RENDER PROFILE
/// (distinct matrices from the value frame's, and a ForwardMatrix pair —
/// the shape that exercises the #1967 exact-`C` path). `wb_already_baked`
/// = true (the common FM-shipping-body case).
fn synthetic_frame_with_render_profile() -> SliderFrameExport {
    let render_cm_cold = Matrix3([
        [0.7513, -0.0870, 0.1180],
        [-0.4001, 1.1502, 0.2601],
        [-0.0602, 0.1801, 0.8102],
    ]);
    let render_cm_warm = Matrix3([
        [0.6501, -0.0521, -0.0402],
        [-0.4001, 1.1502, 0.2601],
        [-0.1102, 0.2601, 0.6802],
    ]);
    SliderFrameExport {
        render_cm: render_cm_cold, // as-shot single-value snapshot (unused when endpoints present)
        render_forward_matrix: Matrix3([
            [0.75, 0.18, 0.06],
            [0.28, 0.71, 0.01],
            [-0.01, -0.05, 1.06],
        ]),
        render_scene_white_xyz: [0.9505, 1.0, 1.0888], // D65
        render_wb_already_baked: 1.0,
        render_cm_cold,
        render_cct_cold: 2856.0,
        render_cm_warm,
        render_cct_warm: 6504.0,
        render_fm_cold: Matrix3([[0.79, 0.16, 0.05], [0.30, 0.68, 0.02], [-0.02, -0.04, 1.05]]),
        render_fm_warm: Matrix3([[0.71, 0.20, 0.07], [0.26, 0.73, 0.00], [0.00, -0.06, 1.07]]),
        ..synthetic_frame()
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

/// Shared round-trip assertion: `delta(a→b) · delta(b→a) ≈ I`. Holds
/// algebraically for EITHER tier — the fixed-C fallback (single shared
/// `C_f`, so the product trivially collapses) AND the #1967 exact tier
/// (`C(A)`/`C(B)` differ, but `M(A→B)·M(B→A) = C(B)·g(B)/g(A)·C(A)⁻¹ ·
/// C(A)·g(A)/g(B)·C(B)⁻¹ = C(B)·I·C(B)⁻¹ = I` regardless) — so running it
/// against both frame constructors below catches a real asymmetry bug in
/// either `c_at` call, not just the legacy path.
fn assert_round_trips_through_anchor(f: &SliderFrameExport) {
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
fn delta_matrix_round_trips_through_the_anchor() {
    assert_round_trips_through_anchor(&synthetic_frame());
}

#[test]
fn delta_matrix_round_trips_through_the_anchor_with_render_profile() {
    // #1967: the exact per-CCT C(target)/C(anchor) tier.
    assert_round_trips_through_anchor(&synthetic_frame_with_render_profile());
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
        render_forward_matrix: Matrix3([[0.0; 3]; 3]),
        render_scene_white_xyz: [0.0; 3],
        render_wb_already_baked: 0.0,
        render_cm_cold: Matrix3([[0.0; 3]; 3]),
        render_cct_cold: 0.0,
        render_cm_warm: Matrix3([[0.0; 3]; 3]),
        render_cct_warm: 0.0,
        render_fm_cold: Matrix3([[0.0; 3]; 3]),
        render_fm_warm: Matrix3([[0.0; 3]; 3]),
    };
    let m = f.rec2020_delta_matrix((6282.0, -44.0), (6500.0, 0.0));
    let legacy =
        wb_cat16_matrix(6282.0, -44.0).mul_mat(&wb_cat16_matrix(6500.0, 0.0).inverse().unwrap());
    assert_eq!(
        m.0, legacy.0,
        "singular frame must reproduce the legacy delta"
    );
}

// ---- #1967: exact per-CCT C(target)/C(anchor) ----

#[test]
fn zero_render_profile_tail_is_bit_identical_to_pre_1967_output() {
    // Acceptance criterion 4 (#1967): an export whose new `render_*`
    // fields are all zero (a host/decode that predates this ticket) must
    // produce EXACTLY the #1904 fixed-C output — `c_at` must return `None`
    // for such an export so `rec2020_delta_matrix` falls through to the
    // unchanged `frame_to_rec2020` path. `synthetic_frame()` already
    // carries an all-zero render-profile tail, so this pins that every
    // pre-existing test's expected values (round-trip, warmer-pushes-red,
    // identity short-circuit) is unaffected by the #1967 addition — this
    // test makes the invariant explicit rather than merely implicit in
    // "the old tests still pass".
    let f = synthetic_frame();
    let cases: &[((f32, f32), (f32, f32))] = &[
        ((6282.0, -44.0), (6500.0, 0.0)),
        ((5520.0 + 2000.0, 0.0), (5520.0, 0.0)),
        ((3500.0, -80.0), (6500.0, 0.0)),
    ];
    for &(target, decoded) in cases {
        let m = f.rec2020_delta_matrix(target, decoded);
        let g_target = crate::stages::wb_camera::camera_wb_gain(
            &f.to_frame(),
            [1.0, 1.0, 1.0],
            target.0,
            target.1,
        );
        let g_decoded = crate::stages::wb_camera::camera_wb_gain(
            &f.to_frame(),
            [1.0, 1.0, 1.0],
            decoded.0,
            decoded.1,
        );
        // Match production's `.max(1e-6)` clamp on the decoded-gain
        // denominator (Copilot review, PR #1983) — without it this test
        // would silently stop being a true bit-identical assertion the
        // moment `camera_wb_gain` ever produced a near-zero channel for
        // some target/decoded pair.
        let g_net = Matrix3([
            [g_target[0] / g_decoded[0].max(1e-6), 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, g_target[2] / g_decoded[2].max(1e-6)],
        ]);
        let c = super::frame_to_rec2020(&f.to_frame(), f.scene_cct, f.as_shot_tint).unwrap();
        let expected = c.mul_mat(&g_net).mul_mat(&c.inverse().unwrap());
        assert_eq!(
            m.0, expected.0,
            "zero render-profile tail must reproduce the #1904 fixed-C formula bit-for-bit at {target:?}/{decoded:?}"
        );
    }
}

#[test]
fn render_profile_tail_engages_the_exact_c_path() {
    // The #1967 exact tier must be REACHABLE and must give a numerically
    // DIFFERENT answer than the fixed-C fallback for a target/anchor pair
    // where the render profile's retargeted FM genuinely differs from a
    // fixed C — otherwise `c_at` is silently falling through and this
    // ticket shipped a no-op.
    let with_profile = synthetic_frame_with_render_profile();
    let without_profile = synthetic_frame();
    let target = (3500.0, 30.0);
    let decoded = (6500.0, 0.0);
    let m_exact = with_profile.rec2020_delta_matrix(target, decoded);
    let m_fixed = without_profile.rec2020_delta_matrix(target, decoded);
    let mut any_differs = false;
    for r in 0..3 {
        for c in 0..3 {
            if (m_exact.0[r][c] - m_fixed.0[r][c]).abs() > 1e-3 {
                any_differs = true;
            }
        }
    }
    assert!(
        any_differs,
        "exact-C output {m_exact:?} must differ from the fixed-C output {m_fixed:?} \
         when a distinct render profile is present"
    );
}

#[test]
fn render_profile_without_endpoints_gives_a_constant_c_across_targets() {
    // A single-illuminant render profile (`cm_endpoints` absent) makes
    // `retargeted_render_profile` a no-op for EVERY target/anchor — so
    // `c_at` must return the SAME matrix at any CCT, and the delta must
    // collapse to the pure gain ratio conjugated through that one fixed
    // transform (algebraically identical to the fixed-C tier's shape,
    // even though it's computed via the exact-tier code path).
    let f = SliderFrameExport {
        render_cct_cold: 0.0,
        render_cct_warm: 0.0, // span < 1.0 => cm_endpoints absent
        render_fm_cold: Matrix3([[0.0; 3]; 3]),
        render_fm_warm: Matrix3([[0.0; 3]; 3]),
        ..synthetic_frame_with_render_profile()
    };
    let c_a = f.c_at(&f.to_frame(), 3500.0, 30.0);
    let c_b = f.c_at(&f.to_frame(), 7500.0, -60.0);
    assert_eq!(
        c_a.unwrap().0,
        c_b.unwrap().0,
        "a single-illuminant render profile's C must not vary with target/anchor"
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

/// Fixture-gated (#1967): `SliderFrameExport::resolve` round-trips
/// test_0002's REAL render profile through the flat `render_*` fields
/// losslessly — `c_at` on the reconstructed export must equal
/// `dcp::camera_to_rec2020_matrix` computed directly on the ORIGINAL
/// (never flattened) profile, bit-for-bit, at both the sidecar target and
/// a large cool-drag. This is the round-trip half of the ticket; the
/// color-accuracy half (vs a fresh develop) lives in the raw-ffi seam
/// test, which is the actual GPU-live/tile consumer.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn test_0002_export_round_trips_the_render_profile_losslessly() {
    use crate::stages::wb_camera::{retargeted_render_profile, SliderFrame};

    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read test_0002.dng");
    let raw = crate::decode::decode_bytes(&bytes, "dng").expect("decode test_0002");
    let profile = crate::color::dcp::profile_for(&raw).expect("profile");
    let export = SliderFrameExport::resolve(&raw, &profile);
    let frame = SliderFrame::resolve(&raw, &profile);

    for target in [(6282.0f32, -44.0f32), (3500.0, -20.0), (7500.0, 20.0)] {
        let direct = {
            let retargeted = retargeted_render_profile(&frame, profile.clone(), target.0, target.1);
            crate::color::dcp::camera_to_rec2020_matrix(&retargeted).expect("direct C")
        };
        let via_export = export
            .c_at(&export.to_frame(), target.0, target.1)
            .expect("exported C");
        for r in 0..3 {
            for c in 0..3 {
                assert!(
                    (direct.0[r][c] - via_export.0[r][c]).abs() < 1e-5,
                    "C({target:?})[{r}][{c}]: direct {} vs round-tripped {} — the flat \
                     render_* export must reproduce the profile losslessly",
                    direct.0[r][c],
                    via_export.0[r][c]
                );
            }
        }
    }
}
