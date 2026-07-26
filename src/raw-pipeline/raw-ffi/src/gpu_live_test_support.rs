//! Shared fixtures + param builders for the gpu_live test-file family
//! (`gpu_live_tests.rs`, `gpu_live_airlight_tests.rs`, `gpu_live_p3_tests.rs`,
//! `gpu_live_nonraw_wb_tests.rs`, `gpu_live_wb_frame_tests.rs`). Split from
//! `gpu_live_tests.rs` to keep that file under the 600-LOC hard budget; the
//! canonical import path stays `super::gpu_live_tests::{..}` via its
//! re-exports, so the sibling files are unchanged.

use super::*;
use raw_core::types::{ToneCurve, ToneCurveMode, WbMethod};
use raw_core::view::auto_profile::curve::{ChannelCurve, ProfileCurve};
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// A structured scene-linear Rec.2020 RGBA fixture (the kind post-DCP develop
/// produces). Mirrors the raw-gpu oracle's fixture so the two crates' parity
/// gates exercise the same content.
pub(super) fn scene_linear_rgba(w: usize, h: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let t = i as f32 / (w * h) as f32;
            let edge = if (x + y) % 5 == 0 { 0.6 } else { 0.0 };
            let r = (0.05 + t * 1.3 + edge).max(-0.02);
            let g = 0.04 + (1.0 - t) * 0.9 + 0.5 * ((x as f32 * 0.7).sin().abs());
            let b = 0.03 + t * 0.5 + 0.4 * ((y as f32 * 0.9).cos().abs());
            let (r, g, b) = match i % 11 {
                0 => (0.80, 0.10, 0.10),
                3 => (0.10, 0.80, 0.10),
                5 => (0.10, 0.10, 0.80),
                7 => (5.00, 3.00, 1.50),
                _ => (r, g, b),
            };
            v.extend_from_slice(&[r, g, b, 1.0]);
        }
    }
    v
}

/// A non-identity Auto Profile curve (per-channel gammas + a small cross matrix).
/// `pub(super)`: shared with the sibling `gpu_live_airlight_tests.rs` (as are the
/// LUT / CPU-reference / params / direct-render helpers below).
pub(super) fn nonidentity_curve() -> ProfileCurve {
    let gamma = |g: f32| {
        let mut c = ChannelCurve::identity();
        for a in c.anchors.iter_mut() {
            a.1 = a.0.powf(g);
        }
        c
    };
    let mut c = ProfileCurve::identity();
    c.r = gamma(0.9);
    c.g = gamma(1.05);
    c.b = gamma(0.95);
    c.matrix = [[0.98, 0.01, 0.01], [0.01, 0.98, 0.01], [0.01, 0.01, 0.98]];
    c
}

/// A non-identity residual LUT (identity grid warped by a mild per-node gamma).
pub(super) fn nonidentity_lut(size: usize) -> ColorLut {
    let mut lut = ColorLut::identity(size);
    for v in lut.data.iter_mut() {
        *v = v.clamp(0.0, 1.0).powf(0.92);
    }
    lut
}

/// Build a `MapleGpuLiveParams` from a model + curve/LUT, with the array pointers
/// aimed at the supplied owned buffers (which the CALLER must keep alive for the
/// render — returned alongside so they outlive the params).
pub(super) struct OwnedArrays {
    luma: Vec<f32>,
    red: Vec<f32>,
    green: Vec<f32>,
    blue: Vec<f32>,
    profile: Vec<f32>,
    residual: Vec<f32>,
    local: Vec<f32>,
}

fn flat_points(c: &ToneCurve) -> Vec<f32> {
    let mut v = Vec::with_capacity(c.points.len() * 2);
    for (x, y) in &c.points {
        v.push(*x);
        v.push(*y);
    }
    v
}

pub(super) fn owned_arrays(
    model: &AdjustmentModel,
    curve: &ProfileCurve,
    lut: &ColorLut,
) -> OwnedArrays {
    OwnedArrays {
        luma: flat_points(&model.tone_curve_luma),
        red: flat_points(&model.tone_curve_red),
        green: flat_points(&model.tone_curve_green),
        blue: flat_points(&model.tone_curve_blue),
        profile: curve.to_flat(),
        residual: lut.data.clone(),
        local: raw_core::types::layers_to_flat(&model.local_adjustments),
    }
}

