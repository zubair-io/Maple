//! Tests for the per-tick scene-linear chain FFI entry
//! (`maple_apply_scene_linear_chain`). Argument-validation cases only —
//! the algorithmic correctness of the chain itself is covered in
//! `raw-core`'s pipeline tests; here we just want to prove the FFI
//! shim's pointer / geometry / overflow guards return the documented
//! rc codes and set `LAST_ERROR` instead of dereferencing junk.

use crate::error::maple_last_error;
use crate::scene_linear_chain::{
    maple_apply_scene_linear_chain, maple_apply_scene_linear_chain_f32, MapleAdjustmentParams,
};
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
        skip_agx: 1,  // skip AgX in tests — keeps math trivial
        look_mode: 1, // matches AdjustmentModel::default() — Look::Default
        brightness: 0.0,
        vignette_amount: 0.0,
        vignette_feather: 50.0,
        grain_amount: 0.0,
        grain_size: 25.0,
        grain_roughness: 50.0,
        split_tone_shadow_hue: 0.0,
        split_tone_shadow_saturation: 0.0,
        split_tone_highlight_hue: 0.0,
        split_tone_highlight_saturation: 0.0,
        split_tone_balance: 0.0,
        // Per-band HSL (identity — these tests only exercise the FFI shim's
        // pointer/geometry guards, not HSL math). Added to keep the struct
        // initializer complete after the 8-band HSL fields landed.
        hsl_hue_red: 0.0,
        hsl_hue_orange: 0.0,
        hsl_hue_yellow: 0.0,
        hsl_hue_green: 0.0,
        hsl_hue_aqua: 0.0,
        hsl_hue_blue: 0.0,
        hsl_hue_purple: 0.0,
        hsl_hue_magenta: 0.0,
        hsl_sat_red: 0.0,
        hsl_sat_orange: 0.0,
        hsl_sat_yellow: 0.0,
        hsl_sat_green: 0.0,
        hsl_sat_aqua: 0.0,
        hsl_sat_blue: 0.0,
        hsl_sat_purple: 0.0,
        hsl_sat_magenta: 0.0,
        hsl_lum_red: 0.0,
        hsl_lum_orange: 0.0,
        hsl_lum_yellow: 0.0,
        hsl_lum_green: 0.0,
        hsl_lum_aqua: 0.0,
        hsl_lum_blue: 0.0,
        hsl_lum_purple: 0.0,
        hsl_lum_magenta: 0.0,
        input_shape: 0,      // PostDcpRec2020Fp16 (RAW path, #1331)
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
        maple_apply_scene_linear_chain(input.as_ptr(), 1, 1, std::ptr::null(), out.as_mut_ptr())
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
        maple_apply_scene_linear_chain(input.as_ptr(), 0, 1, &params as *const _, out.as_mut_ptr())
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
        maple_apply_scene_linear_chain(input.as_ptr(), 1, 0, &params as *const _, out.as_mut_ptr())
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

// ----- f32 sibling: mirror the validation cases ----------------------

