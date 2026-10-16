use super::*;
use crate::{
    color::{
        illuminant::Illuminant,
        matrices::{M_PRO_TO_XYZ_D50, XYZ_D50},
    },
    image::{ColorSpace, Image},
};
use dcp::balanced_camera_to_xyz_d50 as balanced_bradford;

type Mat64 = [[f64; 3]; 3];
const CM: Matrix3 = Matrix3([
    [0.6722, -0.0635, -0.0963],
    [-0.4287, 1.2460, 0.2028],
    [-0.0908, 0.2162, 0.5668],
]);

fn mul(a: Mat64, b: Mat64) -> Mat64 {
    std::array::from_fn(|r| std::array::from_fn(|c| (0..3).map(|k| a[r][k] * b[k][c]).sum()))
}

fn vector(a: Mat64, v: [f64; 3]) -> [f64; 3] {
    a.map(|row| (0..3).map(|k| row[k] * v[k]).sum())
}

fn diagonal(v: [f64; 3]) -> Mat64 {
    [[v[0], 0., 0.], [0., v[1], 0.], [0., 0., v[2]]]
}

fn inverse(a: Mat64) -> Mat64 {
    let mut rows = std::array::from_fn::<_, 3, _>(|r| {
        std::array::from_fn::<_, 6, _>(|c| {
            if c < 3 {
                a[r][c]
            } else {
                f64::from(c - 3 == r)
            }
        })
    });
    for k in 0..3 {
        let pivot = (k..3)
            .max_by(|&a, &b| rows[a][k].abs().total_cmp(&rows[b][k].abs()))
            .unwrap();
        rows.swap(k, pivot);
        let scale = rows[k][k];
        assert!(scale.abs() > 1e-12);
        for c in 0..6 {
            rows[k][c] /= scale;
        }
        for r in 0..3 {
            if r == k {
                continue;
            }
            let scale = rows[r][k];
            for c in 0..6 {
                rows[r][c] -= scale * rows[k][c];
            }
        }
    }
    rows.map(|r| [r[3], r[4], r[5]])
}

fn sdk_inverse(cm: Matrix3, neutral: [f32; 3]) -> Mat64 {
    let cm = cm.0.map(|r| r.map(f64::from));
    let neutral = neutral.map(f64::from);
    let d50 = XYZ_D50.map(f64::from);
    let white = vector(inverse(cm), neutral);
    let white = white.map(|v| v / white[1]);
    let bradford = [
        [0.8951, 0.2664, -0.1614],
        [-0.7502, 1.7135, 0.0367],
        [0.0389, -0.0685, 1.0296],
    ];
    let target_lms = vector(bradford, white);
    let pcs_lms = vector(bradford, d50);
    let adaptation = mul(
        inverse(bradford),
        mul(
            diagonal(std::array::from_fn(|c| target_lms[c] / pcs_lms[c])),
            bradford,
        ),
    );
    // Independent SDK direction: normalized PCS→camera, inverted only
    // after that product is complete, then account for balanced input.
    let pcs_to_camera = mul(cm, adaptation);
    let first_clip = vector(pcs_to_camera, d50)
        .into_iter()
        .fold(f64::NEG_INFINITY, f64::max);
    let pcs_to_camera = pcs_to_camera.map(|r| r.map(|v| v / first_clip));
    let max_neutral = neutral.into_iter().fold(f64::NEG_INFINITY, f64::max);
    mul(
        inverse(pcs_to_camera),
        diagonal(neutral.map(|v| v / max_neutral)),
    )
}

fn assert_oracle(actual: Matrix3, cm: Matrix3, neutral: [f32; 3]) {
    let expected = sdk_inverse(cm, neutral);
    for v in [
        [1., 1., 1.],
        [1., 0., 0.],
        [0., 1., 0.],
        [0., 0., 1.],
        [0.2, 0.4, 0.7],
        [-0.5, 0.4, 1.5],
        [8., 4., 2.],
    ] {
        let a = actual.mul_vec(v);
        let e = vector(expected, v.map(f64::from));
        for c in 0..3 {
            assert!(
                (f64::from(a[c]) - e[c]).abs() < 2e-5,
                "{v:?}: {a:?} != {e:?}"
            );
        }
    }
}

#[test]
fn balanced_bradford_matches_independent_pcs_inverse_for_signed_and_hdr_values() {
    for scale in [0.5, 1., 2.] {
        let cm = Matrix3(CM.0.map(|r| r.map(|v| v * scale)));
        for neutral in [
            [1., 1., 1.],
            [0.55, 1., 0.62],
            [0.3, 1., 1.8],
            [1.4, 1., 0.2],
        ] {
            let actual = balanced_bradford(cm, neutral).unwrap();
            assert_oracle(actual, cm, neutral);
            let white = actual.mul_vec([1.; 3]);
            for c in 0..3 {
                assert!((white[c] - XYZ_D50[c]).abs() < 2e-6);
            }
            assert!(actual.mul_vec([8.; 3])[1] > 7.9);
        }
    }
}

