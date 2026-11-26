//! #5093: the delta a [`SliderFrameExport`] derives carries the unit's non-diagonal calibration.

use super::SliderFrameExport;
use crate::{
    color::dcp,
    math::Matrix3,
    pipeline::CreativeStage,
    stages::wb_camera::{
        camera_wb_gain, retarget::target_camera_neutral, retargeted_render_profile,
    },
    test_support::creative::{creative_stage, frame_export, Tables},
};

const TARGETS: [(f32, f32); 4] = [(2900., 5.), (4100., -18.), (7600., 22.), (11000., -9.)];
const TOLERANCE: f32 = 1e-4;

/// `C(T) · diag(g(T) / g(A)) · C(A)⁻¹` from the develop's own profile and frame.
fn develop_delta(stage: &CreativeStage, target: (f32, f32), decoded: (f32, f32)) -> Matrix3 {
    let frame = stage.frame.as_ref().expect("a calibrated tier");
    let basis = |(temperature, tint): (f32, f32)| {
        let profile = retargeted_render_profile(frame, stage.profile.clone(), temperature, tint);
        dcp::camera_to_rec2020_matrix(&profile).expect("render basis")
    };
    let gain = |(temperature, tint): (f32, f32)| {
        camera_wb_gain(frame, stage.as_shot_neutral, temperature, tint)
    };
    let (to, from) = (gain(target), gain(decoded));
    let ratio = Matrix3([
        [to[0] / from[0], 0., 0.],
        [0., 1., 0.],
        [0., 0., to[2] / from[2]],
    ]);
    basis(target)
        .mul_mat(&ratio)
        .mul_mat(&basis(decoded).inverse().expect("render basis inverts"))
}

fn worst_difference(a: Matrix3, b: Matrix3) -> f32 {
    a.0.iter()
        .flatten()
        .zip(b.0.iter().flatten())
        .map(|(x, y)| (x - y).abs())
        .fold(0., f32::max)
}

fn assert_the_exported_delta_is_the_develops(tables: Tables) {
    let stage = creative_stage(tables, 1.0);
    let export = frame_export(tables);
    assert_ne!(
        export.render_individual_cold, export.render_individual_warm,
        "a swap must be visible"
    );
    let swapped = SliderFrameExport {
        render_individual_cold: export.render_individual_warm,
        render_individual_warm: export.render_individual_cold,
        ..export
    };
    let as_shot = (export.scene_cct, export.as_shot_tint);
    let cases = [as_shot, (6100., -6.)]
        .into_iter()
        .flat_map(|decoded| TARGETS.map(|target| (target, decoded)));
    let weight = cases
        .map(|(target, decoded)| {
            let want = develop_delta(&stage, target, decoded);
            let got = export.rec2020_delta_matrix(target, decoded);
            assert!(
                worst_difference(got, want) < TOLERANCE,
                "{decoded:?} -> {target:?}: {got:?} vs the develop's {want:?}"
            );
            worst_difference(swapped.rec2020_delta_matrix(target, decoded), want)
        })
        .fold(0., f32::max);
    assert!(
        weight > 10. * TOLERANCE,
        "the calibration must carry weight in the delta: {weight}"
    );
}

#[test]
fn a_dual_illuminant_units_exported_delta_is_the_develops() {
    assert_the_exported_delta_is_the_develops(Tables::DualUnitCalibration);
}

#[test]
fn a_single_illuminant_units_exported_delta_is_the_develops() {
    assert_the_exported_delta_is_the_develops(Tables::SingleUnitCalibration);
}

/// An export whose cold endpoint's blue row is scaled, so only whites toward the cold end lose their blue response.
fn export_with_cold_blue_scaled(scale: f32) -> SliderFrameExport {
    let export = frame_export(Tables::DualUnitCalibration);
    let [red, green, blue] = export.m_cold.0;
    SliderFrameExport {
        m_cold: Matrix3([red, green, blue.map(|v| v * scale)]),
        ..export
    }
}

/// `C(T) · diag(n(A) / n(T)) · C(A)⁻¹` built from the frame's neutrals and render basis, never from `rec2020_delta_matrix`.
fn first_principles_delta(
    export: &SliderFrameExport,
    target: (f32, f32),
    anchor: (f32, f32),
) -> Matrix3 {
    let frame = export.to_frame();
    let neutral = |(temperature, tint): (f32, f32)| {
        target_camera_neutral(&frame, temperature, tint).expect("a resolvable white")
    };
    let basis = |(temperature, tint): (f32, f32)| {
        let profile =
            retargeted_render_profile(&frame, export.render_profile_shell(), temperature, tint);
        dcp::camera_to_rec2020_matrix(&profile).expect("render basis")
    };
    let (to, from) = (neutral(target), neutral(anchor));
    let ratio = Matrix3([
        [from[0] / to[0], 0., 0.],
        [0., 1., 0.],
        [0., 0., from[2] / to[2]],
    ]);
    basis(target)
        .mul_mat(&ratio)
        .mul_mat(&basis(anchor).inverse().expect("render basis inverts"))
}

#[test]
fn a_degenerate_white_is_the_as_shot_anchor_in_the_exported_delta() {
    let normal = (7600., 22.);
    let degenerate = (2800., 0.);
    for scale in [-1., 1e-9] {
        let export = export_with_cold_blue_scaled(scale);
        let frame = export.to_frame();
        let as_shot = (export.scene_cct, export.as_shot_tint);
        assert!(target_camera_neutral(&frame, degenerate.0, degenerate.1).is_none());
        assert!(target_camera_neutral(&frame, as_shot.0, as_shot.1).is_some());
        assert!(target_camera_neutral(&frame, normal.0, normal.1).is_some());
        assert_eq!(
            export.rec2020_delta_matrix(degenerate, as_shot),
            Matrix3::IDENTITY,
            "blue row x {scale}"
        );
        assert_eq!(
            export.rec2020_delta_matrix(as_shot, degenerate),
            Matrix3::IDENTITY,
            "blue row x {scale}"
        );
        let want = export.rec2020_delta_matrix(normal, as_shot);
        assert!(worst_difference(want, Matrix3::IDENTITY) > TOLERANCE);
        assert!(
            worst_difference(want, first_principles_delta(&export, normal, as_shot)) < TOLERANCE,
            "blue row x {scale}"
        );
        assert_eq!(
            export.rec2020_delta_matrix(normal, degenerate),
            want,
            "blue row x {scale}"
        );
        assert!(
            worst_difference(
                export.rec2020_delta_matrix(normal, degenerate),
                first_principles_delta(&export, normal, as_shot),
            ) < TOLERANCE,
            "blue row x {scale}"
        );
        assert!(
            as_shot.1.abs() >= 0.5,
            "a zero-tint anchor would hide a dropped tint"
        );
    }
}
