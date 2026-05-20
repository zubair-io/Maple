//! Tests for the per-tick scene-linear chain FFI entry
//! (`maple_apply_scene_linear_chain`). Argument-validation cases only —
//! the algorithmic correctness of the chain itself is covered in
//! `raw-core`'s pipeline tests; here we just want to prove the FFI
//! shim's pointer / geometry / overflow guards return the documented
//! rc codes and set `LAST_ERROR` instead of dereferencing junk.

use crate::error::maple_last_error;
use crate::scene_linear_chain::{maple_apply_scene_linear_chain, MapleAdjustmentParams};
use std::ffi::CStr;

fn default_params() -> MapleAdjustmentParams {
    MapleAdjustmentParams {
        temperature: 5500.0,
        tint: 0.0,
        exposure: 0.0,
        contrast: 0.0,
        highlights: 0.0,
        shadows: 0.0,
        whites: 0.0,
        blacks: 0.0,
        vibrance: 0.0,
        saturation: 0.0,
        clarity: 0.0,
        texture: 0.0,
        nr_luminance: 0.0,
        dehaze: 0.0,
        decoded_temperature: 5500.0,
        decoded_tint: 0.0,
        skip_agx: 1, // skip AgX in tests — keeps math trivial
    }
}

fn last_error_string() -> String {
    unsafe {
        let p = maple_last_error();
        if p.is_null() {
            return String::new();
        }
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

#[test]
fn null_in_ptr_returns_rc_1() {
    let params = default_params();
    let mut out = vec![0u16; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain(
            std::ptr::null(),
            1,
            1,
            &params as *const _,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 1);
    assert!(last_error_string().contains("null"));
}

#[test]
fn null_params_returns_rc_1() {
    let input = vec![0u16; 4];
    let mut out = vec![0u16; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain(
            input.as_ptr(),
            1,
            1,
            std::ptr::null(),
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 1);
    assert!(last_error_string().contains("null"));
}

#[test]
fn null_out_ptr_returns_rc_1() {
    let input = vec![0u16; 4];
    let params = default_params();
    let rc = unsafe {
        maple_apply_scene_linear_chain(
            input.as_ptr(),
            1,
            1,
            &params as *const _,
            std::ptr::null_mut(),
        )
    };
    assert_eq!(rc, 1);
    assert!(last_error_string().contains("null"));
}

#[test]
fn zero_width_returns_rc_2() {
    let input = vec![0u16; 4];
    let params = default_params();
    let mut out = vec![0u16; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain(
            input.as_ptr(),
            0,
            1,
            &params as *const _,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 2);
    assert!(last_error_string().contains("zero dimension"));
}

#[test]
fn zero_height_returns_rc_2() {
    let input = vec![0u16; 4];
    let params = default_params();
    let mut out = vec![0u16; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain(
            input.as_ptr(),
            1,
            0,
            &params as *const _,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 2);
    assert!(last_error_string().contains("zero dimension"));
}

#[test]
fn overflow_dimensions_return_rc_3() {
    // u32::MAX * u32::MAX * 4 overflows usize on 64-bit. On a 32-bit
    // target this still overflows (well past 2^32). With checked_mul
    // we must get rc 3 and an overflow message — NOT UB, NOT usize::MAX
    // fed to from_raw_parts.
    let input = vec![0u16; 4];
    let params = default_params();
    let mut out = vec![0u16; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain(
            input.as_ptr(),
            u32::MAX,
            u32::MAX,
            &params as *const _,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 3, "expected rc 3 (overflow), got {}", rc);
    let err = last_error_string();
    assert!(
        err.contains("overflow"),
        "expected overflow message, got {:?}",
        err
    );
}