fn calibration(dual: bool) -> (SliderFrame, DcpProfile) {
    let warm = Matrix3([
        [0.7234, 0.0231, -0.0542],
        [-0.3956, 1.1998, 0.2239],
        [-0.0512, 0.1892, 0.5231],
    ]);
    let neutral = camera_neutral_for(CM, 5000., 15.);
    let profile = if dual {
        dcp::interpolated_profile(
            warm,
            Illuminant::StdA,
            CM,
            Illuminant::D65,
            neutral,
            true,
            None,
            None,
            None,
            None,
            None,
            None,
        )
    } else {
        let white = CM.inverse().unwrap().mul_vec(neutral);
        DcpProfile {
            wb_already_baked: true,
            scene_white_xyz: white.map(|v| v / white[1]),
            ..DcpProfile::from_embedded_cm(CM)
        }
    };
    let frame = SliderFrame {
        endpoints: None,
        cm_as_shot: CM,
        scene_cct: 5000.,
        scene_tint: 15.,
        render_cm: profile.color_matrix,
    };
    (frame, profile)
}

#[test]
fn resolved_single_and_dual_calibrations_follow_target_neutral() {
    for dual in [false, true] {
        let (frame, profile) = calibration(dual);
        for (temperature, tint) in [
            (2000., 0.),
            (2850., 25.),
            (5000., 15.),
            (6500., -40.),
            (12000., 0.),
            (50000., 0.),
        ] {
            let neutral = camera_neutral_for(frame.cm_for_cct(temperature), temperature, tint);
            let render_cct = profile.cm_endpoints.map_or(profile.scene_cct, |e| {
                dcp::compute_as_shot_cct(neutral, e.m_cold, e.cct_cold, e.m_warm, e.cct_warm)
            });
            let resolved = retargeted_render_profile(&frame, profile.clone(), temperature, tint);
            assert_oracle(
                M_PRO_TO_XYZ_D50.mul_mat(&dcp::camera_to_prophoto_matrix(&resolved).unwrap()),
                profile.color_matrix_for_cct(render_cct),
                neutral,
            );
            assert_eq!(resolved.color_matrix.0, profile.color_matrix.0);
        }
        let anchor =
            resolved_camera_to_xyz_d50(&frame, &profile, frame.scene_cct, frame.scene_tint);
        let within_identity = resolved_camera_to_xyz_d50(
            &frame,
            &profile,
            frame.scene_cct + 0.25,
            frame.scene_tint - 0.25,
        );
        assert_eq!(anchor.map(|m| m.0), within_identity.map(|m| m.0));
    }
}

#[test]
fn white_anchor_samples_the_same_as_shot_matrix_as_develop() {
    let (frame, profile) = calibration(true);
    let camera = Image {
        width: 5,
        height: 1,
        pixels: vec![
            [0.2, 0.4, 0.7],
            [1., 2., 3.],
            [8.; 3],
            [0.1; 3],
            [0.5, 0.8, 0.2],
        ],
        space: ColorSpace::CameraNativeLinearRgb,
        whites_anchor_ev: None,
        nr_sampling_scale: 1.,
    };
    let resolved =
        retargeted_render_profile(&frame, profile.clone(), frame.scene_cct, frame.scene_tint);
    assert_eq!(
        dcp::scene_white_anchor(&camera, &profile).unwrap(),
        dcp::scene_white_anchor(&camera, &resolved).unwrap()
    );
    let matrix = M_PRO_TO_XYZ_D50.mul_mat(&dcp::camera_to_prophoto_matrix(&profile).unwrap());
    let neutral = profile.color_matrix.mul_vec(profile.scene_white_xyz);
    assert_oracle(matrix, profile.color_matrix, neutral);
}

#[test]
fn existing_forward_and_unbalanced_contracts_remain_unchanged() {
    let (frame, profile) = calibration(false);
    for forward in [None, Some(Matrix3::IDENTITY)] {
        let unbalanced = DcpProfile {
            wb_already_baked: false,
            forward_matrix: forward,
            ..profile.clone()
        };
        assert_eq!(
            resolved_camera_to_xyz_d50(&frame, &unbalanced, 2000., 0.).map(|m| m.0),
            forward.map(|m| m.0)
        );
    }
    let forward = DcpProfile {
        forward_matrix: Some(Matrix3::IDENTITY),
        ..profile
    };
    assert_eq!(
        resolved_camera_to_xyz_d50(&frame, &forward, 12000., 0.)
            .unwrap()
            .0,
        Matrix3::IDENTITY.0
    );
    assert!(balanced_bradford(Matrix3([[0.; 3]; 3]), [1.; 3]).is_none());
    for invalid in [[0., 1., 1.], [f32::NAN, 1., 1.], [-1., 1., 1.]] {
        assert!(balanced_bradford(CM, invalid).is_none());
    }
}
