//! Guard-rail + contract tests for the patch-compositing FFI entries (#1486).
//!
//! The load-bearing case is `empty_patches_is_bit_identical_to_plain_entry`:
//! it pins the "pay nothing when there are no removals" contract AND doubles as
//! the regression gate for the shared `chain_inputs_from_params` extraction —
//! if that hoist ever changes the slider->model mapping, the plain and
//! patch-compositing entries stop agreeing and this test fails.

use super::scene_linear_chain::{
    maple_apply_scene_linear_chain, maple_apply_scene_linear_chain_f32,
    maple_apply_scene_linear_chain_f32_with_patches, maple_apply_scene_linear_chain_with_patches,
};
use super::scene_linear_chain_tests::default_params;
use raw_core::types::InpaintPatch;

const W: u32 = 8;
const H: u32 = 4;
const LANES: usize = (W * H * 4) as usize;

/// A mid-grey fp16 RGBA buffer (0.5 in half-float bits = 0x3800).
fn fp16_input() -> Vec<u16> {
    vec![0x3800u16; LANES]
}

fn f32_input() -> Vec<f32> {
    vec![0.5f32; LANES]
}

#[test]
fn empty_patches_is_bit_identical_to_plain_entry() {
    let p = default_params();
    let input = fp16_input();
    let mut plain = vec![0u16; LANES];
    let mut patched = vec![0u16; LANES];

    let rc_plain =
        unsafe { maple_apply_scene_linear_chain(input.as_ptr(), W, H, &p, plain.as_mut_ptr()) };
    let rc_patched = unsafe {
        maple_apply_scene_linear_chain_with_patches(
            input.as_ptr(),
            W,
            H,
            &p,
            std::ptr::null(),
            0,
            patched.as_mut_ptr(),
        )
    };

    assert_eq!(rc_plain, 0, "plain entry failed");
    assert_eq!(rc_patched, 0, "patch entry failed with empty patches");
    assert_eq!(
        plain, patched,
        "empty patches must be bit-identical to the plain chain"
    );
}

#[test]
fn empty_patches_is_bit_identical_to_plain_entry_f32() {
    let p = default_params();
    let input = f32_input();
    let mut plain = vec![0f32; LANES];
    let mut patched = vec![0f32; LANES];

    let rc_plain =
        unsafe { maple_apply_scene_linear_chain_f32(input.as_ptr(), W, H, &p, plain.as_mut_ptr()) };
    let rc_patched = unsafe {
        maple_apply_scene_linear_chain_f32_with_patches(
            input.as_ptr(),
            W,
            H,
            &p,
            std::ptr::null(),
            0,
            patched.as_mut_ptr(),
        )
    };

    assert_eq!(rc_plain, 0, "plain f32 entry failed");
    assert_eq!(rc_patched, 0, "patch f32 entry failed with empty patches");
    assert_eq!(
        plain, patched,
        "empty patches must be bit-identical to the plain f32 chain"
    );
}

#[test]
fn a_real_patch_blob_round_trips_and_changes_the_output() {
    let p = default_params();
    let input = f32_input();

    // A bright patch covering the whole frame at full coverage — the
    // composited result must differ from the un-patched render.
    let n = (W * H) as usize;
    let patch = InpaintPatch {
        width: W,
        height: H,
        origin: [0.0, 0.0],
        extent: [1.0, 1.0],
        pixels: vec![[0.9, 0.1, 0.1]; n],
        coverage: vec![1.0; n],
    };
    assert!(patch.is_valid(), "test patch must be well-formed");
    let blob = raw_core::pipeline::patches_to_blob(std::slice::from_ref(&patch));

    // The codec must survive the round trip before we trust the render delta.
    let decoded = raw_core::pipeline::patches_from_blob(&blob).expect("blob decodes");
    assert_eq!(decoded.len(), 1, "one patch in, one patch out");
    assert_eq!(decoded[0].width, W);
    assert_eq!(decoded[0].height, H);

    let mut plain = vec![0f32; LANES];
    let mut patched = vec![0f32; LANES];
    let rc_plain =
        unsafe { maple_apply_scene_linear_chain_f32(input.as_ptr(), W, H, &p, plain.as_mut_ptr()) };
    let rc_patched = unsafe {
        maple_apply_scene_linear_chain_f32_with_patches(
            input.as_ptr(),
            W,
            H,
            &p,
            blob.as_ptr(),
            blob.len(),
            patched.as_mut_ptr(),
        )
    };
    assert_eq!(rc_plain, 0);
    assert_eq!(rc_patched, 0);
    assert_ne!(
        plain, patched,
        "a full-coverage patch must change the rendered output"
    );
}

#[test]
fn malformed_blob_returns_rc_10() {
    let p = default_params();
    let input = f32_input();
    let mut out = vec![0f32; LANES];
    // Claims 9999 patches but carries no patch bodies.
    let bad = 9999u32.to_le_bytes().to_vec();
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32_with_patches(
            input.as_ptr(),
            W,
            H,
            &p,
            bad.as_ptr(),
            bad.len(),
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 10, "malformed patch blob must return rc 10");
}

#[test]
fn null_patch_pointer_with_nonzero_len_returns_rc_10() {
    let p = default_params();
    let input = fp16_input();
    let mut out = vec![0u16; LANES];
    let rc = unsafe {
        maple_apply_scene_linear_chain_with_patches(
            input.as_ptr(),
            W,
            H,
            &p,
            std::ptr::null(),
            32,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 10, "null blob pointer with len > 0 must return rc 10");
}

#[test]
fn null_and_zero_dimension_guards_match_the_plain_entry() {
    let p = default_params();
    let input = fp16_input();
    let mut out = vec![0u16; LANES];

    let rc_null = unsafe {
        maple_apply_scene_linear_chain_with_patches(
            std::ptr::null(),
            W,
            H,
            &p,
            std::ptr::null(),
            0,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc_null, 1, "null input must return rc 1");

    let rc_zero = unsafe {
        maple_apply_scene_linear_chain_with_patches(
            input.as_ptr(),
            0,
            H,
            &p,
            std::ptr::null(),
            0,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc_zero, 2, "zero width must return rc 2");
}
