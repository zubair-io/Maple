//! Read-only scene-anchor attribution. Preview values are diagnostic only;
//! physical gate claims require the full path and unchanged original inputs.
use raw_core::{
    pipeline::{
        develop_scene_linear_from_raw_with_quality_with_gain,
        develop_scene_linear_sized_from_raw_with_quality_with_gain, RenderQuality,
    },
    xmp::Profile,
};
use std::{error::Error, io::Write, path::Path};

/// Post-develop distribution only: recomposition verifies whether the baseline
/// has remained neutral after the anchor. It is not an alternate render engine.
fn distribution(image: &raw_core::image::Image, gain: f32) -> serde_json::Value {
    let mut luma = image
        .pixels
        .iter()
        .map(|p| 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2])
        .filter(|y| y.is_finite())
        .collect::<Vec<_>>();
    if luma.is_empty() {
        return serde_json::json!({"valid": false});
    }
    luma.sort_unstable_by(f32::total_cmp);
    let n = luma.len();
    let p25 = n / 4;
    let p75 = ((n * 3) / 4).max(p25 + 1).min(n);
    let band = luma[p25..p75]
        .iter()
        .copied()
        .filter(|y| *y > 0.0)
        .collect::<Vec<_>>();
    if band.is_empty() {
        return serde_json::json!({"valid": false});
    }
    let mid = (band.iter().map(|y| (*y as f64).ln()).sum::<f64>() / band.len() as f64).exp() as f32;
    let percentile = |f: f64| luma[((n as f64 * f).floor() as usize).min(n - 1)];
    let p95 = percentile(0.95);
    let global_log_average = (luma
        .iter()
        .map(|y| ((*y as f64 / gain as f64).max(0.0) + 1e-6).ln())
        .sum::<f64>()
        / n as f64)
        .exp();
    let mid_gain = 0.18 * gain / mid;
    let high_gain = 0.85 * gain / p95;
    let recomposed = mid_gain.max(high_gain).min(8.0);
    serde_json::json!({
        "valid": true,
        "global_log_average_before_anchor": global_log_average,
        "global_log_offset": 1e-6,
        "nonpositive_luma_pixels": luma.iter().filter(|y| **y <= 0.0).count(),
        "midgrey_after_anchor": mid,
        "percentiles_after_anchor": {
            "p001": percentile(0.001), "p01": percentile(0.01), "p05": percentile(0.05),
            "p25": percentile(0.25), "p50": percentile(0.50), "p75": percentile(0.75),
            "p95": p95, "p99": percentile(0.99), "p999": percentile(0.999),
        },
        "reconstructed_midtone_gain": mid_gain,
        "reconstructed_highlight_gain": high_gain,
        "reconstructed_anchor_gain": recomposed,
        "reconstruction_relative_error": (recomposed / gain - 1.0).abs(),
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 4 && args.len() != 5 {
        return Err("usage: scene-anchor-probe RAW XMP preview|full [NEW_SCENE_DIRECTORY]".into());
    }
    let output = args.get(4).map(Path::new);
    if let Some(path) = output {
        std::fs::create_dir(path)?;
    }
    let raw = raw_core::decode::decode(Path::new(&args[1]))?;
    let mut model = raw_core::xmp::parse(&std::fs::read_to_string(&args[2])?)?;
    model.profile = Profile::Neutral;
    raw_core::lens_profile::set_auto_match_enabled(false);
    let (scene, gain) = match args[3].as_str() {
        "preview" => develop_scene_linear_sized_from_raw_with_quality_with_gain(
            &raw,
            &model,
            RenderQuality::Preview,
            1024,
        )?,
        "full" => develop_scene_linear_from_raw_with_quality_with_gain(
            &raw,
            &model,
            RenderQuality::Amaze,
        )?,
        _ => return Err("expected preview or full".into()),
    };
    scene.assert_space(raw_core::image::ColorSpace::SceneLinearRec2020);
    if let Some(path) = output {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path.join("scene.f32"))?;
        let mut writer = std::io::BufWriter::new(file);
        for pixel in &scene.pixels {
            for channel in pixel {
                writer.write_all(&channel.to_le_bytes())?;
            }
        }
        writer.flush()?;
    }
    let result = serde_json::json!({
        "camera": raw.camera_model,
        "quality": args[3],
        "dimensions": [scene.width, scene.height],
        "anchor_gain": gain,
        "anchor_ev": gain.log2(),
        "baseline_exposure": raw.baseline_exposure,
        "auto_exposure": format!("{:?}", model.auto_exposure),
        "whites_anchor_ev": scene.whites_anchor_ev,
        "distribution": distribution(&scene, gain),
        "cached_scene_format": "interleaved-rgb-f32-le",
        "cached_scene_space": "SceneLinearRec2020",
    });
    if let Some(path) = output {
        std::fs::write(
            path.join("scene.json"),
            serde_json::to_string_pretty(&result)?,
        )?;
    }
    println!("{result}");
    Ok(())
}
