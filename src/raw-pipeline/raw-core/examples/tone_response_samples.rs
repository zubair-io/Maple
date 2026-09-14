//! Diagnostic response lookup from the production scene and display tail (#3601).
//! Usage: tone_response_samples MANIFEST OUTPUT FIXTURE [LONG_EDGE=512]
//! RGB payload: little-endian f32, [sample][delta][channel], encoded sRGB.
use raw_core::{
    decode,
    image::{apply_orientation, ColorSpace, ExifOrientation, Image},
    pipeline::{self, RawInput, RenderQuality},
    png,
    stages::{color_grade, display_tone_curve, grain, perspective::Perspective},
    types::adjustment::{AutoExposureMode, Profile},
    view::{agx, auto_profile, encode},
    xmp,
};
use serde_json::{json, Value};
use std::{error::Error, fs, path::Path};

type Artifacts = (
    Option<auto_profile::ProfileCurve>,
    Option<auto_profile::lut::ColorLut>,
);

fn display_tail(image: &mut Image, model: &xmp::AdjustmentModel, artifacts: &Artifacts) {
    agx::apply(image, model.contrast, model.whites);
    display_tone_curve::apply(image, model);
    color_grade::apply_model(image, model);
    grain::apply(
        image,
        model.grain_amount,
        model.grain_size,
        model.grain_roughness,
    );
    encode::rec2020_to_srgb(image);
    encode::srgb_gamma_encode(image);
    if model.profile == Profile::Auto {
        auto_profile::apply_auto_profile(
            bytemuck::cast_slice_mut(&mut image.pixels),
            image.width as usize,
            image.height as usize,
            ExifOrientation::Normal,
            None,
            None,
            artifacts.0.clone(),
            artifacts.1.clone(),
        );
        encode::gamut_guard_display_encoded_srgb(image);
    }
}

fn normalized_max(rgb: [f32; 3]) -> f32 {
    let inset =
        agx::AGX_INSET_MATRIX.map(|row| row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);
    let maximum = inset.into_iter().fold(f32::NEG_INFINITY, f32::max);
    let floor = agx::AGX_MID_GRAY * agx::AGX_MIN_EV.exp2();
    let ev = (maximum.max(floor) / agx::AGX_MID_GRAY)
        .log2()
        .clamp(agx::AGX_MIN_EV, agx::AGX_MAX_EV);
    (ev - agx::AGX_MIN_EV) / (agx::AGX_MAX_EV - agx::AGX_MIN_EV)
}

