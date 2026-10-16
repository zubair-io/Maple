use crate::{
    color::matrices::{bradford_adapt, XYZ_D50},
    math::Matrix3,
};

pub(crate) fn balanced_camera_to_xyz_d50(cm: Matrix3, neutral: [f32; 3]) -> Option<Matrix3> {
    if !neutral.iter().all(|v| v.is_finite() && *v > 1e-6) {
        return None;
    }
    let inverse = cm.inverse()?;
    let white = inverse.mul_vec(neutral);
    if !white.iter().all(|v| v.is_finite()) || white[1] <= 1e-6 {
        return None;
    }
    // Inverse CM consumes unbalanced camera values; restore that basis and
    // its Y normalization before adapting to PCS (#4665).
    let unbalance = Matrix3([
        [neutral[0] / white[1], 0., 0.],
        [0., neutral[1] / white[1], 0.],
        [0., 0., neutral[2] / white[1]],
    ]);
    let white = [white[0] / white[1], 1., white[2] / white[1]];
    let matrix = bradford_adapt(white, XYZ_D50)
        .mul_mat(&inverse)
        .mul_mat(&unbalance);
    matrix
        .0
        .iter()
        .flatten()
        .all(|v| v.is_finite())
        .then_some(matrix)
}
