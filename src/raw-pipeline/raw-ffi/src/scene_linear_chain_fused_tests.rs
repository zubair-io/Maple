//! Byte-identity coverage for the #2092 fused FFI entry
//! (`maple_apply_chain_and_encode_display_f32`).
//!
//! The load-bearing claim of #2092 is: the fused entry's output is
//! EXACTLY what the two-step Swift path (`applySceneLinearChainViaFFI`
//! then `encodeDisplaySRGBViaFFI`) already produces — it is the same two
//! Rust functions called back-to-back, just without the intervening
//! Swift-side CIImage wrap/readback. These tests build a synthetic f32
//! RGBA buffer, run BOTH the two-step sequence (calling
//! `maple_apply_scene_linear_chain_f32` then `maple_encode_display_srgb_f32`
//! directly, exactly as the fused entry does internally) and the fused
//! entry, then assert bit-for-bit equality — no ΔE tolerance, no epsilon,
//! since this is a call-ordering change, not a math change.

use crate::scene_linear_chain::{
    maple_apply_scene_linear_chain_f32, maple_encode_display_srgb_f32, MapleAdjustmentParams,
};
use crate::scene_linear_chain_fused::maple_apply_chain_and_encode_display_f32;

/// Same field set as `scene_linear_chain_tests::default_params` (this crate
/// doesn't expose that helper across the test-module boundary) — a fully
/// zero/identity-ish `MapleAdjustmentParams`, callers override individual
/// fields per test.
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
        skip_agx: 0,
        look_mode: 0, // Look::Neutral — keeps the buffer scene-referred through AgX
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
        target_primaries: 0,
        input_shape: 0,
        noise_profile_ptr: std::ptr::null(),
        noise_profile_len: 0,
        iso: 100,
        wb_frame_m_cold: [0.0; 9],
        wb_frame_cct_cold: 0.0,
        wb_frame_m_warm: [0.0; 9],
        wb_frame_cct_warm: 0.0,
        wb_frame_scene_cct: 0.0,
        wb_frame_as_shot_tint: 0.0,
        wb_frame_render_cm: [0.0; 9],
        wb_frame_render_forward_matrix: [0.0; 9],
        wb_frame_render_scene_white_xyz: [0.0; 3],
        wb_frame_render_wb_already_baked: 0.0,
        wb_frame_render_cm_cold: [0.0; 9],
        wb_frame_render_cct_cold: 0.0,
        wb_frame_render_cm_warm: [0.0; 9],
        wb_frame_render_cct_warm: 0.0,
        wb_frame_render_fm_cold: [0.0; 9],
        wb_frame_render_fm_warm: [0.0; 9],
        bw_active: 0.0,
        bw_mix_red: 0.0,
        bw_mix_orange: 0.0,
        bw_mix_yellow: 0.0,
        bw_mix_green: 0.0,
        bw_mix_aqua: 0.0,
        bw_mix_blue: 0.0,
        bw_mix_purple: 0.0,
        bw_mix_magenta: 0.0,
    }
}

/// Deterministic, non-trivial synthetic buffer — a small checkerboard-ish
/// ramp with distinct R/G/B/A per pixel so a stage that mishandles channel
/// order or a stray transpose would show up as a mismatch, not accidental
/// symmetry hiding a bug.
fn synthetic_input(width: usize, height: usize) -> Vec<f32> {
    let mut buf = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as f32;
            buf.push((0.05 + 0.01 * i).min(4.0)); // R — scene-linear can exceed 1.0
            buf.push((0.15 + 0.02 * i).min(4.0)); // G
            buf.push((0.25 + 0.015 * i).min(4.0)); // B
            buf.push(1.0); // A — straight alpha, opaque
        }
    }
    buf
}

/// Run the two-step sequence directly (chain, then encode on its output) —
/// exactly what `ImageEditPipeline.processSceneLinear` does today via two
/// separate FFI calls with a CIImage wrap/readback in between (the wrap
/// step is a lossless bytes round-trip, so calling the two Rust entries
/// back-to-back here is a faithful stand-in for the Swift-side sequence).
fn run_two_step(
    input: &[f32],
    width: u32,
    height: u32,
    params: &MapleAdjustmentParams,
) -> Vec<f32> {
    let lanes = input.len();
    let mut chained = vec![0f32; lanes];
    let rc1 = unsafe {
        maple_apply_scene_linear_chain_f32(
            input.as_ptr(),
            width,
            height,
            params,
            chained.as_mut_ptr(),
        )
    };
    assert_eq!(rc1, 0, "two-step chain call failed");

    let mut encoded = vec![0f32; lanes];
    let rc2 = unsafe {
        maple_encode_display_srgb_f32(chained.as_ptr(), width, height, encoded.as_mut_ptr())
    };
    assert_eq!(rc2, 0, "two-step encode call failed");
    encoded
}

