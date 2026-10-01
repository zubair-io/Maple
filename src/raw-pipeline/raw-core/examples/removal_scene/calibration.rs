//! Actual camera-WB/DCP qualification for the fixed linear plate (#3955).
//! Full-frame develop is intentionally measured here; this is not a live path.

use super::{save_png, Context, ProbeResult};
use raw_core::{
    cancel::CancelToken,
    color::dcp,
    image::Image,
    pipeline::{
        develop_removal_calibration_patches, fit_auto_profile_from_raw, patch_from_bytes, RawInput,
        RenderQuality,
    },
    stages::wb_camera::SliderFrameExport,
    types::accepted_removal::{ContentDigest, NativeWindow},
    view::{agx, encode},
    xmp::{AdjustmentModel, AutoExposureMode, LensProfileEnable, Profile},
    RawImage,
};
use std::{path::Path, time::Instant};

pub(super) fn crop(image: &Image, window: NativeWindow) -> ProbeResult<Image> {
    window.validate(image.width, image.height)?;
    let pixels = (window.y..window.y + window.height)
        .flat_map(|y| {
            let start = (y * image.width + window.x) as usize;
            image.pixels[start..start + window.width as usize]
                .iter()
                .copied()
        })
        .collect();
    Ok(Image {
        width: window.width,
        height: window.height,
        pixels,
        space: image.space,
        whites_anchor_ev: image.whites_anchor_ev,
    })
}

pub(super) struct Bake<'a> {
    pub raw: &'a RawImage,
    pub path: &'a Path,
    pub context: &'a Context,
    pub output: &'a Path,
    pub identity: &'a [u8],
    pub replacement: &'a [u8],
    pub coverage: &'a [f32],
    pub generation_masks: Option<ContentDigest>,
    pub model_result: ContentDigest,
}

fn verify_untouched(
    image: &Image,
    reference: &Image,
    window: NativeWindow,
    coverage: &[f32],
) -> ProbeResult<()> {
    if (image.width, image.height, image.pixels.len())
        != (reference.width, reference.height, reference.pixels.len())
    {
        return Err("calibration develop changed native geometry".into());
    }
    for y in 0..image.height {
        for x in 0..image.width {
            let covered = x >= window.x
                && x < window.x + window.width
                && y >= window.y
                && y < window.y + window.height
                && coverage[((y - window.y) * window.width + x - window.x) as usize] > 0.0;
            let index = (y * image.width + x) as usize;
            if !covered
                && image.pixels[index].map(f32::to_bits)
                    != reference.pixels[index].map(f32::to_bits)
            {
                return Err(
                    "full RAW develop changed a sample outside replacement coverage".into(),
                );
            }
        }
    }
    Ok(())
}

