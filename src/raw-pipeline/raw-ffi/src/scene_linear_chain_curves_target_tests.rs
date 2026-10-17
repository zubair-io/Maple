//! #4738 (b): the P3-aware fused entry Apple's refine/export path uses needs
//! the same curve-aware twin the sRGB entry got in #2576/#2232, or every
//! point / parametric / display curve is dropped on a P3 canvas.

use crate::error::maple_last_error;
use crate::scene_linear_chain_curves::MapleToneCurves;
use crate::scene_linear_chain_curves_target::maple_apply_chain_and_encode_display_target_curves_f32;
use crate::scene_linear_chain_fused::maple_apply_chain_and_encode_display_target_f32;
use crate::scene_linear_chain_tests::default_params;
use std::ffi::CStr;

const WIDTH: u32 = 64;

fn ramp_rgba() -> Vec<f32> {
    (0..WIDTH)
        .flat_map(|x| {
            let v = (x as f32 + 0.5) / WIDTH as f32;
            [v, v * 0.7, v * 0.5, 1.0]
        })
        .collect()
}

fn identity_curves() -> MapleToneCurves {
    unsafe { std::mem::zeroed() }
}

unsafe fn encode_target(curves: *const MapleToneCurves, target: u32) -> Vec<f32> {
    let input = ramp_rgba();
    let mut out = vec![0.0f32; input.len()];
    let p = default_params();
    let rc = maple_apply_chain_and_encode_display_target_curves_f32(
        input.as_ptr(),
        WIDTH,
        1,
        &p,
        curves,
        target,
        out.as_mut_ptr(),
    );
    assert_eq!(rc, 0, "{:?}", CStr::from_ptr(maple_last_error()));
    out
}

#[test]
fn null_curves_match_the_curve_less_target_entry_bit_for_bit() {
    let input = ramp_rgba();
    let mut reference = vec![0.0f32; input.len()];
    let p = default_params();
    let rc = unsafe {
        maple_apply_chain_and_encode_display_target_f32(
            input.as_ptr(),
            WIDTH,
            1,
            &p,
            1,
            reference.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 0);
    let out = unsafe { encode_target(std::ptr::null(), 1) };
    assert_eq!(
        out, reference,
        "no curves ⇒ identical to the existing P3 entry"
    );
}

#[test]
fn parametric_and_point_curves_reach_the_p3_encode() {
    let baseline = unsafe { encode_target(&identity_curves(), 1) };
    let mut curved = identity_curves();
    curved.parametric_highlights = 70.0;
    let lifted = unsafe { encode_target(&curved, 1) };
    assert_ne!(
        baseline, lifted,
        "a parametric region must change the P3 render"
    );

    let knots: [f32; 6] = [0.0, 0.0, 0.5, 0.7, 1.0, 1.0];
    let mut pointed = identity_curves();
    pointed.luma_ptr = knots.as_ptr();
    pointed.luma_len = knots.len();
    let point = unsafe { encode_target(&pointed, 1) };
    assert_ne!(baseline, point, "a point curve must change the P3 render");
}

#[test]
fn rejects_an_unknown_target_primaries_value() {
    let input = ramp_rgba();
    let mut out = vec![0.0f32; input.len()];
    let p = default_params();
    let rc = unsafe {
        maple_apply_chain_and_encode_display_target_curves_f32(
            input.as_ptr(),
            WIDTH,
            1,
            &p,
            std::ptr::null(),
            7,
            out.as_mut_ptr(),
        )
    };
    assert_ne!(rc, 0);
}
