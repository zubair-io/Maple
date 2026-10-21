//! A DNG ForwardMatrix resolved for one unit's calibration (#4646).
//!
//! dng_sdk (`dng_color_spec::SetWhiteXY`) maps *unbalanced* camera RGB to
//! XYZ-D50 with `FM · diag(R·w)⁻¹ · R`, where `R = (AnalogBalance ·
//! CameraCalibration)⁻¹` takes this unit's RGB to the reference camera's
//! and `w` is the camera white. Maple divides the buffer by `w` before DCP,
//! so the matrix its balanced pixels need is that product times `diag(w)`.
//!
//! A diagonal correction commutes with `diag(w)` and the whole product is
//! `FM`, at every white: per-channel gains are absorbed by white balance.
//! Only a non-diagonal correction depends on `w`. Decode resolves it at the
//! as-shot white, which is exact for an as-shot render; a retargeted white
//! keeps that resolution, and dual-illuminant endpoints are resolved
//! before interpolation rather than after, until #5093 carries the
//! correction through the GPU live chain's frame export.
use crate::math::{Matrix3, Vec3};

pub(crate) fn balanced_forward_matrix(
    forward_matrix: Matrix3,
    individual: Matrix3,
    camera_white: Vec3,
) -> Matrix3 {
    if is_diagonal(&individual) || camera_white.iter().any(|v| !(*v > 0.)) {
        return forward_matrix;
    }
    let Some(to_reference) = individual.inverse() else {
        return forward_matrix;
    };
    let reference_white = to_reference.mul_vec(camera_white);
    if reference_white.iter().any(|v| !(*v > 0.)) {
        return forward_matrix;
    }
    forward_matrix
        .mul_mat(&diagonal(reference_white.map(|v| 1. / v)))
        .mul_mat(&to_reference)
        .mul_mat(&diagonal(camera_white))
}

fn is_diagonal(m: &Matrix3) -> bool {
    (0..3).all(|i| (0..3).all(|j| i == j || m.0[i][j] == 0.))
}

fn diagonal(v: Vec3) -> Matrix3 {
    Matrix3([[v[0], 0., 0.], [0., v[1], 0.], [0., 0., v[2]]])
}

#[cfg(test)]
mod tests {
    use super::*;

    const FM: Matrix3 = Matrix3([
        [0.7868, 0.0092, 0.1683],
        [0.2291, 0.8615, -0.0906],
        [0.0027, -0.4752, 1.2976],
    ]);
    const NON_DIAGONAL: Matrix3 =
        Matrix3([[1.04, 0.03, -0.01], [0.02, 1.0, 0.04], [-0.02, 0.05, 0.93]]);
    const WHITE: Vec3 = [0.52, 1.0, 0.71];

    /// The dng_sdk transform on unbalanced camera RGB, written out
    /// independently: reference RGB `R·p`, divided by the reference white,
    /// then FM.
    fn sdk_xyz(individual: Matrix3, white: Vec3, unbalanced: Vec3) -> Vec3 {
        let to_reference = individual.inverse().unwrap();
        let reference = to_reference.mul_vec(unbalanced);
        let reference_white = to_reference.mul_vec(white);
        FM.mul_vec(std::array::from_fn(|c| reference[c] / reference_white[c]))
    }

    fn close(a: Vec3, b: Vec3) -> bool {
        a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 2e-5)
    }

    #[test]
    fn identity_and_diagonal_calibration_leave_the_forward_matrix_exactly() {
        assert_eq!(balanced_forward_matrix(FM, Matrix3::IDENTITY, WHITE), FM);
        let analog_and_calibration = diagonal([1.983051 * 1.0022, 1., 1.477273 * 0.9836]);
        for white in [WHITE, [1., 1., 1.], [0.31, 1., 1.24]] {
            assert_eq!(
                balanced_forward_matrix(FM, analog_and_calibration, white),
                FM,
                "a retargeted white keeps the exact FM"
            );
        }
    }

    /// Folding `FM · (AB·CC)⁻¹` after the pre-gain would take a neutral
    /// off the D50 white `FM · (1, 1, 1)` (#4646).
    #[test]
    fn a_neutral_reaches_the_forward_matrix_white_under_any_calibration() {
        let d50 = FM.mul_vec([1., 1., 1.]);
        for individual in [diagonal([1.983, 1., 1.453]), NON_DIAGONAL] {
            let balanced = balanced_forward_matrix(FM, individual, WHITE);
            assert!(close(balanced.mul_vec([1., 1., 1.]), d50));
            assert!(close(sdk_xyz(individual, WHITE, WHITE), d50));
        }
        let folded = FM.mul_mat(&diagonal([1.983, 1., 1.453]).inverse().unwrap());
        assert!(!close(folded.mul_vec([1., 1., 1.]), d50));
    }

    #[test]
    fn coloured_samples_match_the_sdk_transform_on_unbalanced_rgb() {
        for unbalanced in [[0.31, 0.62, 0.12], [0.05, 0.2, 0.44], [0.9, 0.4, 0.33]] {
            let balanced = balanced_forward_matrix(FM, NON_DIAGONAL, WHITE)
                .mul_vec(std::array::from_fn(|c| unbalanced[c] / WHITE[c]));
            assert!(
                close(balanced, sdk_xyz(NON_DIAGONAL, WHITE, unbalanced)),
                "{unbalanced:?}"
            );
        }
    }

    #[test]
    fn a_degenerate_calibration_keeps_the_forward_matrix() {
        let singular = Matrix3([[1., 2., 0.], [2., 4., 0.], [0., 0., 1.]]);
        assert_eq!(balanced_forward_matrix(FM, singular, WHITE), FM);
        let flips_white = Matrix3([[0., 1., 0.1], [1., 0., 0.], [0., 0., -1.]]);
        assert_eq!(balanced_forward_matrix(FM, flips_white, WHITE), FM);
        assert_eq!(
            balanced_forward_matrix(FM, NON_DIAGONAL, [0.5, 1., 0.]),
            FM,
            "a zero white channel must not zero an FM column"
        );
    }
}
