//! #4741: the P3 Auto encode entries agree with raw-core and with each other.

use super::*;
use crate::error::maple_last_error;
use crate::scene_linear_chain::maple_apply_scene_linear_chain_f32;
use crate::scene_linear_chain_tests::default_params;
use raw_core::view::auto_profile::lut::ColorLut;
use std::ffi::CStr;

const WIDTH: u32 = 48;

fn saturated_ramp() -> Vec<f32> {
    (0..WIDTH)
        .flat_map(|x| {
            let v = (x as f32 + 0.5) / WIDTH as f32;
            [v * 0.1, v, v * 0.2, 1.0]
        })
        .collect()
}

fn warm_lut() -> ColorLut {
    let mut lut = ColorLut::identity(9);
    for (i, lane) in lut.data.iter_mut().enumerate() {
        *lane = (*lane + [0.03, -0.01, -0.02][i % 3]).clamp(0.0, 1.0);
    }
    lut
}

fn last_error() -> String {
    unsafe { CStr::from_ptr(maple_last_error()) }
        .to_string_lossy()
        .into_owned()
}

#[test]
fn encode_entry_matches_raw_core_and_may_alias() {
    let input = saturated_ramp();
    let lut = warm_lut();
    let expected =
        raw_core::pipeline::encode_display_p3_auto_f32(&input, WIDTH, 1, lut.size, &lut.data)
            .unwrap();
    let mut buffer = input.clone();
    let rc = unsafe {
        maple_encode_display_p3_auto_f32(
            buffer.as_ptr(),
            WIDTH,
            1,
            lut.data.as_ptr(),
            lut.size as u32,
            buffer.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 0, "{}", last_error());
    assert_eq!(buffer, expected);
}

#[test]
fn fused_entry_is_the_chain_then_the_p3_auto_encode() {
    let input = saturated_ramp();
    let lut = warm_lut();
    let params = default_params();
    let mut chained = vec![0.0f32; input.len()];
    let mut fused = vec![0.0f32; input.len()];
    unsafe {
        assert_eq!(
            maple_apply_scene_linear_chain_f32(
                input.as_ptr(),
                WIDTH,
                1,
                &params,
                chained.as_mut_ptr()
            ),
            0
        );
        let rc = maple_apply_chain_and_encode_display_p3_auto_f32(
            input.as_ptr(),
            WIDTH,
            1,
            &params,
            std::ptr::null(),
            lut.data.as_ptr(),
            lut.size as u32,
            std::ptr::null(),
            std::ptr::null(),
            fused.as_mut_ptr(),
        );
        assert_eq!(rc, 0, "{}", last_error());
    }
    let expected =
        raw_core::pipeline::encode_display_p3_auto_f32(&chained, WIDTH, 1, lut.size, &lut.data)
            .unwrap();
    assert_eq!(fused, expected);
}

#[test]
fn invalid_lattices_are_rejected_without_writing() {
    let input = saturated_ramp();
    let lut = warm_lut();
    let params = default_params();
    for (ptr, size) in [
        (std::ptr::null(), lut.size as u32),
        (lut.data.as_ptr(), 1),
        (lut.data.as_ptr(), u32::MAX),
    ] {
        let mut out = vec![-1.0f32; input.len()];
        let encode = unsafe {
            maple_encode_display_p3_auto_f32(input.as_ptr(), WIDTH, 1, ptr, size, out.as_mut_ptr())
        };
        let fused = unsafe {
            maple_apply_chain_and_encode_display_p3_auto_f32(
                input.as_ptr(),
                WIDTH,
                1,
                &params,
                std::ptr::null(),
                ptr,
                size,
                std::ptr::null(),
                std::ptr::null(),
                out.as_mut_ptr(),
            )
        };
        assert_eq!((encode, fused), (1, 1));
        assert!(last_error().contains("invalid lattice"));
        assert!(out.iter().all(|v| *v == -1.0));
    }
}
