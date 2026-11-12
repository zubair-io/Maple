//! #5093: the ForwardMatrix is resolved for the white a buffer was divided by,
//! with the unit's calibration interpolated like the ForwardMatrix itself
//! (dng_sdk `SetWhiteXY`), against a synthetic Canon-witness DNG.
//!
//! The witness is built from the physical `test_0006.DNG` tags (Canon EOS 5D
//! Mark III: ColorMatrix1/2, ForwardMatrix1/2, StdA + D65) under the unit
//! calibration the ACR-converted Canon file carried (`AnalogBalance`
//! [1.983, 1, 1.477]), with the non-diagonal `CameraCalibration1/2` no
//! physical file has. Every expectation is the closed-form SDK transform
//! `FM(w) · diag(R·w)⁻¹ · R` written out here, not a call into the code under
//! test.

use crate::{
    color::dcp,
    decode::decode_bytes,
    image::RawImage,
    math::{Matrix3, Vec3},
    stages::wb_camera::{self, SliderFrame},
    test_support::synth_dng::SyntheticGreyDng,
};

const CM1: [[f32; 3]; 3] = [
    [0.7234, -0.1413, -0.06],
    [-0.3631, 1.115, 0.285],
    [-0.0382, 0.1335, 0.6437],
];
const CM2: [[f32; 3]; 3] = [
    [0.6722, -0.0635, -0.0963],
    [-0.4287, 1.246, 0.2028],
    [-0.0908, 0.2162, 0.5668],
];
const FM1: [[f32; 3]; 3] = [
    [0.7868, 0.0092, 0.1683],
    [0.2291, 0.8615, -0.0906],
    [0.0027, -0.4752, 1.2976],
];
const FM2: [[f32; 3]; 3] = [
    [0.7637, 0.0805, 0.1201],
    [0.2649, 0.9179, -0.1828],
    [0.0137, -0.2456, 1.057],
];
const ANALOG_BALANCE: [f32; 3] = [1.983, 1.0, 1.477];
const NON_DIAGONAL_1: [[f32; 3]; 3] = [
    [1.004, 0.045, -0.030],
    [0.020, 1.0, 0.060],
    [-0.035, 0.050, 0.992],
];
const NON_DIAGONAL_2: [[f32; 3]; 3] = [
    [0.998, -0.030, 0.040],
    [-0.025, 1.0, -0.045],
    [0.030, -0.040, 1.008],
];
const DIAGONAL_1: [[f32; 3]; 3] = [[1.002, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0062]];
const COLD_CCT: f32 = 2856.0; // StdA
const WARM_CCT: f32 = 6504.0; // D65
const SAMPLES: [Vec3; 3] = [[0.31, 0.62, 0.12], [0.05, 0.2, 0.44], [0.9, 0.4, 0.33]];

fn witness_dng(cc1: [[f32; 3]; 3], cc2: [[f32; 3]; 3]) -> SyntheticGreyDng {
    SyntheticGreyDng {
        color_matrix_1_override: Some(CM1),
        color_matrix_2: Some(CM2),
        calibration_illuminant_1_override: Some(17),
        calibration_illuminant_2: Some(21),
        forward_matrix_1: Some(FM1),
        forward_matrix_2: Some(FM2),
        camera_calibration_1_override: Some(cc1),
        camera_calibration_2: Some(cc2),
        analog_balance_override: Some(ANALOG_BALANCE),
        as_shot_neutral_override: Some([0.606276, 1.0, 0.461885]),
        ..Default::default()
    }
}

fn decoded(dng: SyntheticGreyDng) -> RawImage {
    decode_bytes(&dng.write_to_bytes(), "dng").expect("decode the synthetic witness")
}

fn witness(cc1: [[f32; 3]; 3], cc2: [[f32; 3]; 3]) -> RawImage {
    decoded(witness_dng(cc1, cc2))
}

fn m(a: [[f32; 3]; 3]) -> Matrix3 {
    Matrix3(a)
}

