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
        // sRGB primaries — the default (#1337, value 0).
        target_primaries: 0,
        // RAW shape — the full chain including WB (pre-#1331 default, value 0).
        input_shape: 0,
        // No noise profile (PR #1709 fix — new tail fields; null + 0 = None,
        // which maps to the pre-fix ISO-only fallback behaviour).
        noise_profile_ptr: std::ptr::null(),
        noise_profile_len: 0,
        iso: 100,
        wb_frame_m_cold: [0.0; 9],
        wb_frame_cct_cold: 0.0,
        wb_frame_m_warm: [0.0; 9],
        wb_frame_cct_warm: 0.0,
        wb_frame_scene_cct: 0.0,
        wb_frame_as_shot_tint: 0.0,
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
    // Red bound: pre-#1621 the gamut stage was a hard clip-to-hull, which
    // landed pure Rec.2020 green exactly ON the sRGB gamut's R=0 face, so
    // this asserted `out[0] == 0.0`. Commit 3ca37adb4 (#1621) replaced the
    // clip with a Reinhard soft-knee that compresses chroma strictly INSIDE
    // the hull — a far-out-of-gamut green desaturates slightly and picks up
    // a small hue-preserving red component by design. Measured at 3ca37adb4
    // (unchanged at main tip): out = [0.1057922, 0.8400208, 0.4544547]
    // sRGB-gamma, i.e. ~1.1% red in linear light. Neutral probes (white,
    // 0.18 grey, warm grey) are byte-identical across #1621, so the bleed is
    // chroma-confined — not a cast on neutrals. Ceiling 0.15 gamma (~1.9%
    // linear) is ~1.7× the measured value: loose enough for knee retunes,
    // tight enough that a real red-on-green regression (per-channel math
    // error, matrix swap) still fails.
    assert!(
        out[0] >= 0.0 && out[0] < 0.15,
        "red on pure green must stay a small soft-knee bleed (<0.15 gamma), got {}",
        out[0]
    );
    assert!(out[1] > 0.0 && out[1] <= 1.0, "green in (0,1]: {}", out[1]);
    assert!(
        out[2] > 0.3,
        "blue crushed ({}) — Oklab compression must keep blue, not per-channel clip",
        out[2]
    );
    // Channel ordering must survive the compression: green dominates, and
    // red stays the smallest component (hue preservation).
    assert!(
        out[1] > out[2] && out[2] > out[0],
        "pure-green channel ordering G > B > R lost: {:?}",
        &out[..3]
    );
    assert!((out[3] - 1.0).abs() < 1e-6, "alpha must be 1.0");
}

// ----- P3 target-primaries CPU-chain gate (#1337) -------------------------

/// CPU-CHAIN P3 WIRING GATE (#1337): confirms `target_primaries = 1` (Display
/// P3) is forwarded through `maple_apply_scene_linear_chain_f32` and actually
/// changes the output relative to `target_primaries = 0` (sRGB).
///
/// Uses a saturated Rec.2020 green input at post-AgX display-linear level
/// (0.5, 0.5, 0.5 neutral gray would produce identical P3/sRGB output since
/// neutral grays lie on the achromatic axis and both primary sets map them
/// identically). A saturated primary breaks symmetry; the P3 and sRGB renders
/// diverge on any wide-gamut content.
///
/// This test is the CPU-side sibling of `gpu_live_render_p3_primaries_marshals_correctly`
/// in `gpu_live_p3_tests.rs`. Both must pass for the P3 wiring to be
/// considered complete.
#[test]
fn f32_p3_target_primaries_differs_from_srgb() {
    let w = 4u32;
    let h = 4u32;
    let lanes = (w * h * 4) as usize;

    // Saturated Rec.2020 green-ish scene-linear patch: bright enough that
    // AgX places it well into the [0,1] display range, and green-heavy enough
    // that the Rec.2020→sRGB vs Rec.2020→P3 primary swap produces distinct
    // output bytes on at least some pixels.
    let mut input: Vec<f32> = Vec::with_capacity(lanes);
    for _ in 0..(w * h) as usize {
        input.push(0.05); // R — low
        input.push(0.80); // G — high (saturated green in Rec.2020)
        input.push(0.10); // B
        input.push(1.0); // A
    }

    // sRGB run (target_primaries = 0).
    let mut params_srgb = default_params();
    params_srgb.skip_agx = 0; // AgX must run for the display-encode branch to fire
    params_srgb.target_primaries = 0;
    let mut out_srgb = vec![0.0f32; lanes];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
            input.as_ptr(),
            w,
            h,
            &params_srgb as *const _,
            out_srgb.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 0, "sRGB run failed with rc {rc}");

    // P3 run (target_primaries = 1).
    let mut params_p3 = default_params();
    params_p3.skip_agx = 0;
    params_p3.target_primaries = 1;
    let mut out_p3 = vec![0.0f32; lanes];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
            input.as_ptr(),
            w,
            h,
            &params_p3 as *const _,
            out_p3.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 0, "P3 run failed with rc {rc}");

    // The two runs must differ (otherwise target_primaries is being silently
    // dropped). We count differing f32 lanes; at least the G channel of at
    // least one pixel must diverge.
    let diffs = out_srgb
        .iter()
        .zip(&out_p3)
        .filter(|(a, b)| a.to_bits() != b.to_bits())
        .count();
    assert!(
        diffs > 0,
        "P3 and sRGB CPU-chain outputs are byte-identical — \
         target_primaries=1 is not being applied in maple_apply_scene_linear_chain_f32"
    );
}
