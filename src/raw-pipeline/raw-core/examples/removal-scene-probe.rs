//! Native scene/model/scene qualification harness (#3941), local files only.
//! No generated asset is committed to an image sidecar by this tool.

use clap::{Parser, Subcommand};
use raw_core::color::dcp;
use raw_core::pipeline::{
    apply_scene_linear_chain_f32, composite_window_into_f32, encode_display_srgb_f32,
    fit_auto_profile_from_raw, patch_from_bytes, patch_to_bytes, render_removal_context,
    ChainOptions, RawInput, RenderQuality,
};
use raw_core::stages::wb_camera::SliderFrameExport;
use raw_core::types::accepted_removal::{ContentDigest, NativeWindow};
use raw_core::types::InpaintPatch;
use raw_core::xmp::{AdjustmentModel, AutoExposureMode, Profile};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[path = "removal_scene/calibration.rs"]
mod calibration;
#[path = "removal_scene/editor_patch.rs"]
mod editor_patch;
#[path = "removal_scene/encoding.rs"]
mod encoding;
#[path = "removal_scene/large.rs"]
mod large;
#[path = "removal_scene/masks.rs"]
mod masks;

type ProbeResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// #3941 research only: assemble one native 2048 context from exact tiles.
    LargeEncode {
        raw: PathBuf,
        inputs: PathBuf,
        intent: PathBuf,
        protected: PathBuf,
        output: PathBuf,
        /// #3941: retain an earlier source-bound context to isolate mask edits.
        #[arg(long)]
        reference_context: Option<PathBuf>,
        /// #3941: isolate reversible photographic contrast on the same native pixels.
        #[arg(long)]
        photographic_contrast: bool,
    },
    /// Validate and bake one joint native 2048 result; never writes XMP.
    LargeBake {
        raw: PathBuf,
        context: PathBuf,
        model_result: PathBuf,
        output: PathBuf,
    },
    Encode {
        raw: PathBuf,
        x: u32,
        y: u32,
        output: PathBuf,
        /// Compare the fixed AgX/sRGB photographic input against signed-log.
        /// Its approximate inverse is measured; it is not assumed lossless.
        #[arg(long)]
        fixed_sdr: bool,
        /// #3941: reversible black-anchored contrast research, not admission.
        #[arg(long, conflicts_with = "fixed_sdr")]
        photographic_contrast: bool,
        /// Qualify the bounded pre-WB linear calibration context (#3955).
        #[arg(long)]
        linear_calibration: bool,
    },
    /// Compare bounded and whole-frame pre-WB plates exactly (#3955).
    CalibrationParity {
        raw: PathBuf,
        x: u32,
        y: u32,
        output: PathBuf,
    },
    /// Isolate context float drift through the same fixed SDR encoding.
    ContextDisplayParity {
        native: PathBuf,
        browser: PathBuf,
        output: PathBuf,
    },
    Bake {
        raw: PathBuf,
        context: PathBuf,
        /// Native float32 NCHW model result, no quantization or resizing.
        model_result: PathBuf,
        output: PathBuf,
    },
    /// #3941: develop the actual editor-produced patch after byte revalidation.
    BakeEditorPatch {
        raw: PathBuf,
        context: PathBuf,
        reconstruction: PathBuf,
        output: PathBuf,
    },
    Masks {
        context: PathBuf,
        intent: PathBuf,
        #[arg(long)]
        protected: Option<PathBuf>,
        #[arg(long)]
        hole_radius: u32,
        #[arg(long)]
        fringe_radius: f32,
    },
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
enum ProbePlate {
    #[default]
    PostDcpV1,
    LinearCalibrationV1,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Context {
    #[serde(default)]
    plate: ProbePlate,
    original: ContentDigest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_anchor: Option<raw_core::types::accepted_removal::SourceAnchor>,
    window: NativeWindow,
    source_width: u32,
    source_height: u32,
    scene: ContentDigest,
    model_input: ContentDigest,
    encoding: encoding::ProbeEncoding,
    release_qualified: bool,
}

fn decode_raw(path: &Path) -> ProbeResult<(Vec<u8>, raw_core::RawImage)> {
    let bytes = std::fs::read(path)?;
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or("RAW extension missing")?;
    let raw = raw_core::decode_raw(&bytes, &ext.to_lowercase())?;
    Ok((bytes, raw))
}

fn pack(values: impl Iterator<Item = f32>) -> Vec<u8> {
    values.flat_map(f32::to_le_bytes).collect()
}

fn read_rgb(bytes: &[u8], side: u32, planar: bool) -> ProbeResult<Vec<[f32; 3]>> {
    let count = (side * side) as usize;
    if bytes.len() != count * 3 * 4 {
        return Err("float RGB byte length differs from native geometry".into());
    }
    let values: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|value| f32::from_le_bytes(value.try_into().unwrap()))
        .collect();
    if !values.iter().all(|value| value.is_finite()) {
        return Err("float RGB contains non-finite samples".into());
    }
    Ok((0..count)
        .map(|i| std::array::from_fn(|c| values[if planar { c * count + i } else { i * 3 + c }]))
        .collect())
}

