//! #5093 pins on the white a retarget resolves at, and on ordinary files staying bit-identical.

use super::*;
use crate::{
    color::illuminant::Illuminant,
    stages::wb_camera::{SliderFrame, SliderFrameParts},
};
use std::collections::HashMap;

const RETARGETS: [(f32, f32); 5] = [
    (2800., 0.),
    (3800., 8.),
    (5000., 12.),
    (9000., -20.),
    (12000., 35.),
];
const IDENTITY: [[f32; 3]; 3] = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];

/// The witness with only its D65 calibration.
fn d65_only(dng: SyntheticGreyDng) -> SyntheticGreyDng {
    SyntheticGreyDng {
        color_matrix_1_override: Some(CM2),
        calibration_illuminant_1_override: Some(21),
        forward_matrix_1: Some(FM2),
        camera_calibration_1_override: dng.camera_calibration_2,
        color_matrix_2: None,
        calibration_illuminant_2: None,
        forward_matrix_2: None,
        camera_calibration_2: None,
        ..dng
    }
}

fn with_blue_row_scaled(frame: &SliderFrame, scale: f32) -> SliderFrame {
    let scaled = |m: Matrix3| Matrix3([m.0[0], m.0[1], m.0[2].map(|v| v * scale)]);
    let parts = frame.parts();
    SliderFrame::from_parts(SliderFrameParts {
        endpoints: parts.endpoints.map(|(cold, cct_cold, warm, cct_warm)| {
            (scaled(cold), cct_cold, scaled(warm), cct_warm)
        }),
        cm_as_shot: scaled(parts.cm_as_shot),
        ..parts
    })
}

#[test]
fn the_retarget_white_is_the_divisor_the_gain_stage_applies() {
    let raw = witness(NON_DIAGONAL_1, NON_DIAGONAL_2);
    let (profile, _) = dcp::profile_for_with_source(&raw).unwrap();
    let frame = SliderFrame::resolve(&raw, &profile);
    let green_normalised = |v: Vec3| v.map(|c| c / v[1]);
    for (temperature, tint) in RETARGETS {
        let gain = wb_camera::camera_wb_gain(&frame, raw.as_shot_neutral, temperature, tint);
        let divisor = green_normalised(divided(raw.as_shot_neutral, gain));
        let white = wb_camera::render_retarget(&frame, &profile, temperature, tint)
            .expect("off as-shot")
            .camera_white;
        assert!(
            close(divisor, green_normalised(white), 1e-5),
            "{temperature} K: the buffer is divided by {divisor:?}, resolved at {white:?}"
        );
    }
}