pub(super) fn bake(input: Bake<'_>) -> ProbeResult<()> {
    let identity = patch_from_bytes(input.identity)?;
    let replacement = patch_from_bytes(input.replacement)?;
    let (profile, tier) = dcp::profile_for_with_source(input.raw)?;
    let frame = SliderFrameExport::resolve(input.raw, &profile);
    let anchor = (frame.scene_cct, frame.as_shot_tint);
    let auto = fit_auto_profile_from_raw(
        input.raw,
        &AdjustmentModel::default(),
        RenderQuality::Amaze,
        RawInput::Path(input.path),
    );
    std::fs::create_dir_all(input.output)?;
    std::fs::write(input.output.join("replacement.f16"), input.replacement)?;
    image::GrayImage::from_raw(
        1024,
        1024,
        input
            .coverage
            .iter()
            .map(|v| if *v > 0.0 { 255 } else { 0 })
            .collect(),
    )
    .ok_or("coverage geometry mismatch")?
    .save(input.output.join("coverage.png"))?;
    let mut grades = Vec::new();
    let mut max_error = 0.0_f32;
    for ev in [-3.0, 0.0, 3.0] {
        for shift in [-1000.0, 0.0, 1000.0] {
            let model = AdjustmentModel {
                exposure: ev,
                temperature: (anchor.0 + shift).clamp(2000.0, 50000.0),
                tint: anchor.1,
                temperature_seen: true,
                tint_seen: true,
                auto_exposure: AutoExposureMode::Off,
                lens_profile_enable: LensProfileEnable::Off,
                sharpen_amount: 0.0,
                nr_color: 0.0,
                ..Default::default()
            };
            let started = Instant::now();
            let reference =
                develop_removal_calibration_patches(input.raw, &model, &[], CancelToken::never())?;
            if [reference.width, reference.height]
                != [input.context.source_width, input.context.source_height]
            {
                return Err(
                    "calibration source dimensions differ from the recorded context".into(),
                );
            }
            let restored = develop_removal_calibration_patches(
                input.raw,
                &model,
                std::slice::from_ref(&identity),
                CancelToken::never(),
            )?;
            verify_untouched(&restored, &reference, input.context.window, input.coverage)?;
            let restored = crop(&restored, input.context.window)?;
            let removed = develop_removal_calibration_patches(
                input.raw,
                &model,
                std::slice::from_ref(&replacement),
                CancelToken::never(),
            )?;
            verify_untouched(&removed, &reference, input.context.window, input.coverage)?;
            let removed = crop(&removed, input.context.window)?;
            let reference = crop(&reference, input.context.window)?;
            let error = restored
                .pixels
                .iter()
                .zip(&reference.pixels)
                .flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs()))
                .fold(0.0_f32, f32::max);
            max_error = max_error.max(error);
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            for profile in [Profile::Neutral, Profile::Auto] {
                let display = |scene: &Image| -> ProbeResult<Vec<[f32; 3]>> {
                    let mut image = scene.clone();
                    agx::apply(&mut image, model.contrast, model.whites);
                    encode::rec2020_to_srgb(&mut image);
                    encode::srgb_gamma_encode(&mut image);
                    let mut rgb: Vec<_> = image.pixels.iter().flatten().copied().collect();
                    if profile == Profile::Auto {
                        if let Some((curve, lut)) = &auto {
                            if let Some(curve) = curve {
                                raw_core::view::auto_profile::apply_curve(&mut rgb, curve);
                            }
                            if let Some(lut) = lut {
                                lut.apply_with_strength(
                                    &mut rgb,
                                    raw_core::view::auto_profile::lut::lut_strength_from_env(),
                                );
                            }
                        }
                    }
                    Ok(rgb.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect())
                };
                let name = if profile == Profile::Auto {
                    "auto"
                } else {
                    "neutral"
                };
                let prefix = format!("{name}_ev{ev:+}_wb{shift:+}");
                for (suffix, scene) in [
                    ("truth", &reference),
                    ("identity", &restored),
                    ("removal", &removed),
                ] {
                    save_png(
                        input.output.join(format!("{prefix}-{suffix}.png")),
                        &display(scene)?,
                        1024,
                    )?;
                }
                grades.push(serde_json::json!({"case":prefix,
                    "max_scene_float_error_identity":error,"outside_mask_max_error":0,
                    "three_native_develops_ms":elapsed_ms}));
            }
        }
    }
    std::fs::write(
        input.output.join("report.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "release_qualified":false,"plate":"LinearCalibrationV1",
            "original":input.context.original,"encoding":input.context.encoding,
            "model_result":input.model_result,"native_context":input.context.window,
            "max_scene_float_error_identity":max_error,"outside_mask_max_error":0,
            "as_shot_temperature":anchor.0,"as_shot_tint":anchor.1,"grades":grades,
            "auto_profile_engaged":auto.is_some(),"profile_tier":format!("{tier:?}"),
            "generation_masks":input.generation_masks,
            "qualification":"Full native camera-WB/DCP experiment. Bounded authoring, recipe quality, clone/heal, GPU/live/tile/export integration and supported-device gates remain."
        }))?,
    )?;
    Ok(())
}

/// Explicit whole-frame oracle; never a hidden fallback in bounded authoring.
pub(super) fn compare(path: &Path, x: u32, y: u32, output: &Path) -> ProbeResult<()> {
    let (bytes, raw) = super::decode_raw(path)?;
    let window = NativeWindow {
        x,
        y,
        width: 1024,
        height: 1024,
    };
    let started = Instant::now();
    let bounded =
        raw_core::pipeline::render_removal_calibration_context(&raw, window, CancelToken::never())?;
    let bounded_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let full = raw_core::pipeline::render_removal_calibration_plate(&raw, CancelToken::never())?;
    let full_ms = started.elapsed().as_secs_f64() * 1000.0;
    let reference = crop(&full, window)?;
    let mismatch_channels = bounded
        .pixels
        .iter()
        .zip(&reference.pixels)
        .flat_map(|(a, b)| (0..3).map(move |c| a[c].to_bits() != b[c].to_bits()))
        .filter(|different| *different)
        .count();
    let max_error = bounded
        .pixels
        .iter()
        .zip(&reference.pixels)
        .flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs()))
        .fold(0.0_f32, f32::max);
    let bounded_bytes = super::pack(bounded.pixels.iter().flatten().copied());
    let reference_bytes = super::pack(reference.pixels.iter().flatten().copied());
    std::fs::create_dir_all(output)?;
    std::fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "plate":"LinearCalibrationV1","release_qualified":false,
            "original":ContentDigest::for_bytes(&bytes),"window":window,
            "source_width":full.width,"source_height":full.height,
            "bounded_scene":ContentDigest::for_bytes(&bounded_bytes),
            "whole_scene_crop":ContentDigest::for_bytes(&reference_bytes),
            "mismatch_channels":mismatch_channels,"max_float_error":max_error,
            "bounded_context_ms":bounded_ms,"whole_frame_plate_ms":full_ms,
            "qualification":"Exact native source-grid context oracle. Timing excludes RAW decode; live-slider/model/device qualification is separate."
        }))?,
    )?;
    if mismatch_channels != 0 {
        return Err("bounded calibration plate differs from whole-frame oracle".into());
    }
    Ok(())
}