pub(super) fn make_params(
    model: &AdjustmentModel,
    wb_method: WbMethod,
    lut_size: usize,
    arr: &OwnedArrays,
) -> MapleGpuLiveParams {
    let mode = match model.tone_curve_mode {
        ToneCurveMode::RatioPreserving => 1,
        ToneCurveMode::PerChannel => 0,
    };
    let wb = match wb_method {
        WbMethod::DiagonalRec2020 => 1,
        WbMethod::Cat16 => 0,
    };
    MapleGpuLiveParams {
        temperature: model.temperature,
        tint: model.tint,
        wb_method: wb,
        exposure: model.exposure,
        brightness: model.brightness,
        highlights: model.highlights,
        shadows: model.shadows,
        whites: model.whites,
        blacks: model.blacks,
        contrast: model.contrast,
        parametric_shadows: model.parametric_shadows,
        parametric_darks: model.parametric_darks,
        parametric_lights: model.parametric_lights,
        parametric_highlights: model.parametric_highlights,
        tone_curve_mode: mode,
        vibrance: model.vibrance,
        saturation: model.saturation,
        clarity: model.clarity,
        texture: model.texture,
        dehaze: model.dehaze,
        vignette_amount: model.vignette_amount,
        vignette_feather: model.vignette_feather,
        grain_amount: model.grain_amount,
        grain_size: model.grain_size,
        grain_roughness: model.grain_roughness,
        split_tone_shadow_hue: model.split_tone_shadow_hue,
        split_tone_shadow_saturation: model.split_tone_shadow_saturation,
        split_tone_highlight_hue: model.split_tone_highlight_hue,
        split_tone_highlight_saturation: model.split_tone_highlight_saturation,
        split_tone_balance: model.split_tone_balance,
        color_grade_shadow_luminance: model.color_grade_shadow_luminance,
        color_grade_midtone_hue: model.color_grade_midtone_hue,
        color_grade_midtone_saturation: model.color_grade_midtone_saturation,
        color_grade_midtone_luminance: model.color_grade_midtone_luminance,
        color_grade_highlight_luminance: model.color_grade_highlight_luminance,
        color_grade_global_hue: model.color_grade_global_hue,
        color_grade_global_saturation: model.color_grade_global_saturation,
        color_grade_global_luminance: model.color_grade_global_luminance,
        // HSL 8-band adjustments (#1112) — pass through from the model.
        hsl_hue_red: model.hue_adjustment_red,
        hsl_hue_orange: model.hue_adjustment_orange,
        hsl_hue_yellow: model.hue_adjustment_yellow,
        hsl_hue_green: model.hue_adjustment_green,
        hsl_hue_aqua: model.hue_adjustment_aqua,
        hsl_hue_blue: model.hue_adjustment_blue,
        hsl_hue_purple: model.hue_adjustment_purple,
        hsl_hue_magenta: model.hue_adjustment_magenta,
        hsl_sat_red: model.saturation_adjustment_red,
        hsl_sat_orange: model.saturation_adjustment_orange,
        hsl_sat_yellow: model.saturation_adjustment_yellow,
        hsl_sat_green: model.saturation_adjustment_green,
        hsl_sat_aqua: model.saturation_adjustment_aqua,
        hsl_sat_blue: model.saturation_adjustment_blue,
        hsl_sat_purple: model.saturation_adjustment_purple,
        hsl_sat_magenta: model.saturation_adjustment_magenta,
        hsl_lum_red: model.luminance_adjustment_red,
        hsl_lum_orange: model.luminance_adjustment_orange,
        hsl_lum_yellow: model.luminance_adjustment_yellow,
        hsl_lum_green: model.luminance_adjustment_green,
        hsl_lum_aqua: model.luminance_adjustment_aqua,
        hsl_lum_blue: model.luminance_adjustment_blue,
        hsl_lum_purple: model.luminance_adjustment_purple,
        hsl_lum_magenta: model.luminance_adjustment_magenta,
        sharpen_amount: model.sharpen_amount,
        sharpen_radius: model.sharpen_radius,
        sharpen_detail: model.sharpen_detail,
        sharpen_masking: model.sharpen_masking,
        nr_luminance: model.nr_luminance,
        nr_color: model.nr_color,
        capture_sharpening_enabled: 0,
        capture_sharpening_sigma: 1.0,
        capture_sharpening_iterations: 2,
        capture_sharpening_highlight_threshold: 0.9,
        capture_sharpening_strength: 1.0,
        tone_curve_luma_ptr: arr.luma.as_ptr(),
        tone_curve_luma_len: arr.luma.len(),
        tone_curve_red_ptr: arr.red.as_ptr(),
        tone_curve_red_len: arr.red.len(),
        tone_curve_green_ptr: arr.green.as_ptr(),
        tone_curve_green_len: arr.green.len(),
        tone_curve_blue_ptr: arr.blue.as_ptr(),
        tone_curve_blue_len: arr.blue.len(),
        profile_curve_ptr: arr.profile.as_ptr(),
        profile_curve_len: arr.profile.len(),
        residual_lut_size: lut_size as u32,
        residual_lut_ptr: arr.residual.as_ptr(),
        residual_lut_len: arr.residual.len(),
        local_adjustments_ptr: arr.local.as_ptr(),
        local_adjustments_len: arr.local.len(),
        // Decoded WB sentinel — 0/0 hits the legacy absolute apply branch in
        // `inputs_from_params`, preserving the pre-#1240 behaviour the parity
        // tests calibrate against. (Copilot review on #1262.)
        decoded_temperature: 0.0,
        decoded_tint: 0.0,
        // sRGB primaries (#1337 default, value 0).
        target_primaries: 0,
        // RAW shape — the full chain runs (the pre-#1331 default, value 0).
        input_shape: 0,
        // Auto/AgX view tail (#1722 default, value 0).
        profile_id: 0,
        // WB slider frame absent (#1781 default: zero-filled tail = the
        // legacy generic-CAT16 behaviour these parity tests calibrate).
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
        // Black & white mix (#276) — pass through from the model.
        bw_active: f32::from(u8::from(
            model.black_white == raw_core::types::BlackWhiteMode::On,
        )),
        bw_mix_red: model.gray_mixer_red,
        bw_mix_orange: model.gray_mixer_orange,
        bw_mix_yellow: model.gray_mixer_yellow,
        bw_mix_green: model.gray_mixer_green,
        bw_mix_aqua: model.gray_mixer_aqua,
        bw_mix_blue: model.gray_mixer_blue,
        bw_mix_purple: model.gray_mixer_purple,
        bw_mix_magenta: model.gray_mixer_magenta,
    }
}