fn capture(
    path: &Path,
    raw: &raw_core::image::RawImage,
    model: &xmp::AdjustmentModel,
    out: &Path,
    fixture: &str,
    profile_name: &str,
    edge: u32,
) -> Result<(), Box<dyn Error>> {
    let quality = RenderQuality::Full;
    let (width, height, baseline) = pipeline::render_sized_from_raw_with_quality_and_source(
        raw,
        model,
        quality,
        Some(RawInput::Path(path)),
        edge,
    )?;
    let auto_enabled =
        model.profile == Profile::Auto && std::env::var_os("MAPLE_DISABLE_AUTO_PROFILE").is_none();
    let key = auto_profile::cache::CacheKey::from_path(path, quality)
        .ok_or("RAW cache identity unavailable")?
        .with_origin(auto_profile::cache::FitOrigin::Render(
            (edge < raw.width.max(raw.height)).then_some(edge),
        ));
    let artifacts = if auto_enabled {
        (
            auto_profile::cache::get(&key),
            auto_profile::cache::get_lut(&key),
        )
    } else {
        (None, None)
    };
    let auto_will_fit = auto_enabled
        && (artifacts.0.is_some()
            || artifacts.1.is_some()
            || auto_profile::preview::extract_for_fit(path).is_some());
    let active_model = xmp::AdjustmentModel {
        auto_exposure: if auto_will_fit {
            AutoExposureMode::Off
        } else {
            model.auto_exposure
        },
        ..model.clone()
    };
    let (scene, ae_gain) = pipeline::develop_scene_linear_sized_from_raw_with_quality_with_gain(
        raw,
        &active_model,
        quality,
        edge,
    )?;
    let mut reconstructed = scene.clone();
    display_tail(&mut reconstructed, model, &artifacts);
    let quantized = encode::dither_and_quantize(&mut reconstructed);
    let (rw, rh, reconstructed_rgb) =
        apply_orientation(&quantized, scene.width, scene.height, raw.orientation);
    if (rw, rh) != (width, height) || reconstructed_rgb.len() != baseline.len() {
        return Err("production output geometry differs from reconstruction".into());
    }
    let errors: Vec<u8> = baseline
        .iter()
        .zip(&reconstructed_rgb)
        .map(|(a, b)| a.abs_diff(*b))
        .collect();
    let max_error = *errors.iter().max().ok_or("empty image")?;
    let nonzero_errors = errors.iter().filter(|&&v| v != 0).count();
    if max_error > 1 {
        return Err(format!(
            "{fixture}/{profile_name}: tail mismatch max={max_error}, nonzero={nonzero_errors}"
        )
        .into());
    }
    // Permute source indices with the production orientation function. Sampling
    // happens in output coordinates; dither stays in its original sensor frame.
    let ids: Vec<u32> = (0..scene.pixels.len() as u32)
        .flat_map(|i| [i; 3])
        .collect();
    let (_, _, oriented_ids) = apply_orientation(&ids, scene.width, scene.height, raw.orientation);
    let count = scene.pixels.len().min(4096);
    let deltas: Vec<f32> = (-20..=40).map(|i| i as f32 / 100.0).collect();
    let mut response = Image::new(
        (count * deltas.len()) as u32,
        1,
        ColorSpace::SceneLinearRec2020,
    );
    let samples: Vec<Value> = (0..count).map(|sample| {
        let index = (2 * sample + 1) * scene.pixels.len() / (2 * count);
        let source_index = oriented_ids[index * 3] as usize;
        let rgb = scene.pixels[source_index];
        for (d, delta) in deltas.iter().enumerate() {
            let gain = (delta * (agx::AGX_MAX_EV - agx::AGX_MIN_EV)).exp2();
            response.pixels[sample * deltas.len() + d] = rgb.map(|v| v * gain);
        }
        json!({"index":index,"source_index":source_index,"scene_rgb":rgb,"norm_max":normalized_max(rgb)})
    }).collect();
    display_tail(&mut response, model, &artifacts);
    let mut sample_zero_max_error = 0.0_f32;
    for (i, sample) in samples.iter().enumerate() {
        let source_index = sample["source_index"].as_u64().unwrap() as usize;
        for c in 0..3 {
            sample_zero_max_error = sample_zero_max_error.max(
                (response.pixels[i * deltas.len() + 20][c] - reconstructed.pixels[source_index][c])
                    .abs(),
            );
        }
    }
    if sample_zero_max_error > 1e-6 {
        return Err(format!("sample tail differs at shift zero: {sample_zero_max_error}").into());
    }
    let mut replay_checks = Vec::new();
    for whites in [-100.0_f32, 100.0] {
        let mut direct = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
        direct.whites_anchor_ev = scene.whites_anchor_ev;
        for (i, sample) in samples.iter().enumerate() {
            direct.pixels[i] = scene.pixels[sample["source_index"].as_u64().unwrap() as usize];
        }
        let resolved = if whites > 0.0 {
            raw_core::view::whites_anchor::resolve(
                whites,
                scene.whites_anchor_ev.ok_or("missing full-frame anchor")?,
            )
        } else {
            whites
        };
        let check_model = xmp::AdjustmentModel {
            whites,
            ..model.clone()
        };
        display_tail(&mut direct, &check_model, &artifacts);
        let mut max_error = 0.0_f32;
        let mut sum_error = 0.0_f64;
        let mut outside_grid = 0usize;
        for (i, sample) in samples.iter().enumerate() {
            let norm = sample["norm_max"].as_f64().unwrap() as f32;
            let delta = raw_core::view::agx_whites::remap_norm(norm, resolved) - norm;
            if delta < deltas[0] || delta > deltas[deltas.len() - 1] {
                outside_grid += 1;
            }
            let position = ((delta - deltas[0]) * 100.0).clamp(0.0, (deltas.len() - 1) as f32);
            let lo = position.floor() as usize;
            let hi = (lo + 1).min(deltas.len() - 1);
            let fraction = position - lo as f32;
            for c in 0..3 {
                let a = response.pixels[i * deltas.len() + lo][c];
                let b = response.pixels[i * deltas.len() + hi][c];
                let error = (a + (b - a) * fraction - direct.pixels[i][c]).abs();
                max_error = max_error.max(error);
                sum_error += error as f64;
            }
        }
        replay_checks.push(json!({"whites":whites,"resolved_whites":resolved,
            "max_encoded_rgb_error":max_error,"mean_encoded_rgb_error":sum_error/(count*3) as f64,
            "outside_grid_samples":outside_grid}));
    }
    let stem = format!("{fixture}_{profile_name}_response");
    let payload: Vec<u8> = response
        .pixels
        .iter()
        .flatten()
        .flat_map(|v| v.to_le_bytes())
        .collect();
    fs::write(out.join(format!("{stem}.f32")), payload)?;
    fs::write(
        out.join(format!("{fixture}_{profile_name}_baseline.png")),
        png::encode(width, height, &baseline)?,
    )?;
    fs::write(
        out.join(format!("{fixture}_{profile_name}_reconstructed.png")),
        png::encode(width, height, &reconstructed_rgb)?,
    )?;
    let metadata = json!({
        "schema_version":1,"fixture":fixture,"profile":profile_name,
        "width":width,"height":height,"source_width":scene.width,"source_height":scene.height,
        "anchor_ev":scene.whites_anchor_ev,"ae_gain":ae_gain,"auto_will_fit":auto_will_fit,
        "auto_curve":artifacts.0.is_some(),"auto_lut":artifacts.1.is_some(),
        "auto1":auto_profile::apply_pipeline::auto1_enabled_by_env(),
        "agx_min_ev":agx::AGX_MIN_EV,"agx_max_ev":agx::AGX_MAX_EV,
        "deltas":deltas,"samples":samples,"payload":format!("{stem}.f32"),
        "layout":"sample,delta,RGB; little-endian f32; encoded sRGB",
        "reconstruction_max_u8_error":max_error,"reconstruction_nonzero_channels":nonzero_errors,
        "sample_zero_max_f32_error":sample_zero_max_error,"current_remap_replay":replay_checks
    });
    fs::write(
        out.join(format!("{stem}.json")),
        serde_json::to_vec(&metadata)?,
    )?;
    println!("{fixture}/{profile_name}: {width}x{height}, {count} samples, max u8 error {max_error}, sample zero error {sample_zero_max_error}");
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        return Err("usage: tone_response_samples MANIFEST OUTPUT FIXTURE [LONG_EDGE]".into());
    }
    let manifest: Value = serde_json::from_slice(&fs::read(&args[1])?)?;
    let out = Path::new(&args[2]);
    let fixture = &args[3];
    let edge: u32 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(512);
    if edge == 0 {
        return Err("LONG_EDGE must be positive".into());
    }
    let case = manifest["cases"]
        .as_array()
        .ok_or("manifest cases missing")?
        .iter()
        .find(|c| c["name"].as_str() == Some(&format!("{fixture}/baseline")))
        .ok_or("baseline case missing")?;
    let path = Path::new(case["raw"].as_str().ok_or("RAW path missing")?);
    let baseline = xmp::parse(&fs::read_to_string(
        case["xmp"].as_str().ok_or("XMP path missing")?,
    )?)?;
    if !baseline.crop.is_identity()
        || !Perspective::from_model(&baseline).is_identity()
        || baseline.grain_amount != 0.0
    {
        return Err(
            "diagnostic requires baseline identity geometry and zero grain for point sampling"
                .into(),
        );
    }
    let raw = decode::decode(path)?;
    fs::create_dir_all(out)?;
    for (name, profile) in [("neutral", Profile::Neutral), ("auto", Profile::Auto)] {
        let model = xmp::AdjustmentModel {
            profile,
            whites: 0.0,
            exposure: 0.0,
            ..baseline.clone()
        };
        capture(path, &raw, &model, out, fixture, name, edge)?;
    }
    Ok(())
}
