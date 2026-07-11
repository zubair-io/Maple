//! Unit tests for [`super`] — the #1780 WB slider-scale migration.

use super::*;
use crate::color::illuminant::Illuminant;
use crate::math::Matrix3;
use crate::stages::wb_camera::camera_wb_gain;

/// Canon EOS 5D Mark III D65 CM2 — same realistic stand-in
/// `wb_camera_tests.rs` uses (real-world-shaped math, not a toy diagonal).
const CANON_5D3_D65_CM: [[f32; 3]; 3] = [
    [0.6722, -0.0635, -0.0963],
    [-0.4287, 1.2460, 0.2028],
    [-0.0908, 0.2162, 0.5668],
];

/// A slightly-warmer variant of the Canon CM, standing in for a StdA-side
/// calibration so dual-endpoint frames exercise the reciprocal-CCT
/// re-interpolation inside the inversion's fixed point.
const CANON_5D3_STDA_CM: [[f32; 3]; 3] = [
    [0.7234, -0.1413, -0.0854],
    [-0.3905, 1.1502, 0.2789],
    [-0.0442, 0.1900, 0.7092],
];

fn single_cm_frame(scene_cct: f32) -> SliderFrame {
    SliderFrame {
        endpoints: None,
        cm_as_shot: Matrix3(CANON_5D3_D65_CM),
        scene_cct,
    }
}

fn dual_cm_frame(scene_cct: f32) -> SliderFrame {
    SliderFrame {
        endpoints: Some((
            Matrix3(CANON_5D3_STDA_CM),
            2856.0,
            Matrix3(CANON_5D3_D65_CM),
            6504.0,
        )),
        cm_as_shot: crate::color::dcp::interpolate_cm(
            Matrix3(CANON_5D3_STDA_CM),
            2856.0,
            Matrix3(CANON_5D3_D65_CM),
            6504.0,
            scene_cct,
        ),
        scene_cct,
    }
}

/// A Bradford-path `DcpProfile` (no FM) built the way
/// `wb_camera_tests::test_profile` builds one.
fn test_profile(scene_cct: f32, as_shot_neutral: [f32; 3]) -> DcpProfile {
    let matrix = Matrix3(CANON_5D3_D65_CM);
    let scene_white_xyz = matrix
        .inverse()
        .map(|inv| {
            let xyz = inv.mul_vec(as_shot_neutral);
            let s = 1.0 / xyz[1].max(1e-8);
            [xyz[0] * s, 1.0, xyz[2] * s]
        })
        .unwrap_or([0.9504, 1.0, 1.0888]);
    DcpProfile {
        illuminant: Illuminant::D65,
        color_matrix: matrix,
        forward_matrix: None,
        scene_cct,
        scene_white_xyz,
        wb_already_baked: true,
        hsm: None,
        look_table: None,
        tone_curve: None,
        cm_endpoints: None,
    }
}

fn v1_model(temperature: f32, tint: f32) -> AdjustmentModel {
    AdjustmentModel {
        temperature,
        tint,
        temperature_seen: true,
        tint_seen: true,
        wb_scale_version: WbScaleVersion::V1,
        ..AdjustmentModel::default()
    }
}

fn chromaticity(v: [f32; 3]) -> (f32, f32) {
    let sum = v[0] + v[1] + v[2];
    (v[0] / sum, v[1] / sum)
}

// ── invert_frame_target: forward → inverse round trip ────────────────────

#[test]
fn frame_inversion_round_trips_the_forward_map() {
    // The inversion must reproduce exactly the (T, tint) whose
    // `camera_wb_gain` forward projection generated the target neutral —
    // that equality is what makes the converted pair render the intended
    // gain. Exercised on both frame shapes across the slider range.
    for frame in [single_cm_frame(5200.0), dual_cm_frame(5200.0)] {
        for &t in &[2400.0_f32, 3200.0, 5500.0, 6500.0, 8000.0, 11000.0] {
            for &tint in &[-80.0_f32, -44.0, 0.0, 25.0, 90.0] {
                let n = forward_frame_target(&frame, t, tint);
                let (t2, tint2) = invert_frame_target(&frame, n).expect("inversion must succeed");
                // Kelvin sanity: nearest-point-on-locus vs the forward
                // perpendicular differ by a curvature term that grows with
                // |tint| and CCT (measured ≈2 K at 11000 K / −80), so the
                // Kelvin bound is deliberately loose…
                assert!(
                    (t2 - t).abs() < 10.0,
                    "T round trip: {t} K / tint {tint} came back {t2} K"
                );
                assert!(
                    (tint2 - tint).abs() < 0.5,
                    "tint round trip: {t} K / tint {tint} came back {tint2}"
                );
                // …because the property that actually matters is that the
                // recovered pair reprojects to the SAME target neutral —
                // that is what makes the converted render's gain equal the
                // old interpretation's. Assert it in uv (8.5e-5 uv ≈ 0.25
                // tint units at the #1893 kTintScale — the fixed point
                // converges at 0.5 K, which moves the locus anchor ~1e-5 uv
                // at the warm end, and the curvature term grows with the
                // 3.33×-larger uv displacements the ACR scale spans).
                let n2 = forward_frame_target(&frame, t2, tint2);
                let uv = |v: [f32; 3], cct: f32| {
                    let inv = frame.cm_for_cct(cct).inverse().unwrap();
                    let xyz = inv.mul_vec(v);
                    let sum = xyz[0] + xyz[1] + xyz[2];
                    xy_to_uv(xyz[0] / sum, xyz[1] / sum)
                };
                let (u_a, v_a) = uv(n, t2);
                let (u_b, v_b) = uv(n2, t2);
                let dist = ((u_a - u_b).powi(2) + (v_a - v_b).powi(2)).sqrt();
                assert!(
                    dist < 8.5e-5,
                    "reprojection drift {dist} uv at {t} K / tint {tint} (came back {t2} K / {tint2})"
                );
            }
        }
    }
}

