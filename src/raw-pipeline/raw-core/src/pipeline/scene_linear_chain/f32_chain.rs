use super::*;

pub(super) fn apply_scene_linear_chain_f32_inner(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    opts: &ChainOptions<'_>,
    scope_layer: Option<usize>,
    film_lut: Option<&crate::film::FilmLut>,
    window: Option<ChainWindow>,
) -> Result<(Vec<f32>, Option<Vec<f32>>)> {
    let ChainOptions {
        decoded_temp,
        decoded_tint,
        wb_frame,
        skip_agx,
        target_primaries,
        noise_profile,
        iso,
        nr_sampling_scale,
        mask_long_edge,
        whites_anchor_ev,
    } = *opts;
    use crate::stages::{
        clarity, color_grade, defringe, dehaze, display_tone_curve, grain, hsl, local_adjustments,
        noise_reduction, saturation, scene_tone_controls, sharpen, texture, tone_curves, vibrance,
        vignette, white_balance,
    };
    use crate::view::agx;

    let pixel_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| {
            crate::error::Error::Pipeline(format!(
                "apply_scene_linear_chain_f32: pixel count overflow: {}x{}",
                width, height
            ))
        })?;
    let expected_len = pixel_count.checked_mul(4).ok_or_else(|| {
        crate::error::Error::Pipeline(format!(
            "apply_scene_linear_chain_f32: expected input length overflow (RGBA 4-lane multiplier): {}x{}",
            width, height
        ))
    })?;
    if in_f32_rgba.len() != expected_len {
        return Err(crate::error::Error::Pipeline(format!(
            "apply_scene_linear_chain_f32: input length {} != width({}) * height({}) * 4 = {}",
            in_f32_rgba.len(),
            width,
            height,
            expected_len
        )));
    }

    // Decode f32 RGBA -> Image (Vec<[f32; 3]>, alpha discarded).
    let mut img = stage("ffi_chain_unpack_f32", || {
        endcaps::unpack_f32(in_f32_rgba, width, height)
    });
    img.whites_anchor_ev = whites_anchor_ev;
    img.nr_sampling_scale = nr_sampling_scale;

    // Per-stage application — mirrors `apply_scene_linear_chain` (fp16
    // sibling) verbatim. The order MUST match the Rust reference so
    // `calibrate_color_pipeline` remains the canonical metric. WB frame
    // dispatch (#1781) — see the fp16 sibling.
    stage("ffi_chain_white_balance", || match wb_frame {
        Some(frame) if frame.is_present() => frame.apply_delta_rec2020(
            &mut img,
            (model.temperature, model.tint),
            (decoded_temp, decoded_tint),
        ),
        _ => white_balance::apply_delta(
            &mut img,
            model.temperature,
            model.tint,
            decoded_temp,
            decoded_tint,
            model.wb_method,
        ),
    });
    let sh_mask_anchor = mask_long_edge.unwrap_or_else(|| img.width.max(img.height)) as usize;
    stage("ffi_chain_scene_tone_controls", || {
        scene_tone_controls::apply_with_mask_anchor(&mut img, model, sh_mask_anchor)
    });
    stage("ffi_chain_tone_curves", || {
        tone_curves::apply(&mut img, model)
    });
    stage("ffi_chain_vibrance", || {
        vibrance::apply(&mut img, model.vibrance)
    });
    stage("ffi_chain_saturation", || {
        saturation::apply(&mut img, model.saturation)
    });
    // HSL 8-band (#1112) — same position as the fp16 sibling.
    stage("ffi_chain_hsl", || hsl::apply_model(&mut img, model));
    stage("ffi_chain_clarity", || {
        clarity::apply(&mut img, model.clarity)
    });
    stage("ffi_chain_texture", || {
        texture::apply(&mut img, model.texture)
    });
    stage("ffi_chain_dehaze", || dehaze::apply(&mut img, model.dehaze));
    stage("ffi_chain_defringe", || {
        defringe::apply_model(&mut img, model)
    });
    let scope_weights = stage("ffi_chain_local_adjustments", || {
        if let Some(w) = window {
            local_adjustments::apply_windowed(
                &mut img,
                &model.local_adjustments,
                &model.mask_rasters,
                (w.x as i32, w.y as i32),
                (w.full_width, w.full_height),
            );
            return None;
        }
        local_adjustments::apply_with_scope(
            &mut img,
            &model.local_adjustments,
            &model.mask_rasters,
            scope_layer,
        )
    });
    // Vignette (#1109) — same chain position as develop / the fp16 sibling.
    stage("ffi_chain_vignette", || match window {
        Some(w) => vignette::apply_windowed(
            &mut img,
            model.vignette_amount,
            model.vignette_feather,
            (w.x as i32, w.y as i32),
            (w.full_width, w.full_height),
        ),
        None => vignette::apply(&mut img, model.vignette_amount, model.vignette_feather),
    });
    // Sharpen (#1043) — same chain position as develop (after vignette,
    // before nr_luminance) and as the GPU live chain's `SharpenPass`.
    // `sharpen::apply` short-circuits below |amount| < 1e-3.
    stage("ffi_chain_sharpen", || {
        let radius = sharpen::radius_at_scale(model.sharpen_radius, img.nr_sampling_scale);
        sharpen::apply(
            &mut img,
            model.sharpen_amount,
            radius,
            model.sharpen_detail,
            model.sharpen_masking,
        )
    });
    stage("ffi_chain_nr_luminance", || {
        noise_reduction::apply_luminance(&mut img, model.nr_luminance, noise_profile, iso)
    });
    // Chroma noise reduction (#1043) — develop's `nr_color`, immediately
    // after nr_luminance; identity below |amount| < 1e-3.
    stage("ffi_chain_nr_color", || {
        noise_reduction::apply_color_sampled_cancellable(
            &mut img,
            model.nr_color,
            crate::cancel::CancelToken::never(),
            noise_profile,
            iso,
            nr_sampling_scale,
        )
    });
    if !skip_agx {
        stage("ffi_chain_agx", || {
            agx::apply(&mut img, model.contrast, model.whites)
        });
    } else {
        // Non-RAW retag — see the fp16 sibling for the full rationale. #2478
        img.space = ColorSpace::DisplayLinearRec2020;
    }
    // Display-referred point curves (#2232) — see the fp16 sibling. Runs
    // either way (RAW or non-RAW), gated only on the four curves.
    stage("ffi_chain_display_tone_curve", || {
        display_tone_curve::apply(&mut img, model)
    });
    // Split toning (#1111) + film grain (#1110), gated only on their own
    // sliders for both RAW and non-RAW — see the fp16 sibling. #2478
    stage("ffi_chain_color_grade", || {
        color_grade::apply_model(&mut img, model)
    });
    if let Some(lut) = film_lut {
        stage("ffi_chain_film_look", || {
            crate::stages::film_look::apply(&mut img, lut, model.film_strength)
        });
    }
    stage("ffi_chain_grain", || match window {
        Some(w) => grain::apply_windowed(
            &mut img,
            model.grain_amount,
            model.grain_size,
            model.grain_roughness,
            (w.x, w.y),
            (w.full_width, w.full_height),
        ),
        None => grain::apply(
            &mut img,
            model.grain_amount,
            model.grain_size,
            model.grain_roughness,
        ),
    });
    if !skip_agx {
        // Display-primary conversion (#1337) — see the fp16 sibling for the
        // full rationale. `Srgb` is a no-op; `P3` applies rec2020_to_display.
        if target_primaries != TargetPrimaries::Srgb {
            use crate::view::encode::rec2020_to_display;
            stage("ffi_chain_display_encode", || {
                rec2020_to_display(&mut img, target_primaries)
            });
        }
    }

    // Pack the result back to f32 RGBA.
    let out = stage("ffi_chain_pack_f32", || endcaps::pack_f32(&img.pixels));
    Ok((out, scope_weights))
}
