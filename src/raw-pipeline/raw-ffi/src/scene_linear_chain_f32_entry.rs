//! f32 variant of the scene-linear chain FFI entry, split into a sibling
//! module for the 600-line file budget. Same contract as the fp16 entry in
//! `scene_linear_chain.rs` — see that file's docs.

use super::*;
use crate::wb_frame_flat::{wb_frame_from_flat, WbFrameFlat};

#[no_mangle]
pub unsafe extern "C" fn maple_apply_scene_linear_chain_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    out_ptr: *mut f32,
) -> i32 {
    if in_ptr.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error("apply_scene_linear_chain_f32: null pointer".into());
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "apply_scene_linear_chain_f32: zero dimension width={} height={}",
            width, height
        ));
        return 2;
    }
    // Same checked-multiply guards as the fp16 entry — at u32::MAX dims
    // the RGBA lane product is ~2^66, which exceeds 64-bit usize. Without
    // the guards the unchecked product would wrap and feed nonsense to
    // from_raw_parts (UB).
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "apply_scene_linear_chain_f32: pixel-count overflow width={} height={}",
                width, height
            ));
            return 3;
        }
    };
    let p = &*params;

    let mut model = raw_core::xmp::AdjustmentModel::default();
    model.temperature = p.temperature;
    model.tint = p.tint;
    // Same rationale as the fp16 sibling above (#1725 / #1729): FFI params are
    // always explicit user state; set both seen-flags so resolve_wb passes the
    // values through unchanged instead of zeroing the tint on the CPU refine path.
    model.temperature_seen = true;
    model.tint_seen = true;
    model.exposure = p.exposure;
    model.brightness = p.brightness;
    model.contrast = p.contrast;
    model.highlights = p.highlights;
    model.shadows = p.shadows;
    model.whites = p.whites;
    model.blacks = p.blacks;
    model.vibrance = p.vibrance;
    model.saturation = p.saturation;
    model.clarity = p.clarity;
    model.texture = p.texture;
    model.nr_luminance = p.nr_luminance;
    model.dehaze = p.dehaze;
    model.vignette_amount = p.vignette_amount;
    model.vignette_feather = p.vignette_feather;
    model.grain_amount = p.grain_amount;
    model.grain_size = p.grain_size;
    model.grain_roughness = p.grain_roughness;
    model.split_tone_shadow_hue = p.split_tone_shadow_hue;
    model.split_tone_shadow_saturation = p.split_tone_shadow_saturation;
    model.split_tone_highlight_hue = p.split_tone_highlight_hue;
    model.split_tone_highlight_saturation = p.split_tone_highlight_saturation;
    model.split_tone_balance = p.split_tone_balance;
    // HSL 8-band adjustments (#1112) — FFI names hsl_*; raw-core names *_adjustment_*
    model.hue_adjustment_red = p.hsl_hue_red;
    model.hue_adjustment_orange = p.hsl_hue_orange;
    model.hue_adjustment_yellow = p.hsl_hue_yellow;
    model.hue_adjustment_green = p.hsl_hue_green;
    model.hue_adjustment_aqua = p.hsl_hue_aqua;
    model.hue_adjustment_blue = p.hsl_hue_blue;
    model.hue_adjustment_purple = p.hsl_hue_purple;
    model.hue_adjustment_magenta = p.hsl_hue_magenta;
    model.saturation_adjustment_red = p.hsl_sat_red;
    model.saturation_adjustment_orange = p.hsl_sat_orange;
    model.saturation_adjustment_yellow = p.hsl_sat_yellow;
    model.saturation_adjustment_green = p.hsl_sat_green;
    model.saturation_adjustment_aqua = p.hsl_sat_aqua;
    model.saturation_adjustment_blue = p.hsl_sat_blue;
    model.saturation_adjustment_purple = p.hsl_sat_purple;
    model.saturation_adjustment_magenta = p.hsl_sat_magenta;
    model.luminance_adjustment_red = p.hsl_lum_red;
    model.luminance_adjustment_orange = p.hsl_lum_orange;
    model.luminance_adjustment_yellow = p.hsl_lum_yellow;
    model.luminance_adjustment_green = p.hsl_lum_green;
    model.luminance_adjustment_aqua = p.hsl_lum_aqua;
    model.luminance_adjustment_blue = p.hsl_lum_blue;
    model.luminance_adjustment_purple = p.hsl_lum_purple;
    model.luminance_adjustment_magenta = p.hsl_lum_magenta;
    model.look = raw_core::view::look::Look::from(p.look_mode);

    // Non-RAW WB contract (#1331 / #1734) — same D65-baseline delta as the fp16
    // sibling in `scene_linear_chain.rs` (see that file's doc comment for the
    // full rationale): a non-RAW buffer is already at linear Rec.2020 D65, so
    // temp/tint apply as a delta OFF 6500K/0 tint, not identity. Scoped to
    // non-RAW (`input_shape != 0`) only — RAW callers keep the as-shot-anchored
    // `decoded_temperature`/`decoded_tint` passthrough unchanged.
    let (decoded_temp, decoded_tint) = if p.input_shape == 0 {
        (p.decoded_temperature, p.decoded_tint)
    } else {
        (6500.0, 0.0)
    };

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);

    // Map the `target_primaries` u32 tag (#1337) — same convention as the fp16 entry.
    let primaries = raw_core::view::encode::TargetPrimaries::from_u32(p.target_primaries);

    // Same noise-profile decode as the fp16 entry above.
    let noise_profile_slice_f32: Option<&[f32]> =
        if p.noise_profile_ptr.is_null() || p.noise_profile_len == 0 {
            None
        } else {
            // SAFETY: same contract as the fp16 entry.
            Some(unsafe {
                std::slice::from_raw_parts(p.noise_profile_ptr, p.noise_profile_len as usize)
            })
        };
    let iso_f32 = if p.iso == 0 { 100 } else { p.iso };

    // WB slider frame (#1781) — same RAW-shape gate as the fp16 sibling; an
    // absent frame (zeros) keeps the legacy generic CAT16 delta bit-identical.
    let wb_frame = wb_frame_from_flat(&WbFrameFlat {
        m_cold: &p.wb_frame_m_cold,
        cct_cold: p.wb_frame_cct_cold,
        m_warm: &p.wb_frame_m_warm,
        cct_warm: p.wb_frame_cct_warm,
        scene_cct: if p.input_shape == 0 {
            p.wb_frame_scene_cct
        } else {
            0.0
        },
        as_shot_tint: p.wb_frame_as_shot_tint,
        render_cm: &p.wb_frame_render_cm,
        render_forward_matrix: &p.wb_frame_render_forward_matrix,
        render_scene_white_xyz: &p.wb_frame_render_scene_white_xyz,
        render_wb_already_baked: p.wb_frame_render_wb_already_baked,
        render_cm_cold: &p.wb_frame_render_cm_cold,
        render_cct_cold: p.wb_frame_render_cct_cold,
        render_cm_warm: &p.wb_frame_render_cm_warm,
        render_cct_warm: p.wb_frame_render_cct_warm,
        render_fm_cold: &p.wb_frame_render_fm_cold,
        render_fm_warm: &p.wb_frame_render_fm_warm,
    });

    let opts = raw_core::pipeline::ChainOptions {
        decoded_temp,
        decoded_tint,
        wb_frame: Some(&wb_frame),
        skip_agx: p.skip_agx != 0,
        target_primaries: primaries,
        noise_profile: noise_profile_slice_f32,
        iso: iso_f32,
    };
    let out_vec = match raw_core::pipeline::apply_scene_linear_chain_f32(
        in_slice, width, height, &model, &opts,
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("apply_scene_linear_chain_f32: {}", e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "apply_scene_linear_chain_f32: chain returned {} lanes, expected {}",
            out_vec.len(),
            lanes
        ));
        return 9;
    }

    let out_slice = std::slice::from_raw_parts_mut(out_ptr, lanes);
    out_slice.copy_from_slice(&out_vec);
    0
}