fn encode(
    path: &Path,
    x: u32,
    y: u32,
    output: &Path,
    fixed_sdr: bool,
    photographic_contrast: bool,
    linear_calibration: bool,
) -> ProbeResult<()> {
    let (bytes, raw) = decode_raw(path)?;
    let window = NativeWindow {
        x,
        y,
        width: 1024,
        height: 1024,
    };
    let scene = if linear_calibration {
        raw_core::pipeline::render_removal_calibration_context(
            &raw,
            window,
            raw_core::cancel::CancelToken::never(),
        )?
    } else {
        render_removal_context(&raw, window)?
    };
    let encoding = encoding::ProbeEncoding::fit(&scene.pixels, fixed_sdr, photographic_contrast)?;
    let model = encoding.encode(&scene.pixels)?;
    let scene_bytes = pack(scene.pixels.iter().flatten().copied());
    let model_bytes = pack((0..3).flat_map(|c| model.iter().map(move |p| p[c])));
    let (w, h) = raw_core::pipeline::native_render_dims(&raw);
    let (source_width, source_height) = if raw.orientation.swaps_wh() {
        (h, w)
    } else {
        (w, h)
    };
    let context = Context {
        plate: if linear_calibration {
            ProbePlate::LinearCalibrationV1
        } else {
            ProbePlate::PostDcpV1
        },
        original: ContentDigest::for_bytes(&bytes),
        source_anchor: if linear_calibration {
            Some(raw_core::pipeline::removal_calibration_source_anchor(
                &raw,
                &ContentDigest::for_bytes(&bytes),
            )?)
        } else {
            None
        },
        window,
        source_width,
        source_height,
        scene: ContentDigest::for_bytes(&scene_bytes),
        model_input: ContentDigest::for_bytes(&model_bytes),
        encoding,
        release_qualified: false,
    };
    std::fs::create_dir_all(output)?;
    std::fs::write(output.join("scene.f32"), &scene_bytes)?;
    std::fs::write(output.join("input.f32"), &model_bytes)?;
    save_png(output.join("input.png"), &model, 1024)?;
    std::fs::write(
        output.join("context.json"),
        serde_json::to_vec_pretty(&context)?,
    )?;
    Ok(())
}

fn save_png(path: PathBuf, pixels: &[[f32; 3]], side: u32) -> ProbeResult<()> {
    let bytes = pixels
        .iter()
        .flatten()
        .map(|value| (value * 255.0).round().clamp(0.0, 255.0) as u8)
        .collect();
    image::RgbImage::from_raw(side, side, bytes)
        .ok_or("PNG geometry mismatch")?
        .save(path)?;
    Ok(())
}

fn rgba(pixels: &[[f32; 3]]) -> Vec<f32> {
    pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect()
}

