//! #1734 — non-RAW (JPEG/HEIC) WB slider contract parity: the GPU-live chain
//! and the CPU `scene_linear_chain` FFI must compute the SAME white-balance
//! transform for a non-RAW input shape, as a D65-baseline delta.
//!
//! Split from `gpu_live_tests.rs` (600-LOC file budget), mirroring the
//! `gpu_live_airlight_tests.rs` / `gpu_live_p3_tests.rs` sibling-file pattern.
//!
//! ## The contract (per #1331 / #1734)
//!
//! For non-RAW shapes the uploaded buffer is ALREADY at the correct D65 white
//! point (linearised at session open), so "the WB the buffer was decoded at"
//! is always D65 (6500K / 0 tint) — there is no as-shot anchor to preserve.
//! The temp/tint sliders must therefore behave as a delta OFF that D65
//! baseline: `M_net = wb(live) · wb(6500, 0)⁻¹`, identity at the default
//! slider position, and shifting correctly as the user drags.
//!
//! Before this fix the two FFI entries disagreed on how to reach that
//! contract:
//!   - `gpu_live/params.rs::inputs_from_params` gates purely on
//!     `decoded_temperature > 0.0` (the 0/0 sentinel). A caller that leaves
//!     `decoded_temperature` at 0.0 for a non-RAW shape (the un-fixed Swift
//!     call site) gets `use_delta = false`, so the GPU chain applies
//!     `M_live` ABSOLUTELY — a drag-time pop the moment the slider leaves
//!     6500/0, wrong slope thereafter.
//!   - `scene_linear_chain.rs` / `scene_linear_chain_f32_entry.rs` instead
//!     COLLAPSE WB to identity outright for any non-zero `input_shape`
//!     (`decoded = (p.temperature, p.tint)` so `live == decoded` always),
//!     making the sliders permanently inert on the CPU refine path —
//!     regardless of what the GPU side did.
//!
//! Landing only the GPU half (making the Swift call site pass
//! `decoded_temperature = 6500.0` for non-RAW) would have made drags shift
//! live on the GPU chain then SNAP BACK to identity on the next CPU refine —
//! worse than the original bug. This test drives BOTH FFI entries with the
//! same non-RAW `(live, decoded)` pair and asserts they agree.

use super::gpu_live_tests::{make_params, owned_arrays};
use super::params::inputs_from_params;
use super::*;
use crate::scene_linear_chain::{maple_apply_scene_linear_chain_f32, MapleAdjustmentParams};
use raw_core::math::Matrix3;
use raw_core::types::WbMethod;
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// D65 neutral — the baseline every non-RAW decode is anchored to (#1331).
const D65_TEMP: f32 = 6500.0;
const D65_TINT: f32 = 0.0;

/// A non-neutral live WB well outside the `wb_is_noop` skip band, matching the
/// ticket's repro value (`temp=7000/tint=+20`).
const LIVE_TEMP: f32 = 7000.0;
const LIVE_TINT: f32 = 20.0;

/// Build the GPU-live params for a non-RAW (`SrgbGammaEncoded8`, JPEG/HEIC)
/// shape at `(temperature, tint)`, anchored to `(decoded_temperature,
/// decoded_tint)`. Delegates the bulk of the marshalling to
/// `gpu_live_tests::make_params` (neutral model, identity curve/LUT) and
/// overrides only the fields this test cares about — WB + shape.
#[allow(clippy::too_many_arguments)]
fn gpu_params_nonraw(
    arr: &super::gpu_live_tests::OwnedArrays,
    temperature: f32,
    tint: f32,
    decoded_temperature: f32,
    decoded_tint: f32,
) -> MapleGpuLiveParams {
    let model = AdjustmentModel::default();
    let mut params = make_params(&model, WbMethod::Cat16, 2, arr);
    params.temperature = temperature;
    params.tint = tint;
    params.decoded_temperature = decoded_temperature;
    params.decoded_tint = decoded_tint;
    params.input_shape = 2; // SrgbGammaEncoded8 (JPEG/HEIC) — the #1331 non-RAW tag
    params
}