#[test]
fn frame_inversion_recovers_off_slider_range_tints_unclamped() {
    // A target neutral can legitimately project beyond the ±100 slider
    // range (H2D-39's as-shot ≈ +144); the inversion must NOT clamp, or
    // the converted render would land short of the authored look.
    let frame = single_cm_frame(5200.0);
    let n = forward_frame_target(&frame, 5200.0, 144.0);
    let (_, tint) = invert_frame_target(&frame, n).expect("inversion must succeed");
    assert!(
        (tint - 144.0).abs() < 0.5,
        "off-range tint must survive unclamped, got {tint}"
    );
}

// ── resolve_target_versioned dispatch ─────────────────────────────────────

#[test]
fn v2_explicit_tint_negates_and_rescales_into_the_v4_scale() {
    // #1875 axis + #1893 scale: the V2 scale's tint axis was inverted vs
    // ACR and its magnitude was 1e-4 uv per unit; the authored value
    // re-expresses in V4 by negation AND the 0.3 rescale (temperature
    // untouched).
    let frame = single_cm_frame(5200.0);
    let profile = test_profile(5200.0, [0.6, 1.0, 0.55]);
    let model = AdjustmentModel {
        wb_scale_version: WbScaleVersion::V2,
        ..v1_model(5000.0, 10.0)
    };
    assert_eq!(
        resolve_target_versioned(&model, &frame, &profile, [0.6, 1.0, 0.55]),
        (5000.0, -10.0 * white_balance::TINT_SCALE_V3_TO_V4),
        "V2-authored tint must negate and rescale into the V4 axis/scale"
    );
}

#[test]
fn v3_explicit_tint_rescales_into_the_v4_scale() {
    // #1893: V3 is the ACR direction at the legacy 1e-4 magnitude — the
    // authored value rescales by 0.3 so its uv displacement is preserved.
    let frame = single_cm_frame(5200.0);
    let profile = test_profile(5200.0, [0.6, 1.0, 0.55]);
    let model = AdjustmentModel {
        wb_scale_version: WbScaleVersion::V3,
        ..v1_model(5000.0, 10.0)
    };
    assert_eq!(
        resolve_target_versioned(&model, &frame, &profile, [0.6, 1.0, 0.55]),
        (5000.0, 10.0 * white_balance::TINT_SCALE_V3_TO_V4),
        "V3-authored tint must rescale into the V4 scale"
    );
}

#[test]
fn v4_explicit_values_pass_through_unconverted() {
    let frame = single_cm_frame(5200.0);
    let profile = test_profile(5200.0, [0.6, 1.0, 0.55]);
    let model = AdjustmentModel {
        wb_scale_version: WbScaleVersion::V4,
        ..v1_model(5000.0, 10.0)
    };
    assert_eq!(
        resolve_target_versioned(&model, &frame, &profile, [0.6, 1.0, 0.55]),
        (5000.0, 10.0),
        "V4 models must resolve exactly like resolve_target"
    );
}

#[test]
fn v1_without_explicit_wb_is_untouched_as_shot() {
    let frame = single_cm_frame(5200.0);
    let profile = test_profile(5200.0, [0.6, 1.0, 0.55]);
    let model = AdjustmentModel {
        wb_scale_version: WbScaleVersion::V1,
        ..AdjustmentModel::default()
    };
    assert_eq!(
        resolve_target_versioned(&model, &frame, &profile, [0.6, 1.0, 0.55]),
        (frame.scene_cct, 0.0),
        "V1 with no authored Temperature/Tint must keep the As-Shot seed"
    );
}

#[test]
fn v1_explicit_6500_0_maps_to_as_shot_identity() {
    // (6500, 0) was the pre-#1756 stage's identity — a sidecar storing it
    // explicitly rendered as-shot, so the conversion must land exactly on
    // the V2 as-shot reference (which `wb_camera::apply` short-circuits).
    let frame = single_cm_frame(5200.0);
    let profile = test_profile(5200.0, [0.6, 1.0, 0.55]);
    assert_eq!(
        resolve_target_versioned(&v1_model(6500.0, 0.0), &frame, &profile, [0.6, 1.0, 0.55]),
        (frame.scene_cct, 0.0)
    );
}