fn bake(path: &Path, directory: &Path, model_result: &Path, output: &Path) -> ProbeResult<()> {
    let (bytes, raw) = decode_raw(path)?;
    let context: Context = serde_json::from_slice(&std::fs::read(directory.join("context.json"))?)?;
    context.original.verify(&bytes)?;
    if context.window.width != 1024 || context.window.height != 1024 || context.release_qualified {
        return Err("unexpected experimental context geometry or qualification".into());
    }
    let scene_bytes = std::fs::read(directory.join("scene.f32"))?;
    context.scene.verify(&scene_bytes)?;
    let input_bytes = std::fs::read(directory.join("input.f32"))?;
    context.model_input.verify(&input_bytes)?;
    let scene = read_rgb(&scene_bytes, 1024, false)?;
    let identity = context
        .encoding
        .decode(&read_rgb(&input_bytes, 1024, true)?)?;
    let result_bytes = std::fs::read(model_result)?;
    let replacement = context
        .encoding
        .decode(&read_rgb(&result_bytes, 1024, true)?)?;
    let region = context
        .window
        .region(context.source_width, context.source_height);
    let (coverage, generation_masks) = masks::coverage(
        directory,
        context.window,
        [context.source_width, context.source_height],
    )?;
    let patch_for = |pixels| InpaintPatch {
        width: 1024,
        height: 1024,
        origin: [region[0], region[1]],
        extent: [region[2], region[3]],
        pixels,
        coverage: coverage.clone(),
    };
    // Exercise the real durable fp16 codec and source-window composition.
    let identity_bytes = patch_to_bytes(&patch_for(identity.clone()))?;
    let replacement_bytes = patch_to_bytes(&patch_for(replacement))?;
    if context.plate == ProbePlate::LinearCalibrationV1 {
        return calibration::bake(calibration::Bake {
            raw: &raw,
            path,
            context: &context,
            output,
            identity: &identity_bytes,
            replacement: &replacement_bytes,
            coverage: &coverage,
            generation_masks,
            model_result: ContentDigest::for_bytes(&result_bytes),
        });
    }
    let base = rgba(&scene);
    let identity_plate = composite_window_into_f32(
        &base,
        1024,
        1024,
        &[patch_from_bytes(&identity_bytes)?],
        region,
    )?;
    let replacement_plate = composite_window_into_f32(
        &base,
        1024,
        1024,
        &[patch_from_bytes(&replacement_bytes)?],
        region,
    )?;
    for (i, intent) in coverage.iter().enumerate() {
        let changed = (0..4).any(|c| {
            identity_plate[i * 4 + c].to_bits() != base[i * 4 + c].to_bits()
                || replacement_plate[i * 4 + c].to_bits() != base[i * 4 + c].to_bits()
        });
        if *intent == 0.0 && changed {
            return Err("composition modified a pixel outside the removal mask".into());
        }
    }
    let (profile, tier) = dcp::profile_for_with_source(&raw)?;
    if matches!(tier, dcp::ProfileSource::RawlerFallback) {
        return Err("WB qualification requires the actual camera calibration frame".into());
    }
    let frame = SliderFrameExport::resolve(&raw, &profile);
    let anchor = (frame.scene_cct, frame.as_shot_tint);
    let options = ChainOptions {
        decoded_temp: anchor.0,
        decoded_tint: anchor.1,
        wb_frame: Some(&frame),
        mask_long_edge: Some(context.source_width.max(context.source_height)),
        ..Default::default()
    };
    std::fs::create_dir_all(output)?;
    let roi: Vec<u8> = coverage
        .iter()
        .map(|v| if *v > 0.0 { 255 } else { 0 })
        .collect();
    image::GrayImage::from_raw(1024, 1024, roi)
        .ok_or("coverage geometry mismatch")?
        .save(output.join("coverage.png"))?;
    std::fs::write(output.join("replacement.f16"), replacement_bytes)?;
    // The same RAW-pinned Auto artifacts used by production. They never
    // learn from a generated crop or a current creative grade.
    let auto = fit_auto_profile_from_raw(
        &raw,
        &AdjustmentModel::default(),
        RenderQuality::Amaze,
        RawInput::Path(path),
    );
    let mut grades = Vec::new();
    for profile in [Profile::Neutral, Profile::Auto] {
        for ev in [-3.0, 0.0, 3.0] {
            for shift in [-1000.0, 0.0, 1000.0] {
                let model = AdjustmentModel {
                    exposure: ev,
                    temperature: (anchor.0 + shift).clamp(2000.0, 50000.0),
                    tint: anchor.1,
                    temperature_seen: true,
                    tint_seen: true,
                    auto_exposure: AutoExposureMode::Off,
                    sharpen_amount: 0.0,
                    nr_color: 0.0,
                    profile,
                    ..Default::default()
                };
                let render = |plate: &[f32]| -> ProbeResult<Vec<[f32; 3]>> {
                    let display =
                        apply_scene_linear_chain_f32(plate, 1024, 1024, &model, &options)?;
                    let encoded = encode_display_srgb_f32(&display, 1024, 1024)?;
                    let mut rgb: Vec<f32> = encoded
                        .chunks_exact(4)
                        .flat_map(|p| [p[0], p[1], p[2]])
                        .collect();
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
                let truth = render(&base)?;
                let restored = render(&identity_plate)?;
                let removed = render(&replacement_plate)?;
                let profile_name = if profile == Profile::Auto {
                    "auto"
                } else {
                    "neutral"
                };
                let prefix = format!("{profile_name}_ev{ev:+}_wb{shift:+}");
                save_png(output.join(format!("{prefix}-truth.png")), &truth, 1024)?;
                save_png(
                    output.join(format!("{prefix}-identity.png")),
                    &restored,
                    1024,
                )?;
                save_png(output.join(format!("{prefix}-removal.png")), &removed, 1024)?;
                let max_error = truth
                    .iter()
                    .flatten()
                    .zip(restored.iter().flatten())
                    .map(|(a, b)| (a - b).abs())
                    .fold(0.0_f32, f32::max);
                grades.push(serde_json::json!({"profile":profile_name,"ev":ev,"temperature":model.temperature,"max_display_float_error_identity":max_error}));
            }
        }
    }
    let max_scene_error = identity
        .iter()
        .flatten()
        .zip(scene.iter().flatten())
        .map(|(a, b)| (a - b).abs())
        .fold(0.0_f32, f32::max);
    std::fs::write(
        output.join("report.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "release_qualified":false,"original":context.original,"encoding":context.encoding,
            "model_result":ContentDigest::for_bytes(&result_bytes),"native_context":context.window,
            "max_scene_float_error_identity":max_scene_error,"outside_mask_max_error":0,
        "as_shot_temperature":anchor.0,"as_shot_tint":anchor.1,"grades":grades,
        "auto_profile_engaged":auto.is_some(),
            "generation_masks":generation_masks,
            "qualification":"Native spatial and colour probe; photographic removal quality, seam refinement and supported-device gates remain"
        }))?,
    )?;
    Ok(())
}

