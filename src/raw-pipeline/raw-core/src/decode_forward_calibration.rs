//! ForwardMatrix calibration for the camera buffer after neutral pre-gain.

use crate::math::Matrix3;

/// For diagonal `C = AnalogBalance * CameraCalibration`, the DNG SDK's
/// `FM * diag(inv(C) * neutral)^-1 * inv(C)` on unbalanced samples is exactly
/// `FM` on samples already divided by `neutral`. Folding `inv(C)` again
/// changes neutral colors, including Adobe's reduced-RAW DNG exports (#4646).
pub(super) fn after_neutral_pre_gain(fm: Matrix3, correction: Matrix3) -> Matrix3 {
    let diagonal = (0..3).all(|i| {
        correction.0[i][i].is_finite()
            && correction.0[i][i] > 0.0
            && (0..3).all(|j| i == j || correction.0[i][j] == 0.0)
    });
    if diagonal {
        return fm;
    }
    // #4646 tracks the remaining non-diagonal path. Its reference-neutral
    // normalization depends on the active WB, so it needs retained calibration
    // through profile interpolation and the native WB-frame transport. Keep
    // the existing behavior until that complete path is qualified.
    correction.inverse().map_or(fm, |i2r| fm.mul_mat(&i2r))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FM: Matrix3 = Matrix3([
        [0.55, 0.25, 0.1642],
        [0.20, 0.70, 0.10],
        [0.10, 0.05, 0.6751],
    ]);

    fn diagonal(v: [f32; 3]) -> Matrix3 {
        Matrix3([[v[0], 0.0, 0.0], [0.0, v[1], 0.0], [0.0, 0.0, v[2]]])
    }

    #[test]
    fn diagonal_calibration_matches_independent_sdk_equation() {
        for gains in [[1.0; 3], [1.987414, 1.0, 1.453045], [0.41, 1.3, 2.2]] {
            let corrected = after_neutral_pre_gain(FM, diagonal(gains));
            assert_eq!(corrected.0, FM.0, "diagonal cancellation must be exact");
            for neutral in [[1.001304, 1.0, 0.9985], [0.2, 1.0, 0.7], [2.0, 0.3, 1.1]] {
                for sample in [neutral, [0.01, 0.2, 0.8], [2.0, 0.3, 4.0]] {
                    // Independent scalar SDK predictor: individual -> reference,
                    // divide by the reference neutral, then raw ForwardMatrix.
                    let reference_sample: [f32; 3] = std::array::from_fn(|i| sample[i] / gains[i]);
                    let reference_neutral: [f32; 3] =
                        std::array::from_fn(|i| neutral[i] / gains[i]);
                    let expected = FM.mul_vec(std::array::from_fn(|i| {
                        reference_sample[i] / reference_neutral[i]
                    }));
                    let actual = corrected.mul_vec(std::array::from_fn(|i| sample[i] / neutral[i]));
                    for c in 0..3 {
                        assert!((actual[c] - expected[c]).abs() <= 2e-6);
                    }
                }
            }
        }
    }

    #[test]
    fn converted_canon_neutral_remains_d50_after_pre_gain() {
        let correction = diagonal([1.983051 * 1.0022, 1.0, 1.477273 * 0.9836]);
        let actual = after_neutral_pre_gain(FM, correction).mul_vec([1.0; 3]);
        let expected = [0.9642, 1.0, 0.8251];
        for c in 0..3 {
            assert!((actual[c] - expected[c]).abs() < 1e-6);
        }
        let old = FM.mul_mat(&correction.inverse().unwrap()).mul_vec([1.0; 3]);
        assert!((old[0] - expected[0]).abs() > 0.3);
    }

    #[test]
    fn decoded_dng_keeps_raw_forward_matrix_for_diagonal_calibration() {
        use crate::color::{dcp, illuminant::Illuminant};
        use crate::image::{ColorSpace, Image};
        use crate::test_support::synth_dng::SyntheticGreyDng;

        let dng = SyntheticGreyDng {
            color_matrix_1_override: Some([
                [0.90, 0.10, 0.0],
                [0.05, 0.85, 0.10],
                [0.0, 0.15, 0.95],
            ]),
            forward_matrix_1: Some(FM.0),
            camera_calibration_1_override: Some(diagonal([1.0022, 1.0, 0.9836]).0),
            analog_balance_override: Some([1.983051, 1.0, 1.477273]),
            ..Default::default()
        };
        let raw = crate::decode::decode_bytes(&dng.write_to_bytes(), "dng").unwrap();
        let stored = raw.forward_matrices.get(&Illuminant::D65).unwrap();
        for row in 0..3 {
            for col in 0..3 {
                assert!((stored.0[row][col] - FM.0[row][col]).abs() < 1e-6);
            }
        }
        let mut neutral = Image::new(1, 1, ColorSpace::CameraNativeLinearRgb);
        neutral.pixels[0] = [1.0; 3];
        let actual = dcp::apply_colorimetry(&neutral, &dcp::profile_for(&raw).unwrap()).unwrap();
        for channel in actual.pixels[0] {
            assert!((channel - 1.0).abs() < 1e-3, "neutral became {channel}");
        }
    }
}