#[test]
fn v1_conversion_preserves_the_old_rendered_white() {
    // The whole point of the migration: rendering the CONVERTED (T₂, t₂)
    // through the new camera-space stage must leave a neutral patch at the
    // same chromaticity the old post-DCP CAT16 stage left it at.
    let asn = [0.6_f32, 1.0, 0.55];
    let frame = single_cm_frame(5200.0);
    let profile = test_profile(5200.0, asn);
    let d = dcp::camera_to_rec2020_matrix(&profile).expect("D");
    let w = d.mul_vec([1.0, 1.0, 1.0]);
    for &(t1, tint1) in &[
        (6282.0_f32, -44.0_f32), // the #1780 repro pair
        (5000.0, 0.0),
        (8000.0, 30.0),
        (3200.0, -20.0),
    ] {
        let model = v1_model(t1, tint1);
        let (t2, tint2) = resolve_target_versioned(&model, &frame, &profile, asn);
        // Old rendered white: post-DCP CAT16 cast applied to the as-shot
        // white (identical to what `white_balance::apply` did pre-#1756).
        // The V1 value's displacement was `tint × 1e-4` uv; today's CAT16
        // math displaces at the kTintScale, so the historic cast is
        // reproduced by feeding it the V4-rescaled tint (#1893).
        let w_old = white_balance::wb_cat16_matrix(
            t1,
            tint1 * white_balance::TINT_SCALE_V3_TO_V4,
        )
        .mul_vec(w);
        // New rendered white: camera gain for the converted pair, rendered
        // through the same linear DCP transform.
        let g = camera_wb_gain(&frame, asn, t2, tint2);
        let w_new = d.mul_vec(g);
        let (x_old, y_old) = chromaticity(w_old);
        let (x_new, y_new) = chromaticity(w_new);
        assert!(
            (x_old - x_new).abs() < 1e-3 && (y_old - y_new).abs() < 1e-3,
            "v1 ({t1}, {tint1}) → v2 ({t2}, {tint2}): rendered white moved \
             from xy ({x_old:.5}, {y_old:.5}) to ({x_new:.5}, {y_new:.5})"
        );
    }
}

// ── fixture-gated regression: the #1780 repro itself ─────────────────────

/// Maple-authored V1 sidecar body — the exact WB pair from
/// `test-fixtures/raws/test_0002.xmp` (the TestFlight regression's
/// sidecar), inlined because the raws tree is gitignored.
const TEST_0002_V1_XMP: &str = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:papp="http://ns.justmaple.app/1.0/"
      crs:Temperature="6282"
        crs:Tint="-44"/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;

/// End-to-end on the real H2D-39 fixture: parse the Maple-authored V1
/// sidecar, resolve the real frame/profile, and assert the converted
/// target's camera gain matches the old interpretation's
/// equivalent-camera-gain within tight tolerance (the "WB gains match the
/// old interpretation" gate from #1780).
#[test]
#[cfg_attr(not(feature = "fixtures"), ignore)]
fn test_0002_v1_sidecar_converts_to_the_old_interpretations_gain() {
    let path = crate::test_support::fixtures::require_raw("test_0002.dng");
    let raw = crate::decode::decode(&path).expect("decode test_0002.dng");
    let model = crate::xmp::parse(TEST_0002_V1_XMP).expect("parse v1 xmp");
    assert_eq!(model.wb_scale_version, WbScaleVersion::V1);
    assert!(model.temperature_seen && model.tint_seen);

    let profile = crate::color::dcp::profile_for(&raw).expect("profile");
    let frame = SliderFrame::resolve(&raw, &profile);
    let (t2, tint2) = resolve_target_versioned(&model, &frame, &profile, raw.as_shot_neutral);
    assert!(
        (t2 - model.temperature).abs() > 1.0,
        "conversion must actually move the target (frame ≠ CAT16 scale)"
    );

    // First-principles expectation: the old CAT16 cast expressed as a
    // G-normalised camera gain through the real profile's D. The V1
    // tint's historic displacement reproduces via the V4 rescale (#1893).
    let d = dcp::camera_to_rec2020_matrix(&profile).expect("D");
    let w_old = white_balance::wb_cat16_matrix(
        6282.0,
        -44.0 * white_balance::TINT_SCALE_V3_TO_V4,
    )
    .mul_vec(d.mul_vec([1.0, 1.0, 1.0]));
    let g_raw = d.inverse().expect("D invertible").mul_vec(w_old);
    let expected = [g_raw[0] / g_raw[1], 1.0, g_raw[2] / g_raw[1]];

    let got = camera_wb_gain(&frame, raw.as_shot_neutral, t2, tint2);
    for c in 0..3 {
        assert!(
            (got[c] - expected[c]).abs() / expected[c] < 2e-3,
            "channel {c}: converted gain {got:?} vs old-interpretation gain {expected:?}"
        );
    }
}
