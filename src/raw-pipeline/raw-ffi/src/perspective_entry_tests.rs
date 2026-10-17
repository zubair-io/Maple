//! #4738 (b): Apple's export / refine path runs its own chain over the
//! scene-linear buffer and never applied `perspective`, which raw-core's
//! `render` applies in `finish` and the GPU-live present warps per tick.

use crate::error::maple_last_error;
use crate::perspective_entry::maple_apply_perspective_f32;
use std::ffi::CStr;

const W: u32 = 16;
const H: u32 = 8;

fn checker() -> Vec<f32> {
    (0..H)
        .flat_map(|y| {
            (0..W).flat_map(move |x| {
                let v = if (x / 4 + y / 4) % 2 == 0 { 0.9 } else { 0.1 };
                [v, v, v, 1.0]
            })
        })
        .collect()
}

unsafe fn warp(p: [f32; 7]) -> (i32, Vec<f32>) {
    let input = checker();
    let mut out = vec![0.0f32; input.len()];
    let rc = maple_apply_perspective_f32(
        input.as_ptr(),
        W,
        H,
        p[0],
        p[1],
        p[2],
        p[3],
        p[4],
        p[5],
        p[6],
        out.as_mut_ptr(),
    );
    (rc, out)
}

#[test]
fn identity_perspective_copies_the_input_unchanged() {
    let (rc, out) = unsafe { warp([0.0, 0.0, 0.0, 100.0, 0.0, 0.0, 0.0]) };
    assert_eq!(rc, 0, "{:?}", unsafe { CStr::from_ptr(maple_last_error()) });
    assert_eq!(out, checker());
}

#[test]
fn a_rotation_resamples_the_buffer() {
    let (rc, out) = unsafe { warp([0.0, 0.0, 10.0, 100.0, 0.0, 0.0, 0.0]) };
    assert_eq!(rc, 0);
    assert_ne!(out, checker());
    assert_eq!(out.len(), checker().len());
    assert!(out.iter().all(|v| v.is_finite()));
}

#[test]
fn rejects_null_and_zero_dimensions() {
    let mut out = vec![0.0f32; 4];
    let rc = unsafe {
        maple_apply_perspective_f32(
            std::ptr::null(),
            1,
            1,
            0.0,
            0.0,
            0.0,
            100.0,
            0.0,
            0.0,
            0.0,
            out.as_mut_ptr(),
        )
    };
    assert_ne!(rc, 0);
    let input = [0.5f32; 4];
    let rc = unsafe {
        maple_apply_perspective_f32(
            input.as_ptr(),
            0,
            1,
            0.0,
            0.0,
            0.0,
            100.0,
            0.0,
            0.0,
            0.0,
            out.as_mut_ptr(),
        )
    };
    assert_ne!(rc, 0);
}