#[test]
fn a_degenerate_target_white_keeps_the_as_shot_forward_matrix() {
    let dual = witness(NON_DIAGONAL_1, NON_DIAGONAL_2);
    let single = decoded(d65_only(witness_dng(NON_DIAGONAL_2, NON_DIAGONAL_2)));
    for raw in [dual, single] {
        let (profile, _) = dcp::profile_for_with_source(&raw).unwrap();
        let as_shot = profile.forward_matrix.expect("as-shot ForwardMatrix");
        for blue_scale in [-1., 1e-9] {
            let frame = with_blue_row_scaled(&SliderFrame::resolve(&raw, &profile), blue_scale);
            for (temperature, tint) in RETARGETS {
                assert_eq!(
                    wb_camera::camera_wb_gain(&frame, raw.as_shot_neutral, temperature, tint),
                    [1., 1., 1.],
                    "{temperature} K: the buffer must stay divided by the as-shot white"
                );
                let retargeted = wb_camera::retargeted_render_profile(
                    &frame,
                    profile.clone(),
                    temperature,
                    tint,
                );
                assert_eq!(
                    retargeted.forward_matrix,
                    Some(as_shot),
                    "{temperature} K, blue row × {blue_scale}: resolved at a white the buffer \
                     was not divided by"
                );
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Ordinary {
    Absent,
    Identity,
    Diagonal,
}

/// The witness as an ordinary unit, its as-shot white between the calibration illuminants.
fn ordinary(unit: Ordinary, dual: bool) -> RawImage {
    let diagonal = witness_dng(DIAGONAL_1, DIAGONAL_1);
    let dng = match unit {
        Ordinary::Diagonal => diagonal,
        Ordinary::Absent | Ordinary::Identity => SyntheticGreyDng {
            camera_calibration_1_override: Some(IDENTITY),
            camera_calibration_2: Some(IDENTITY),
            analog_balance_override: Some([1., 1., 1.]),
            as_shot_neutral_override: Some([0.305737, 1.0, 0.312718]),
            ..diagonal
        },
    };
    let raw = decoded(if dual { dng } else { d65_only(dng) });
    match unit {
        Ordinary::Absent => RawImage {
            individual_calibrations: HashMap::new(),
            ..raw
        },
        Ordinary::Identity | Ordinary::Diagonal => raw,
    }
}

/// The reference ForwardMatrix at `cct` as interpolated before #5093: no calibration involved.
fn reference_forward_matrix(raw: &RawImage, cct: f32) -> Matrix3 {
    let reference = |illuminant| {
        raw.forward_matrices
            .get(&illuminant)
            .copied()
            .expect("reference ForwardMatrix")
    };
    if raw.forward_matrices.len() == 1 {
        return reference(Illuminant::D65);
    }
    dcp::interpolate_cm(
        reference(Illuminant::StdA),
        Illuminant::StdA.cct(),
        reference(Illuminant::D65),
        Illuminant::D65.cct(),
        cct,
    )
}

/// The CCT a dual profile reads the target's camera white as, derived from the frame's own endpoints.
fn independent_retarget_cct(
    frame: &SliderFrame,
    profile: &dcp::DcpProfile,
    temperature: f32,
    tint: f32,
) -> f32 {
    let Some((m_cold, cct_cold, m_warm, cct_warm)) = frame.parts().endpoints else {
        return profile.scene_cct;
    };
    assert_eq!(
        profile
            .cm_endpoints
            .map(|e| (e.m_cold, e.cct_cold, e.m_warm, e.cct_warm)),
        Some((m_cold, cct_cold, m_warm, cct_warm)),
        "the frame and the profile must solve on the same endpoints"
    );
    let (x, y) = crate::stages::white_balance::slider_source_xy(temperature, tint);
    let [r, g, b] = dcp::interpolate_cm(m_cold, cct_cold, m_warm, cct_warm, temperature)
        .mul_vec(crate::stages::white_balance::xy_to_xyz(x, y, 1.0));
    let camera_white = [r / g, 1., b / g];
    let cct = dcp::compute_as_shot_cct(camera_white, m_cold, cct_cold, m_warm, cct_warm);
    assert!(
        (cct - profile.scene_cct).abs() > 1.,
        "{temperature} K: the retarget CCT {cct} must differ from the as-shot {}",
        profile.scene_cct
    );
    cct
}

#[test]
fn an_ordinary_file_keeps_the_reference_forward_matrix_bit_for_bit() {
    for unit in [Ordinary::Absent, Ordinary::Identity, Ordinary::Diagonal] {
        for dual in [true, false] {
            let raw = ordinary(unit, dual);
            let (profile, _) = dcp::profile_for_with_source(&raw).unwrap();
            assert_eq!(profile.cm_endpoints.is_some(), dual, "{unit:?}");
            assert!(
                !dual || (COLD_CCT + 200.0..WARM_CCT - 200.).contains(&profile.scene_cct),
                "{unit:?}: the as-shot white must interpolate: {}",
                profile.scene_cct
            );
            assert_eq!(
                profile.forward_matrix,
                Some(reference_forward_matrix(&raw, profile.scene_cct)),
                "{unit:?} dual {dual}: as-shot"
            );
            let frame = SliderFrame::resolve(&raw, &profile);
            for (temperature, tint) in RETARGETS {
                let cct = independent_retarget_cct(&frame, &profile, temperature, tint);
                let retargeted = wb_camera::retargeted_render_profile(
                    &frame,
                    profile.clone(),
                    temperature,
                    tint,
                );
                assert_eq!(
                    retargeted.forward_matrix,
                    Some(reference_forward_matrix(&raw, cct)),
                    "{unit:?} dual {dual}: {temperature} K"
                );
            }
        }
    }
}
