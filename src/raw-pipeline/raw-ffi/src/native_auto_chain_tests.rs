use super::*;
use raw_core::view::auto_profile::{apply_curve, lut::ColorLut};

#[test]
fn exact_tail_matches_rgb_reference_and_preserves_alpha_and_aliasing() {
    let params = crate::scene_linear_chain_tests::default_params();
    let input: Vec<f32> = (0..128)
        .flat_map(|i| {
            let x = i as f32 / 127.0;
            [x * 2.0 - 0.1, 1.0 - x, x * x, 0.3 + x * 0.6]
        })
        .collect();
    let mut curve = ProfileCurve::identity();
    curve.matrix[0][1] = 0.07;
    curve.chroma_boost = 1.05;
    let mut lut = ColorLut::identity(5);
    for (i, value) in lut.data.iter_mut().enumerate() {
        *value = (*value + (i % 7) as f32 * 0.002).clamp(0.0, 1.0);
    }
    for (use_curve, use_lut) in [(false, false), (true, false), (false, true), (true, true)] {
        let mut expected = vec![0.0; input.len()];
        assert_eq!(
            unsafe {
                crate::scene_linear_chain_fused::maple_apply_chain_and_encode_display_f32(
                    input.as_ptr(),
                    16,
                    8,
                    &params,
                    expected.as_mut_ptr(),
                )
            },
            0
        );
        let mut rgb: Vec<f32> = expected
            .chunks_exact(4)
            .flat_map(|p| p[..3].iter().copied())
            .collect();
        if use_curve {
            apply_curve(&mut rgb, &curve);
        }
        if use_lut {
            lut.apply(&mut rgb);
        }
        for (pixel, color) in expected.chunks_exact_mut(4).zip(rgb.chunks_exact(3)) {
            pixel[..3].copy_from_slice(color);
        }
        let flat = curve.to_flat();
        let mut actual = input.clone();
        assert_eq!(
            unsafe {
                maple_apply_chain_and_encode_native_auto_f32(
                    actual.as_ptr(),
                    16,
                    8,
                    &params,
                    if use_curve {
                        flat.as_ptr()
                    } else {
                        std::ptr::null()
                    },
                    if use_curve { flat.len() } else { 0 },
                    if use_lut {
                        lut.data.as_ptr()
                    } else {
                        std::ptr::null()
                    },
                    if use_lut { lut.size } else { 0 },
                    if use_lut { lut.data.len() } else { 0 },
                    actual.as_mut_ptr(),
                )
            },
            0
        );
        assert_eq!(actual, expected, "curve={use_curve} residual={use_lut}");
    }
}

#[test]
fn malformed_artifacts_refuse_before_writing_pixels() {
    let params = crate::scene_linear_chain_tests::default_params();
    let curve = ProfileCurve::identity().to_flat();
    let mut residual = ColorLut::identity(2).data;
    residual[4] = f32::NAN;
    for (curve_len, size, len) in [(219, 0, 0), (220, 1, 24), (220, 2, 23), (220, 2, 24)] {
        let mut out = [-7.0; 4];
        assert_eq!(
            unsafe {
                maple_apply_chain_and_encode_native_auto_f32(
                    [0.2, 0.3, 0.4, 1.0].as_ptr(),
                    1,
                    1,
                    &params,
                    curve.as_ptr(),
                    curve_len,
                    residual.as_ptr(),
                    size,
                    len,
                    out.as_mut_ptr(),
                )
            },
            -1
        );
        assert_eq!(out, [-7.0; 4]);
    }
}
