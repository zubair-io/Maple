use super::*;
use std::ptr;

fn artifacts() -> (ProfileCurve, ColorLut) {
    let mut curve = ProfileCurve::identity();
    for anchor in &mut curve.r.anchors {
        anchor.1 = anchor.0.powf(0.7);
    }
    let mut residual = ColorLut::identity(5);
    for node in residual.data.chunks_exact_mut(3) {
        let [r, g, b] = [node[0], node[1], node[2]];
        node.copy_from_slice(&[0.8 * r + 0.15 * b, 0.75 * g + 0.2 * r, b]);
    }
    (curve, residual)
}

#[test]
fn residual_only_identity_preserves_white_without_curve_soft_knee() {
    let residual = ColorLut::identity(5);
    let mut output = vec![-7.; 5 * 5 * 5 * 3];
    assert_eq!(
        unsafe {
            maple_compose_auto_profile_lut(
                ptr::null(),
                0,
                residual.data.as_ptr(),
                residual.data.len(),
                5,
                5,
                output.as_mut_ptr(),
                output.len(),
            )
        },
        0
    );
    assert_eq!(&output[output.len() - 3..], &[1., 1., 1.]);
    for (actual, expected) in output.iter().zip(&residual.data) {
        assert!((actual - expected).abs() < 1e-6);
    }
}

#[test]
fn output_can_overlap_either_retained_input() {
    let (curve, residual) = artifacts();
    let flat = curve.to_flat();
    let expected = bake_auto_profile_lut(&curve, &residual, 9);
    for overlap_curve in [true, false] {
        let input = if overlap_curve { &flat } else { &residual.data };
        let mut shared = vec![-7.; expected.len() + 3];
        shared[..input.len()].copy_from_slice(input);
        let pointer = shared.as_mut_ptr();
        let result = unsafe {
            maple_compose_auto_profile_lut(
                if overlap_curve {
                    pointer
                } else {
                    flat.as_ptr()
                },
                flat.len(),
                if overlap_curve {
                    residual.data.as_ptr()
                } else {
                    pointer
                },
                residual.data.len(),
                5,
                9,
                pointer,
                shared.len(),
            )
        };
        assert_eq!(result, 0);
        assert_eq!(&shared[..expected.len()], expected.as_slice());
        assert_eq!(&shared[expected.len()..], &[-7.; 3]);
    }
}

#[test]
fn composition_matches_core_and_preserves_stage_order_and_output_tail() {
    let (curve, residual) = artifacts();
    let flat = curve.to_flat();
    let expected = bake_auto_profile_lut(&curve, &residual, 9);
    let mut output = vec![-7.; expected.len() + 3];
    assert_eq!(
        unsafe {
            maple_compose_auto_profile_lut(
                flat.as_ptr(),
                flat.len(),
                residual.data.as_ptr(),
                residual.data.len(),
                5,
                9,
                output.as_mut_ptr(),
                output.len(),
            )
        },
        0
    );
    assert_eq!(output[..expected.len()], expected);
    assert_eq!(output[expected.len()..], [-7.; 3]);
    let mut reversed = ColorLut::identity(9).data;
    residual.apply(&mut reversed);
    raw_core::view::auto_profile::apply_curve(&mut reversed, &curve);
    let delta = expected
        .iter()
        .zip(reversed)
        .map(|(a, b)| (a - b).abs())
        .fold(0_f32, f32::max);
    assert!(delta > 0.01, "fixture must detect reversed stage order");
    assert_eq!(flat, curve.to_flat());
}

#[test]
fn composition_supports_optional_curve_and_residual() {
    let (curve, residual) = artifacts();
    let flat = curve.to_flat();
    let mut output = vec![-7.; 9 * 9 * 9 * 3];
    assert_eq!(
        unsafe {
            maple_compose_auto_profile_lut(
                flat.as_ptr(),
                flat.len(),
                ptr::null(),
                0,
                0,
                9,
                output.as_mut_ptr(),
                output.len(),
            )
        },
        0
    );
    assert_eq!(output, bake_profile_lut(&curve, 9));
    assert_eq!(
        unsafe {
            maple_compose_auto_profile_lut(
                ptr::null(),
                0,
                residual.data.as_ptr(),
                residual.data.len(),
                5,
                9,
                output.as_mut_ptr(),
                output.len(),
            )
        },
        0
    );
    let mut expected = ColorLut::identity(9).data;
    residual.apply(&mut expected);
    assert_eq!(output, expected);
    let before = output.clone();
    assert_eq!(
        unsafe {
            maple_compose_auto_profile_lut(
                ptr::null(),
                0,
                ptr::null(),
                0,
                0,
                9,
                output.as_mut_ptr(),
                output.len(),
            )
        },
        1
    );
    assert_eq!(output, before);
}

#[test]
fn composition_rejects_invalid_dimensions_buffers_and_alignment_without_writes() {
    let (curve, residual) = artifacts();
    let flat = curve.to_flat();
    let mut output = vec![-7.; 9 * 9 * 9 * 3];
    let curve_unaligned = unsafe { flat.as_ptr().cast::<u8>().add(1).cast::<f32>() };
    let residual_unaligned = unsafe { residual.data.as_ptr().cast::<u8>().add(1).cast::<f32>() };
    let output_unaligned = unsafe { output.as_mut_ptr().cast::<u8>().add(1).cast::<f32>() };
    for (cp, cl, rp, rl, re, n, op, capacity, expected) in [
        (
            ptr::null(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            5,
            9,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len() - 1,
            residual.data.as_ptr(),
            residual.data.len(),
            5,
            9,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            curve_unaligned,
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            5,
            9,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            ptr::null(),
            residual.data.len(),
            5,
            9,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual_unaligned,
            residual.data.len(),
            5,
            9,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len() - 1,
            5,
            9,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            1,
            9,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            u32::MAX,
            9,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            5,
            0,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            5,
            1,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            5,
            MAX_LUT_SIZE as u32 + 1,
            output.as_mut_ptr(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            5,
            9,
            ptr::null_mut(),
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            5,
            9,
            output_unaligned,
            output.len(),
            -1,
        ),
        (
            flat.as_ptr(),
            flat.len(),
            residual.data.as_ptr(),
            residual.data.len(),
            5,
            9,
            output.as_mut_ptr(),
            output.len() - 1,
            -2,
        ),
    ] {
        assert_eq!(
            unsafe { maple_compose_auto_profile_lut(cp, cl, rp, rl, re, n, op, capacity) },
            expected
        );
        assert!(output.iter().all(|value| *value == -7.));
    }
}

#[test]
fn composition_rejects_nonfinite_artifacts_without_writes() {
    let (curve, mut residual) = artifacts();
    let mut flat = curve.to_flat();
    let mut output = vec![-7.; 9 * 9 * 9 * 3];
    for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let original = flat[1];
        flat[1] = value;
        assert_eq!(
            unsafe {
                maple_compose_auto_profile_lut(
                    flat.as_ptr(),
                    flat.len(),
                    residual.data.as_ptr(),
                    residual.data.len(),
                    5,
                    9,
                    output.as_mut_ptr(),
                    output.len(),
                )
            },
            -1
        );
        flat[1] = original;
        residual.data[0] = value;
        assert_eq!(
            unsafe {
                maple_compose_auto_profile_lut(
                    flat.as_ptr(),
                    flat.len(),
                    residual.data.as_ptr(),
                    residual.data.len(),
                    5,
                    9,
                    output.as_mut_ptr(),
                    output.len(),
                )
            },
            -1
        );
        residual.data[0] = 0.;
        assert!(output.iter().all(|value| *value == -7.));
    }
}
