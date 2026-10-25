//! The cache key of a retained [`super::FrameHaze`] (#3287): only what the
//! retained maps are measured from. Every holder (`DetailContext`, raster
//! detail, the FFI window memo) keys on it, so an edit downstream of the last
//! map — or to an amount no map is measured after — reuses the maps.

use super::engaged;
use crate::types::{LocalAdjustment, PartialAdjustments};
use crate::xmp::AdjustmentModel;

/// `model` reduced to the inputs its haze maps depend on. Two models with
/// equal keys measure equal maps.
///
/// - Stages after the local adjustments (vignette, sharpen, NR, the AgX
///   tail, colour grade, film, grain, display curves, geometry) feed no map.
/// - Layers after the last one that engages dehaze feed no map; the last
///   layer's controls after its dehaze (sharpness, noise, defringe) do not
///   either, and its own amount only decides whether its map exists.
/// - With no dehaze layer, the global map is measured before defringe and
///   the layers, and the global amount, too, only decides existence.
pub fn haze_key(model: &AdjustmentModel) -> AdjustmentModel {
    let engagement = |v: f32| if engaged(v) { 1.0 } else { 0.0 };
    let last = model
        .local_adjustments
        .iter()
        .rposition(|layer| layer.adjustments.dehaze.is_some_and(engaged));
    let layers: Vec<LocalAdjustment> = match last {
        None => Vec::new(),
        Some(last) => model.local_adjustments[..=last]
            .iter()
            .enumerate()
            .map(|(i, layer)| match i == last {
                false => layer.clone(),
                true => LocalAdjustment {
                    adjustments: PartialAdjustments {
                        dehaze: layer.adjustments.dehaze.map(engagement),
                        sharpness: None,
                        luminance_noise: None,
                        defringe: None,
                        ..layer.adjustments.clone()
                    },
                    ..layer.clone()
                },
            })
            .collect(),
    };
    let d = AdjustmentModel::default();
    let defringe_upstream = last.is_some();
    AdjustmentModel {
        dehaze: if defringe_upstream {
            model.dehaze
        } else {
            engagement(model.dehaze)
        },
        mask_rasters: if defringe_upstream {
            model.mask_rasters.clone()
        } else {
            Vec::new()
        },
        local_adjustments: layers,
        defringe_purple_amount: pick(
            defringe_upstream,
            model.defringe_purple_amount,
            d.defringe_purple_amount,
        ),
        defringe_purple_hue_lo: pick(
            defringe_upstream,
            model.defringe_purple_hue_lo,
            d.defringe_purple_hue_lo,
        ),
        defringe_purple_hue_hi: pick(
            defringe_upstream,
            model.defringe_purple_hue_hi,
            d.defringe_purple_hue_hi,
        ),
        defringe_green_amount: pick(
            defringe_upstream,
            model.defringe_green_amount,
            d.defringe_green_amount,
        ),
        defringe_green_hue_lo: pick(
            defringe_upstream,
            model.defringe_green_hue_lo,
            d.defringe_green_hue_lo,
        ),
        defringe_green_hue_hi: pick(
            defringe_upstream,
            model.defringe_green_hue_hi,
            d.defringe_green_hue_hi,
        ),
        vignette_amount: d.vignette_amount,
        vignette_feather: d.vignette_feather,
        sharpen_amount: d.sharpen_amount,
        sharpen_radius: d.sharpen_radius,
        sharpen_detail: d.sharpen_detail,
        sharpen_masking: d.sharpen_masking,
        nr_luminance: d.nr_luminance,
        nr_color: d.nr_color,
        contrast: d.contrast,
        whites: d.whites,
        grain_amount: d.grain_amount,
        grain_size: d.grain_size,
        grain_roughness: d.grain_roughness,
        film_look: d.film_look.clone(),
        film_strength: d.film_strength,
        split_tone_shadow_hue: d.split_tone_shadow_hue,
        split_tone_shadow_saturation: d.split_tone_shadow_saturation,
        split_tone_highlight_hue: d.split_tone_highlight_hue,
        split_tone_highlight_saturation: d.split_tone_highlight_saturation,
        split_tone_balance: d.split_tone_balance,
        color_grade_shadow_luminance: d.color_grade_shadow_luminance,
        color_grade_midtone_hue: d.color_grade_midtone_hue,
        color_grade_midtone_saturation: d.color_grade_midtone_saturation,
        color_grade_midtone_luminance: d.color_grade_midtone_luminance,
        color_grade_highlight_luminance: d.color_grade_highlight_luminance,
        color_grade_global_hue: d.color_grade_global_hue,
        color_grade_global_saturation: d.color_grade_global_saturation,
        color_grade_global_luminance: d.color_grade_global_luminance,
        color_grade_blending: d.color_grade_blending,
        color_grade_shadow_edge: d.color_grade_shadow_edge,
        color_grade_highlight_edge: d.color_grade_highlight_edge,
        display_tone_curve_luma: d.display_tone_curve_luma.clone(),
        display_tone_curve_red: d.display_tone_curve_red.clone(),
        display_tone_curve_green: d.display_tone_curve_green.clone(),
        display_tone_curve_blue: d.display_tone_curve_blue.clone(),
        crop: d.crop,
        perspective_vertical: d.perspective_vertical,
        perspective_horizontal: d.perspective_horizontal,
        perspective_rotate: d.perspective_rotate,
        perspective_scale: d.perspective_scale,
        perspective_aspect: d.perspective_aspect,
        perspective_x: d.perspective_x,
        perspective_y: d.perspective_y,
        ..model.clone()
    }
}