/// Reciprocal-CCT interpolation written from the DNG spec, independent of
/// `dcp::interpolate_cm`.
fn lerp(cold: Matrix3, warm: Matrix3, cct: f32) -> Matrix3 {
    let t = ((1. / cct - 1. / COLD_CCT) / (1. / WARM_CCT - 1. / COLD_CCT)).clamp(0., 1.);
    Matrix3(std::array::from_fn(|i| {
        std::array::from_fn(|j| cold.0[i][j] + t * (warm.0[i][j] - cold.0[i][j]))
    }))
}

/// `diag(AnalogBalance) · CameraCalibrationN`.
fn individual(cc: [[f32; 3]; 3]) -> Matrix3 {
    let [r, g, b] = ANALOG_BALANCE;
    Matrix3([[r, 0., 0.], [0., g, 0.], [0., 0., b]]).mul_mat(&m(cc))
}

/// dng_sdk on unbalanced camera RGB `p` at camera white `w`, with the
/// reference ForwardMatrix and the unit calibration both interpolated at `cct`.
fn sdk_xyz(cct: f32, w: Vec3, p: Vec3, cc: ([[f32; 3]; 3], [[f32; 3]; 3])) -> Vec3 {
    let fm = lerp(m(FM1), m(FM2), cct);
    sdk_xyz_with(fm, lerp(individual(cc.0), individual(cc.1), cct), w, p)
}

/// The SDK at camera white `w` for one reference ForwardMatrix and one
/// interpolated calibration `individual`.
fn sdk_xyz_with(fm: Matrix3, individual: Matrix3, w: Vec3, p: Vec3) -> Vec3 {
    let to_reference = individual.inverse().expect("calibration inverts");
    let reference = to_reference.mul_vec(p);
    let reference_white = to_reference.mul_vec(w);
    fm.mul_vec(std::array::from_fn(|c| reference[c] / reference_white[c]))
}

fn worst_difference(a: Vec3, b: Vec3) -> f32 {
    a.iter()
        .zip(&b)
        .map(|(x, y)| (x - y).abs())
        .fold(0., f32::max)
}

fn close(a: Vec3, b: Vec3, tolerance: f32) -> bool {
    a.iter().zip(&b).all(|(x, y)| (x - y).abs() < tolerance)
}

fn divided(p: Vec3, w: Vec3) -> Vec3 {
    std::array::from_fn(|c| p[c] / w[c])
}

/// What the pre-#5093 code installed: each endpoint resolved at the as-shot
/// white, then interpolated.
fn endpoint_resolved_at_as_shot(
    raw: &RawImage,
    cct: f32,
    cc: ([[f32; 3]; 3], [[f32; 3]; 3]),
) -> Matrix3 {
    let resolve = |fm: [[f32; 3]; 3], cc: [[f32; 3]; 3]| {
        crate::color::forward_calibration::balanced_forward_matrix(
            m(fm),
            individual(cc),
            raw.as_shot_neutral,
        )
    };
    lerp(resolve(FM1, cc.0), resolve(FM2, cc.1), cct)
}

#[test]
fn the_witness_neutral_lands_on_the_forward_matrix_white_at_every_white() {
    let raw = witness(NON_DIAGONAL_1, NON_DIAGONAL_2);
    let (profile, _) = dcp::profile_for_with_source(&raw).unwrap();
    let frame = SliderFrame::resolve(&raw, &profile);
    let as_shot = profile.forward_matrix.expect("dual ForwardMatrix");
    let d50 = as_shot.mul_vec([1., 1., 1.]);
    assert!(
        close(d50, [0.964, 1.0, 0.825], 0.02),
        "witness neutral XYZ {d50:?}"
    );
    for (temperature, tint) in [(2800., 0.), (5000., 12.), (9000., -20.), (12000., 35.)] {
        let retargeted =
            wb_camera::retargeted_render_profile(&frame, profile.clone(), temperature, tint);
        let neutral = retargeted.forward_matrix.unwrap().mul_vec([1., 1., 1.]);
        let cct = wb_camera::render_retarget(&frame, &profile, temperature, tint)
            .map_or(profile.scene_cct, |r| r.cct);
        let want = lerp(m(FM1), m(FM2), cct).mul_vec([1., 1., 1.]);
        assert!(
            close(neutral, want, 1e-3),
            "{temperature} K: {neutral:?} vs {want:?}"
        );
    }
}

