//! The host-side haze-map key (#3287): a digest of what `dehaze::haze_key`
//! keeps, hashed straight off the C inputs so a cache hit allocates nothing.

use std::hash::Hasher;

use raw_core::stages::dehaze;

use crate::scene_linear_chain::MapleAdjustmentParams;
use crate::scene_linear_chain_curves::MapleToneCurves;

unsafe fn slice<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

fn floats(h: &mut impl Hasher, values: &[f32]) {
    h.write_usize(values.len());
    values.iter().for_each(|v| h.write_u32(v.to_bits()));
}

/// A digest of everything the haze maps for `params` depend on except the
/// frame's pixels, so a host can keep a [`super::MapleHazeMap`] per (frame,
/// digest) and skip rendering and handing over its frame on a hit. Hashes the
/// stages upstream of the maps (white balance with the decode's anchors,
/// slider frame and HueSatMap, or the capture decode's creative stage, tone, curves, HSL, B&W mix, clarity, texture,
/// the layers [`dehaze::hash_haze_layers`] keeps) and leaves out the stages
/// after them and the amounts no map depends on, like `dehaze::haze_key`.
/// `0` when no dehaze is engaged, or for a null argument. Allocates nothing.
///
/// # Safety
/// `params` null or a valid `MapleAdjustmentParams` (its pointers, including
/// `creative_ptr`, valid);
/// `curves` null or a valid `MapleToneCurves`.
#[no_mangle]
pub unsafe extern "C" fn maple_scene_linear_chain_haze_key(
    params: *const MapleAdjustmentParams,
    curves: *const MapleToneCurves,
) -> u64 {
    crate::error::catch_panic("maple_scene_linear_chain_haze_key", 0, || {
        let Some(p) = params.as_ref() else {
            return 0;
        };
        let mut h = std::collections::hash_map::DefaultHasher::new();
        let layers = slice(p.local_adjustments_ptr, p.local_adjustments_len);
        let layer_maps = dehaze::hash_haze_layers(layers, &mut h);
        if !layer_maps && !dehaze::engaged(p.dehaze) {
            return 0;
        }
        let defringe = [
            p.defringe_purple_amount,
            p.defringe_purple_hue_lo,
            p.defringe_purple_hue_hi,
            p.defringe_green_amount,
            p.defringe_green_hue_lo,
            p.defringe_green_hue_hi,
        ];
        let global_dehaze = if layer_maps { p.dehaze } else { 1.0 };
        floats(&mut h, if layer_maps { &defringe } else { &[] });
        floats(
            &mut h,
            &[
                global_dehaze,
                p.temperature,
                p.tint,
                p.exposure,
                p.highlights,
                p.shadows,
                p.blacks,
                p.vibrance,
                p.saturation,
                p.clarity,
                p.texture,
                p.decoded_temperature,
                p.decoded_tint,
                p.brightness,
                p.hsl_hue_red,
                p.hsl_hue_orange,
                p.hsl_hue_yellow,
                p.hsl_hue_green,
                p.hsl_hue_aqua,
                p.hsl_hue_blue,
                p.hsl_hue_purple,
                p.hsl_hue_magenta,
                p.hsl_sat_red,
                p.hsl_sat_orange,
                p.hsl_sat_yellow,
                p.hsl_sat_green,
                p.hsl_sat_aqua,
                p.hsl_sat_blue,
                p.hsl_sat_purple,
                p.hsl_sat_magenta,
                p.hsl_lum_red,
                p.hsl_lum_orange,
                p.hsl_lum_yellow,
                p.hsl_lum_green,
                p.hsl_lum_aqua,
                p.hsl_lum_blue,
                p.hsl_lum_purple,
                p.hsl_lum_magenta,
                p.wb_frame_cct_cold,
                p.wb_frame_cct_warm,
                p.wb_frame_scene_cct,
                p.wb_frame_as_shot_tint,
                p.wb_frame_render_wb_already_baked,
                p.wb_frame_render_cct_cold,
                p.wb_frame_render_cct_warm,
                p.bw_active,
                p.bw_mix_red,
                p.bw_mix_orange,
                p.bw_mix_yellow,
                p.bw_mix_green,
                p.bw_mix_aqua,
                p.bw_mix_blue,
                p.bw_mix_purple,
                p.bw_mix_magenta,
                p.whites_anchor_ev,
                p.nr_sampling_scale,
                p.wb_hsm_as_shot_cct,
                p.wb_hsm_exposure_gain,
            ],
        );
        [
            &p.wb_frame_m_cold[..],
            &p.wb_frame_m_warm,
            &p.wb_frame_render_cm,
            &p.wb_frame_render_forward_matrix,
            &p.wb_frame_render_scene_white_xyz,
            &p.wb_frame_render_cm_cold,
            &p.wb_frame_render_cm_warm,
            &p.wb_frame_render_fm_cold,
            &p.wb_frame_render_fm_warm,
            slice(p.wb_hsm_ptr, p.wb_hsm_len),
            slice(p.noise_profile_ptr, p.noise_profile_len as usize),
        ]
        .iter()
        .for_each(|values| floats(&mut h, values));
        match p.creative_ptr.as_ref() {
            Some(creative) => creative.hash_into(&mut h),
            None => h.write_u32(0),
        }
        [
            p.skip_agx,
            u32::from(p.look_mode),
            p.target_primaries,
            p.input_shape,
            p.iso,
            p.wb_method,
        ]
        .iter()
        .for_each(|v| h.write_u32(*v));
        if let Some(c) = curves.as_ref() {
            h.write_u32(c.mode);
            floats(
                &mut h,
                &[
                    c.parametric_highlights,
                    c.parametric_lights,
                    c.parametric_darks,
                    c.parametric_shadows,
                    c.parametric_shadow_split,
                    c.parametric_midtone_split,
                    c.parametric_highlight_split,
                ],
            );
            [
                slice(c.luma_ptr, c.luma_len),
                slice(c.red_ptr, c.red_len),
                slice(c.green_ptr, c.green_len),
                slice(c.blue_ptr, c.blue_len),
                slice(c.color_curve_hue_vs_hue_ptr, c.color_curve_hue_vs_hue_len),
                slice(c.color_curve_hue_vs_sat_ptr, c.color_curve_hue_vs_sat_len),
                slice(c.color_curve_hue_vs_luma_ptr, c.color_curve_hue_vs_luma_len),
                slice(c.color_curve_luma_vs_sat_ptr, c.color_curve_luma_vs_sat_len),
                slice(c.color_curve_sat_vs_sat_ptr, c.color_curve_sat_vs_sat_len),
                slice(c.color_curve_sat_vs_luma_ptr, c.color_curve_sat_vs_luma_len),
            ]
            .iter()
            .for_each(|values| floats(&mut h, values));
        }
        h.finish().max(1)
    })
}

#[cfg(test)]
#[path = "scene_linear_chain_haze_key_tests.rs"]
mod tests;