fn run_fused(input: &[f32], width: u32, height: u32, params: &MapleAdjustmentParams) -> Vec<f32> {
    let lanes = input.len();
    let mut fused = vec![0f32; lanes];
    let rc = unsafe {
        maple_apply_chain_and_encode_display_f32(
            input.as_ptr(),
            width,
            height,
            params,
            fused.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 0, "fused call failed");
    fused
}

/// The core claim: fused output == two-step output, bit-for-bit, on
/// identity-ish params (AgX applied, no slider adjustments).
#[test]
fn fused_matches_two_step_identity_params() {
    let (width, height) = (4u32, 3u32);
    let input = synthetic_input(width as usize, height as usize);
    let params = default_params();

    let two_step = run_two_step(&input, width, height, &params);
    let fused = run_fused(&input, width, height, &params);

    assert_eq!(
        fused, two_step,
        "fused entry must produce byte-identical output to the two-step sequence"
    );
}

/// Same claim with a non-trivial slider model — exposure, contrast, vibrance,
/// saturation, and an HSL band all pushed off their defaults, plus AgX
/// engaged (`skip_agx: 0`) and `Look::Default` (`look_mode: 1`) — the
/// realistic per-tick shape, not just the identity corner.
#[test]
fn fused_matches_two_step_nondefault_model() {
    let (width, height) = (6u32, 5u32);
    let input = synthetic_input(width as usize, height as usize);
    let mut params = default_params();
    params.exposure = 0.8;
    params.contrast = 15.0;
    params.highlights = -20.0;
    params.shadows = 25.0;
    params.vibrance = 30.0;
    params.saturation = -10.0;
    params.clarity = 10.0;
    params.dehaze = 5.0;
    params.hsl_sat_red = 20.0;
    params.hsl_hue_blue = -15.0;
    params.look_mode = 1;
    params.temperature = 7200.0;
    params.tint = 8.0;

    let two_step = run_two_step(&input, width, height, &params);
    let fused = run_fused(&input, width, height, &params);

    assert_eq!(
        fused, two_step,
        "fused entry must match the two-step sequence under a realistic non-default slider model"
    );
}

/// Non-RAW shape (`skip_agx: 1`, `input_shape: 1`) — the
/// `processSceneLinearNonRaw` caller shape — must also match bit-for-bit.
#[test]
fn fused_matches_two_step_non_raw_shape() {
    let (width, height) = (3u32, 3u32);
    let input = synthetic_input(width as usize, height as usize);
    let mut params = default_params();
    params.skip_agx = 1;
    params.input_shape = 1;
    params.temperature = 7000.0;
    params.tint = -12.0;

    let two_step = run_two_step(&input, width, height, &params);
    let fused = run_fused(&input, width, height, &params);

    assert_eq!(
        fused, two_step,
        "fused entry must match the two-step sequence on the non-RAW shape"
    );
}

/// Error propagation: a chain-stage failure (zero-dimension) must return
/// the SAME rc code the two-step chain call itself returns, not a fused-
/// specific code — callers branch on these codes today.
#[test]
fn fused_propagates_chain_stage_error_code() {
    let input = synthetic_input(2, 2);
    let params = default_params();
    let mut out = vec![0f32; input.len()];

    let rc = unsafe {
        maple_apply_chain_and_encode_display_f32(
            input.as_ptr(),
            0, // zero width — same guard as the chain entry
            2,
            &params,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(
        rc, 2,
        "zero-dimension must return the chain entry's own rc=2"
    );
}

/// Null-pointer guard, mirroring the two underlying entries' own checks.
#[test]
fn fused_rejects_null_pointers() {
    let params = default_params();
    let mut out = vec![0f32; 16];
    let rc = unsafe {
        maple_apply_chain_and_encode_display_f32(std::ptr::null(), 2, 2, &params, out.as_mut_ptr())
    };
    assert_eq!(rc, 1);
}
