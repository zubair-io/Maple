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
    apply_scene_linear_chain_f32_inner_cancellable(
        in_f32_rgba,
        width,
        height,
        model,
        opts,
        scope_layer,
        film_lut,
        window,
        crate::CancelToken::never(),
    )
}

pub(super) fn apply_scene_linear_chain_f32_inner_cancellable(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    opts: &ChainOptions<'_>,
    scope_layer: Option<usize>,
    film_lut: Option<&crate::film::FilmLut>,
    window: Option<ChainWindow>,
    cancel: crate::CancelToken<'_>,
) -> Result<(Vec<f32>, Option<Vec<f32>>)> {
    if cancel.is_cancelled() {
        return Err(crate::error::Error::Cancelled);
    }
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
    let mut img = cancellable_stage("ffi_chain_unpack_f32", cancel, || {
        endcaps::unpack_f32(in_f32_rgba, width, height)
    })?;
    img.whites_anchor_ev = whites_anchor_ev;
    img.nr_sampling_scale = nr_sampling_scale;

    // Per-stage application — mirrors `apply_scene_linear_chain` (fp16
    // sibling) verbatim. The order MUST match the Rust reference so
    // `calibrate_color_pipeline` remains the canonical metric. WB frame
    // dispatch (#1781) — see the fp16 sibling.
    cancellable_stage("ffi_chain_white_balance", cancel, || match wb_frame {
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
    })?;
    let sh_mask_anchor = mask_long_edge.unwrap_or_else(|| img.width.max(img.height)) as usize;
    cancellable_stage("ffi_chain_scene_tone_controls", cancel, || {
        scene_tone_controls::apply_with_mask_anchor(&mut img, model, sh_mask_anchor)
    })?;
    cancellable_stage("ffi_chain_tone_curves", cancel, || {
        tone_curves::apply(&mut img, model)
    })?;
    cancellable_stage("ffi_chain_vibrance", cancel, || {
        vibrance::apply(&mut img, model.vibrance)
    })?;
    cancellable_stage("ffi_chain_saturation", cancel, || {
        saturation::apply(&mut img, model.saturation)
    })?;
    // HSL 8-band (#1112) — same position as the fp16 sibling.
    cancellable_stage("ffi_chain_hsl", cancel, || {
        hsl::apply_model(&mut img, model)
    })?;
    cancellable_stage("ffi_chain_clarity", cancel, || {
        clarity::apply(&mut img, model.clarity)
    })?;
    cancellable_stage("ffi_chain_texture", cancel, || {
        texture::apply(&mut img, model.texture)
    })?;
    cancellable_stage("ffi_chain_dehaze", cancel, || {
        dehaze::apply(&mut img, model.dehaze)
    })?;
    cancellable_stage("ffi_chain_defringe", cancel, || {
        defringe::apply_model(&mut img, model)
    })?;
    let scope_weights = cancellable_stage("ffi_chain_local_adjustments", cancel, || {
        if let Some(w) = window {
            local_adjustments::apply_windowed(
                &mut img,
                &model.local_adjustments,
                &model.mask_rasters,
                (w.x as i32, w.y as i32),
                (w.full_width, w.full_height),
                crate::image::ExifOrientation::Normal,
            );
            return None;
        }
        local_adjustments::apply_with_scope(
            &mut img,
            &model.local_adjustments,
            &model.mask_rasters,
            scope_layer,
        )
    })?;
    // Vignette (#1109) — same chain position as develop / the fp16 sibling.
    cancellable_stage("ffi_chain_vignette", cancel, || match window {
        Some(w) => vignette::apply_windowed(
            &mut img,
            model.vignette_amount,
            model.vignette_feather,
            (w.x as i32, w.y as i32),
            (w.full_width, w.full_height),
        ),
        None => vignette::apply(&mut img, model.vignette_amount, model.vignette_feather),
    })?;
    // Sharpen (#1043) — same chain position as develop (after vignette,
    // before nr_luminance) and as the GPU live chain's `SharpenPass`.
    // `sharpen::apply` short-circuits below |amount| < 1e-3.
    cancellable_stage("ffi_chain_sharpen", cancel, || {
        let radius = sharpen::radius_at_scale(model.sharpen_radius, img.nr_sampling_scale);
        sharpen::apply_cancellable(
            &mut img,
            model.sharpen_amount,
            radius,
            model.sharpen_detail,
            model.sharpen_masking,
            cancel,
        )
    })?;
    cancellable_stage("ffi_chain_nr_luminance", cancel, || {
        noise_reduction::apply_luminance_cancellable(
            &mut img,
            model.nr_luminance,
            cancel,
            noise_profile,
            iso,
        )
    })?;
    // Chroma noise reduction (#1043) — develop's `nr_color`, immediately
    // after nr_luminance; identity below |amount| < 1e-3.
    cancellable_stage("ffi_chain_nr_color", cancel, || {
        noise_reduction::apply_color_sampled_cancellable(
            &mut img,
            model.nr_color,
            cancel,
            noise_profile,
            iso,
            nr_sampling_scale,
        )
    })?;
    if !skip_agx {
        cancellable_stage("ffi_chain_agx", cancel, || {
            agx::apply(&mut img, model.contrast, model.whites)
        })?;
    } else {
        // Non-RAW retag — see the fp16 sibling for the full rationale. #2478
        img.space = ColorSpace::DisplayLinearRec2020;
    }
    // Display-referred point curves (#2232) — see the fp16 sibling. Runs
    // either way (RAW or non-RAW), gated only on the four curves.
    cancellable_stage("ffi_chain_display_tone_curve", cancel, || {
        display_tone_curve::apply(&mut img, model)
    })?;
    // Split toning (#1111) + film grain (#1110), gated only on their own
    // sliders for both RAW and non-RAW — see the fp16 sibling. #2478
    cancellable_stage("ffi_chain_color_grade", cancel, || {
        color_grade::apply_model(&mut img, model)
    })?;
    if let Some(lut) = film_lut {
        cancellable_stage("ffi_chain_film_look", cancel, || {
            crate::stages::film_look::apply(&mut img, lut, model.film_strength)
        })?;
    }
    cancellable_stage("ffi_chain_grain", cancel, || match window {
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
    })?;
    if !skip_agx {
        // Display-primary conversion (#1337) — see the fp16 sibling for the
        // full rationale. `Srgb` is a no-op; `P3` applies rec2020_to_display.
        if target_primaries != TargetPrimaries::Srgb {
            use crate::view::encode::rec2020_to_display;
            cancellable_stage("ffi_chain_display_encode", cancel, || {
                rec2020_to_display(&mut img, target_primaries)
            })?;
        }
    }

    // Pack the result back to f32 RGBA.
    let out = cancellable_stage("ffi_chain_pack_f32", cancel, || {
        endcaps::pack_f32(&img.pixels)
    })?;
    Ok((out, scope_weights))
}

/// Discard partially written stages and stop before starting the next one.
fn cancellable_stage<T>(
    name: &'static str,
    cancel: crate::CancelToken<'_>,
    action: impl FnOnce() -> T,
) -> Result<T> {
    if cancel.is_cancelled() {
        return Err(crate::error::Error::Cancelled);
    }
    let result = stage(name, action);
    if cancel.is_cancelled() {
        return Err(crate::error::Error::Cancelled);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "cancellation_tests.rs"]
mod cancellation_tests;