fn main() -> ProbeResult<()> {
    match Args::parse().command {
        Command::LargeEncode {
            raw,
            inputs,
            intent,
            protected,
            output,
            reference_context,
            photographic_contrast,
        } => large::encode(
            &raw,
            &inputs,
            &intent,
            &protected,
            &output,
            reference_context.as_deref(),
            photographic_contrast,
        ),
        Command::LargeBake {
            raw,
            context,
            model_result,
            output,
        } => large::bake(&raw, &context, &model_result, &output),
        Command::Encode {
            raw,
            x,
            y,
            output,
            fixed_sdr,
            photographic_contrast,
            linear_calibration,
        } => encode(
            &raw,
            x,
            y,
            &output,
            fixed_sdr,
            photographic_contrast,
            linear_calibration,
        ),
        Command::CalibrationParity { raw, x, y, output } => {
            calibration::compare(&raw, x, y, &output)
        }
        Command::ContextDisplayParity {
            native,
            browser,
            output,
        } => calibration::compare_display(&native, &browser, &output),
        Command::Bake {
            raw,
            context,
            model_result,
            output,
        } => bake(&raw, &context, &model_result, &output),
        Command::BakeEditorPatch {
            raw,
            context,
            reconstruction,
            output,
        } => editor_patch::bake(&raw, &context, &reconstruction, &output),
        Command::Masks {
            context,
            intent,
            protected,
            hole_radius,
            fringe_radius,
        } => {
            let recipe: Context =
                serde_json::from_slice(&std::fs::read(context.join("context.json"))?)?;
            masks::write(
                &context,
                &intent,
                protected.as_deref(),
                raw_core::stages::removal_generation::GenerationMaskRequest {
                    schema: 1,
                    window: recipe.window,
                    hole_radius,
                    fringe_radius,
                },
                [recipe.source_width, recipe.source_height],
            )
        }
    }
}