#[test]
fn f32_null_in_ptr_returns_rc_1() {
    let params = default_params();
    let mut out = vec![0.0f32; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
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
fn f32_null_params_returns_rc_1() {
    let input = vec![0.0f32; 4];
    let mut out = vec![0.0f32; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(input.as_ptr(), 1, 1, std::ptr::null(), out.as_mut_ptr())
    };
    assert_eq!(rc, 1);
    assert!(last_error_string().contains("null"));
}

#[test]
fn f32_null_out_ptr_returns_rc_1() {
    let input = vec![0.0f32; 4];
    let params = default_params();
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
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
fn f32_zero_width_returns_rc_2() {
    let input = vec![0.0f32; 4];
    let params = default_params();
    let mut out = vec![0.0f32; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
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
fn f32_zero_height_returns_rc_2() {
    let input = vec![0.0f32; 4];
    let params = default_params();
    let mut out = vec![0.0f32; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
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
fn f32_overflow_dimensions_return_rc_3() {
    let input = vec![0.0f32; 4];
    let params = default_params();
    let mut out = vec![0.0f32; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
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

/// End-to-end smoke: round-trip a small flat-gray buffer through the f32
/// FFI with `skip_agx=1`. Default model is identity at every cheap stage,
/// so the output must equal the input (no fp16 quantisation noise).
#[test]
fn f32_skip_agx_default_model_is_bit_identical_passthrough() {
    let w = 4u32;
    let h = 4u32;
    let lanes = (w * h * 4) as usize;
    let mut input = Vec::<f32>::with_capacity(lanes);
    for _ in 0..(w * h) as usize {
        input.push(0.18);
        input.push(0.18);
        input.push(0.18);
        input.push(1.0);
    }
    let params = default_params(); // skip_agx = 1, all stages identity
    let mut out = vec![0.0f32; lanes];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
            input.as_ptr(),
            w,
            h,
            &params as *const _,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 0, "expected success rc 0, got {}", rc);
    // Every R/G/B lane must read back as the input (default model is
    // identity); alpha is forced to 1.0 by the chain regardless.
    for i in 0..(w * h) as usize {
        assert!(
            (out[i * 4] - 0.18).abs() < 1e-5,
            "R drift at {}: {} != 0.18",
            i,
            out[i * 4]
        );
        assert!((out[i * 4 + 1] - 0.18).abs() < 1e-5);
        assert!((out[i * 4 + 2] - 0.18).abs() < 1e-5);
        assert!((out[i * 4 + 3] - 1.0).abs() < 1e-6);
    }
}

// ----- maple_encode_display_srgb_f32 (#877) — arg-validation shim --------

#[test]
fn encode_null_in_ptr_returns_rc_1() {
    use crate::scene_linear_chain::maple_encode_display_srgb_f32;
    let mut out = vec![0.0f32; 4];
    let rc = unsafe { maple_encode_display_srgb_f32(std::ptr::null(), 1, 1, out.as_mut_ptr()) };
    assert_eq!(rc, 1);
    assert!(last_error_string().contains("null"));
}

#[test]
fn encode_null_out_ptr_returns_rc_1() {
    use crate::scene_linear_chain::maple_encode_display_srgb_f32;
    let input = vec![0.0f32; 4];
    let rc = unsafe { maple_encode_display_srgb_f32(input.as_ptr(), 1, 1, std::ptr::null_mut()) };
    assert_eq!(rc, 1);
    assert!(last_error_string().contains("null"));
}

#[test]
fn encode_zero_dim_returns_rc_2() {
    use crate::scene_linear_chain::maple_encode_display_srgb_f32;
    let input = vec![0.0f32; 4];
    let mut out = vec![0.0f32; 4];
    let rc = unsafe { maple_encode_display_srgb_f32(input.as_ptr(), 0, 1, out.as_mut_ptr()) };
    assert_eq!(rc, 2);
    assert!(last_error_string().contains("zero dimension"));
}

#[test]
fn encode_saturated_green_compresses_blue_above_zero() {
    // The #877 contract end-to-end through the FFI shim: a saturated
    // display-linear Rec.2020 green ([0, 0.8, 0]) must NOT clip blue to 0 —
    // the Oklab compression keeps a real blue component (raw-core ref ≈ 0.168
    // sRGB-linear → ~0.45 after gamma). A per-channel clamp would leave 0.
    use crate::scene_linear_chain::maple_encode_display_srgb_f32;
    let input = vec![0.0f32, 0.8, 0.0, 1.0];
    let mut out = vec![0.0f32; 4];
    let rc = unsafe { maple_encode_display_srgb_f32(input.as_ptr(), 1, 1, out.as_mut_ptr()) };
    assert_eq!(rc, 0, "expected success rc 0, got {}", rc);
    assert_eq!(out[0], 0.0, "red must stay 0 on pure green");
    assert!(out[1] > 0.0 && out[1] <= 1.0, "green in (0,1]: {}", out[1]);
    assert!(
        out[2] > 0.3,
        "blue crushed ({}) — Oklab compression must keep blue, not per-channel clip",
        out[2]
    );
    assert!((out[3] - 1.0).abs() < 1e-6, "alpha must be 1.0");
}