/// Feed `h` the part of a flat layer stack ([`crate::types::layers_to_flat`])
/// that [`haze_key`] keeps, without allocating: every layer up to the last
/// one that engages dehaze, that layer reduced like `haze_key` reduces it.
/// `false`, having fed nothing, when no layer engages dehaze.
pub fn hash_haze_layers(flat: &[f32], h: &mut impl std::hash::Hasher) -> bool {
    use crate::types::local_adjustment::flat::{
        KIND_GROUP, LAYER_FLAT_LEN, PRESENT_DEFRINGE, PRESENT_DEHAZE, PRESENT_LUMINANCE_NOISE,
        PRESENT_SHARPNESS, SPATIAL_BASE,
    };
    const KIND: usize = 6;
    const PRESENT: usize = 8;
    const DEHAZE: usize = SPATIAL_BASE + 2;
    let dropped = PRESENT_SHARPNESS | PRESENT_LUMINANCE_NOISE | PRESENT_DEFRINGE;
    let layers = || {
        let mut rest = flat;
        std::iter::from_fn(move || {
            let head = rest.get(..LAYER_FLAT_LEN)?;
            let records = if head[KIND] == KIND_GROUP {
                1 + head[0].max(0.0) as usize
            } else {
                1
            };
            let (layer, tail) = rest.split_at((records * LAYER_FLAT_LEN).min(rest.len()));
            rest = tail;
            Some(layer)
        })
    };
    let dehazes =
        |layer: &[f32]| layer[PRESENT] as u32 & PRESENT_DEHAZE != 0 && engaged(layer[DEHAZE]);
    let Some(last) = layers()
        .enumerate()
        .filter(|(_, l)| dehazes(l))
        .map(|(i, _)| i)
        .last()
    else {
        return false;
    };
    for (i, layer) in layers().take(last + 1).enumerate() {
        for (slot, &value) in layer.iter().enumerate() {
            let reduced = match (i == last, slot) {
                (true, PRESENT) => ((value as u32) & !dropped) as f32,
                (true, DEHAZE) => 1.0,
                (true, slot) if (DEHAZE + 1..DEHAZE + 4).contains(&slot) => 0.0,
                _ => value,
            };
            h.write_u32(reduced.to_bits());
        }
    }
    true
}

fn pick(upstream: bool, value: f32, default: f32) -> f32 {
    if upstream {
        value
    } else {
        default
    }
}

#[cfg(test)]
#[path = "dehaze_key_tests.rs"]
mod tests;