#[test]
fn the_as_shot_forward_matrix_interpolates_the_calibration_with_the_forward_matrix() {
    let cc = (NON_DIAGONAL_1, NON_DIAGONAL_2);
    let raw = witness(cc.0, cc.1);
    let (profile, _) = dcp::profile_for_with_source(&raw).unwrap();
    assert!(
        profile.scene_cct > COLD_CCT + 200. && profile.scene_cct < WARM_CCT - 200.,
        "the as-shot white must sit between the calibrations: {}",
        profile.scene_cct
    );
    let balanced = profile.forward_matrix.unwrap();
    let white = raw.as_shot_neutral;
    let old = endpoint_resolved_at_as_shot(&raw, profile.scene_cct, cc);
    let mut second_order = 0f32;
    for p in SAMPLES {
        let want = sdk_xyz(profile.scene_cct, white, p, cc);
        let got = balanced.mul_vec(divided(p, white));
        assert!(close(got, want, 1e-3), "{p:?}: {got:?} vs {want:?}");
        let before = old.mul_vec(divided(p, white));
        second_order = second_order.max(
            before
                .iter()
                .zip(&want)
                .map(|(a, b)| (a - b).abs())
                .fold(0., f32::max),
        );
    }
    assert!(
        second_order > 1e-3,
        "interpolating resolved endpoints must differ at second order: {second_order}"
    );
}

#[test]
fn a_retargeted_white_resolves_the_non_diagonal_calibration_at_its_own_white() {
    let cc = (NON_DIAGONAL_1, NON_DIAGONAL_2);
    let raw = witness(cc.0, cc.1);
    let (profile, _) = dcp::profile_for_with_source(&raw).unwrap();
    let frame = SliderFrame::resolve(&raw, &profile);
    for (temperature, tint) in [
        (2800., 0.),
        (3800., 8.),
        (5000., 12.),
        (9000., -20.),
        (12000., 35.),
    ] {
        let retarget =
            wb_camera::render_retarget(&frame, &profile, temperature, tint).expect("off as-shot");
        let retargeted =
            wb_camera::retargeted_render_profile(&frame, profile.clone(), temperature, tint);
        let balanced = retargeted.forward_matrix.unwrap();
        let old = endpoint_resolved_at_as_shot(&raw, retarget.cct, cc);
        let mut kept_as_shot = 0f32;
        for p in SAMPLES {
            let want = sdk_xyz(retarget.cct, retarget.camera_white, p, cc);
            let got = balanced.mul_vec(divided(p, retarget.camera_white));
            assert!(
                close(got, want, 1e-3),
                "{temperature} K {p:?}: {got:?} vs {want:?}"
            );
            let before = old.mul_vec(divided(p, retarget.camera_white));
            kept_as_shot = kept_as_shot.max(
                before
                    .iter()
                    .zip(&want)
                    .map(|(a, b)| (a - b).abs())
                    .fold(0., f32::max),
            );
        }
        assert!(
            kept_as_shot > 1e-3,
            "{temperature} K: the as-shot resolution is not the SDK's: {kept_as_shot}"
        );
    }
}

#[test]
fn a_diagonal_calibration_keeps_the_interpolated_forward_matrix_at_every_white() {
    let raw = witness(DIAGONAL_1, DIAGONAL_1);
    let (profile, _) = dcp::profile_for_with_source(&raw).unwrap();
    let frame = SliderFrame::resolve(&raw, &profile);
    for (temperature, tint) in [(2800., 0.), (5000., 12.), (12000., 35.)] {
        let retarget = wb_camera::render_retarget(&frame, &profile, temperature, tint).unwrap();
        let retargeted =
            wb_camera::retargeted_render_profile(&frame, profile.clone(), temperature, tint);
        let want = lerp(m(FM1), m(FM2), retarget.cct);
        let got = retargeted.forward_matrix.unwrap();
        for p in SAMPLES {
            assert!(
                close(got.mul_vec(p), want.mul_vec(p), 1e-4),
                "{temperature} K"
            );
        }
    }
}