/// Build the matching CPU-chain params for the same non-RAW shape / WB pair.
/// `input_shape = 2` (`SrgbGammaEncoded8`) is the JPEG/HEIC tag; `skip_agx = 1`
/// keeps the output in scene-linear space (no display encode / look tail) so
/// it is directly comparable to the GPU chain's pre-view-tail WB-only effect.
fn cpu_params_nonraw() -> MapleAdjustmentParams {
    MapleAdjustmentParams {
        temperature: LIVE_TEMP,
        tint: LIVE_TINT,
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
        // Spatial stages the chain took over from the deleted MSL kernels
        // (#1043); zeroed like the other stage knobs in this fixture.
        sharpen_amount: 0.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        sharpen_masking: 0.0,
        nr_color: 0.0,
        dehaze: 0.0,
        decoded_temperature: D65_TEMP,
        decoded_tint: D65_TINT,
        skip_agx: 1,
        look_mode: 0, // Look::Neutral — no display-domain look on the scene-linear probe
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
        color_grade_shadow_luminance: 0.0,
        color_grade_midtone_hue: 0.0,
        color_grade_midtone_saturation: 0.0,
        color_grade_midtone_luminance: 0.0,
        color_grade_highlight_luminance: 0.0,
        color_grade_global_hue: 0.0,
        color_grade_global_saturation: 0.0,
        color_grade_global_luminance: 0.0,
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
        // The shape under test: JPEG/HEIF non-RAW (#1331).
        input_shape: 2,
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

/// THE #1734 GATE: for a non-RAW input shape, the GPU-live WB matrix
/// (`inputs_from_params`) and the CPU `scene_linear_chain` FFI's WB effect
/// must agree — both must apply the D65-baseline delta
/// `wb(live) · wb(6500,0)⁻¹`, not diverge (absolute-vs-identity).
///
/// RED before the fix:
///   - `inputs_from_params` with `decoded_temperature = 0.0` (the un-fixed
///     Swift call site's sentinel for "no decoded WB") computes the ABSOLUTE
///     `M_live` — a large, wrong-for-this-contract matrix.
///   - `maple_apply_scene_linear_chain_f32` with `input_shape != 0` collapses
///     WB to IDENTITY regardless of `decoded_temperature` — inert.
///   Neither matches the D65-delta contract, and the two disagree with each
///   other by construction.
///
/// GREEN after the fix: both entries compute the identical D65-delta matrix
/// (within float tolerance), applied to a probe pixel.
#[test]
fn nonraw_wb_delta_matches_gpu_live_and_cpu_chain() {
    let probe: [f32; 3] = [0.6, 0.3, 0.15];

    // --- GPU-live side: the FFI marshalling fn both `maple_gpu_live_open` and
    //     `maple_gpu_live_render` call internally to build `FullChainInputs`.
    //     No GPU device needed — this is pure CPU matrix derivation. ---
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let model_for_arrays = AdjustmentModel::default();
    let arr = owned_arrays(&model_for_arrays, &curve, &lut);
    let gpu_params = gpu_params_nonraw(&arr, LIVE_TEMP, LIVE_TINT, D65_TEMP, D65_TINT);
    let gpu_inputs = unsafe { inputs_from_params(&gpu_params) };
    let gpu_result = Matrix3(gpu_inputs.wb_matrix).mul_vec(probe);

    // --- CPU chain side: the real FFI entry, on a 1x1 buffer, skip_agx so the
    //     output stays scene-linear (comparable to the GPU matrix applied
    //     directly to the probe pixel — no view-tail divergence). ---
    let cpu_params = cpu_params_nonraw();
    let input: Vec<f32> = vec![probe[0], probe[1], probe[2], 1.0];
    let mut out = vec![0.0f32; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
            input.as_ptr(),
            1,
            1,
            &cpu_params as *const _,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 0, "maple_apply_scene_linear_chain_f32 failed: rc={rc}");
    let cpu_result = [out[0], out[1], out[2]];

    // Sanity: the D65-delta must be a REAL shift (not accidentally identity) —
    // otherwise this test would pass vacuously regardless of the bug.
    let identity_delta = (gpu_result[0] - probe[0]).abs()
        + (gpu_result[1] - probe[1]).abs()
        + (gpu_result[2] - probe[2]).abs();
    assert!(
        identity_delta > 1e-3,
        "test setup error: temp=7000/tint=+20 vs D65 baseline must be a non-trivial \
         shift, got delta {identity_delta} — the probe or gate predicate is wrong"
    );

    for c in 0..3 {
        assert!(
            (gpu_result[c] - cpu_result[c]).abs() < 1e-4,
            "channel {c}: GPU-live D65-delta result {:?} vs CPU-chain result {:?} \
             diverge (non-RAW WB contract mismatch, #1734) — gpu={}, cpu={}",
            gpu_result,
            cpu_result,
            gpu_result[c],
            cpu_result[c]
        );
    }
}

/// At the default slider position (temp=6500/tint=0, i.e. `live == decoded`),
/// BOTH paths must be identity for a non-RAW shape — this is the "default
/// sliders are fine" half of the bug (`wb_is_noop` / the `apply_delta`
/// identity short-circuit already cover it pre-fix); guards against a fix
/// that accidentally breaks the no-op fast path.
#[test]
fn nonraw_wb_default_slider_is_identity_on_both_paths() {
    let probe: [f32; 3] = [0.6, 0.3, 0.15];
    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let model_for_arrays = AdjustmentModel::default();
    let arr = owned_arrays(&model_for_arrays, &curve, &lut);

    let gpu_params = gpu_params_nonraw(&arr, D65_TEMP, D65_TINT, D65_TEMP, D65_TINT);
    let gpu_inputs = unsafe { inputs_from_params(&gpu_params) };
    let gpu_result = Matrix3(gpu_inputs.wb_matrix).mul_vec(probe);

    let mut cpu_params = cpu_params_nonraw();
    cpu_params.temperature = D65_TEMP;
    cpu_params.tint = D65_TINT;
    let input: Vec<f32> = vec![probe[0], probe[1], probe[2], 1.0];
    let mut out = vec![0.0f32; 4];
    let rc = unsafe {
        maple_apply_scene_linear_chain_f32(
            input.as_ptr(),
            1,
            1,
            &cpu_params as *const _,
            out.as_mut_ptr(),
        )
    };
    assert_eq!(rc, 0);
    let cpu_result = [out[0], out[1], out[2]];

    for c in 0..3 {
        assert!(
            (gpu_result[c] - probe[c]).abs() < 1e-4,
            "GPU-live must be identity at default WB for non-RAW; channel {c} moved to {}",
            gpu_result[c]
        );
        assert!(
            (cpu_result[c] - probe[c]).abs() < 1e-4,
            "CPU-chain must be identity at default WB for non-RAW; channel {c} moved to {}",
            cpu_result[c]
        );
    }
}