#[test]
fn a_single_illuminant_profile_resolves_its_calibration_at_a_retargeted_white() {
    let raw = decoded(SyntheticGreyDng {
        color_matrix_2: None,
        calibration_illuminant_2: None,
        forward_matrix_2: None,
        camera_calibration_2: None,
        color_matrix_1_override: Some(CM2),
        calibration_illuminant_1_override: Some(21),
        forward_matrix_1: Some(FM2),
        camera_calibration_1_override: Some(NON_DIAGONAL_2),
        ..witness_dng(NON_DIAGONAL_2, NON_DIAGONAL_2)
    });
    let (profile, _) = dcp::profile_for_with_source(&raw).unwrap();
    assert!(
        profile.cm_endpoints.is_none(),
        "a single-illuminant profile"
    );
    let frame = SliderFrame::resolve(&raw, &profile);
    let unit = individual(NON_DIAGONAL_2);
    let as_shot = profile.forward_matrix.expect("single ForwardMatrix");
    let white = raw.as_shot_neutral;
    for p in SAMPLES {
        let want = sdk_xyz_with(m(FM2), unit, white, p);
        let got = as_shot.mul_vec(divided(p, white));
        assert!(close(got, want, 1e-3), "as-shot {p:?}: {got:?} vs {want:?}");
    }
    for (temperature, tint) in [(2800., 0.), (5000., 12.), (9000., -20.), (12000., 35.)] {
        let retarget =
            wb_camera::render_retarget(&frame, &profile, temperature, tint).expect("off as-shot");
        let retargeted =
            wb_camera::retargeted_render_profile(&frame, profile.clone(), temperature, tint);
        let balanced = retargeted.forward_matrix.unwrap();
        let w = retarget.camera_white;
        let mut kept_as_shot = 0f32;
        for p in SAMPLES {
            let want = sdk_xyz_with(m(FM2), unit, w, p);
            let got = balanced.mul_vec(divided(p, w));
            assert!(
                close(got, want, 1e-3),
                "{temperature} K {p:?}: {got:?} vs {want:?}"
            );
            kept_as_shot = kept_as_shot.max(worst_difference(as_shot.mul_vec(divided(p, w)), want));
        }
        assert!(
            kept_as_shot > 1e-3,
            "{temperature} K: the as-shot resolution is not the SDK's: {kept_as_shot}"
        );
    }
}

/// A dual profile with only ForwardMatrix1 still interpolates the unit's
/// calibration between both `CameraCalibrationN` (dng_sdk interpolates the
/// calibration whatever ForwardMatrices the profile ships).
#[test]
fn one_forward_matrix_still_interpolates_both_calibrations() {
    let cc = (NON_DIAGONAL_1, NON_DIAGONAL_2);
    let raw = decoded(SyntheticGreyDng {
        forward_matrix_2: None,
        ..witness_dng(cc.0, cc.1)
    });
    let warm = raw
        .individual_calibrations
        .get(&crate::color::illuminant::Illuminant::D65)
        .expect("the ForwardMatrix-less illuminant keeps its calibration");
    for (row, want) in warm.0.iter().zip(individual(cc.1).0) {
        assert!(close(*row, want, 1e-3), "{row:?} vs {want:?}");
    }
    let (profile, _) = dcp::profile_for_with_source(&raw).unwrap();
    let fm = profile.forward_matrix.expect("one-sided ForwardMatrix");
    let white = raw.as_shot_neutral;
    let unit = lerp(individual(cc.0), individual(cc.1), profile.scene_cct);
    for p in SAMPLES {
        let want = sdk_xyz_with(m(FM1), unit, white, p);
        let got = fm.mul_vec(divided(p, white));
        assert!(close(got, want, 1e-3), "{p:?}: {got:?} vs {want:?}");
    }
}
