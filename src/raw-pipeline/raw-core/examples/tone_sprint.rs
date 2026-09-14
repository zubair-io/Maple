//! Reproducible production-render measurements for #3601.
//! Usage: tone_sprint MANIFEST OUTPUT FIXTURE [LONG_EDGE]
//! ACR files are never inputs to the renderer; they are comparison targets only.
use raw_core::types::adjustment::{AutoExposureMode, Profile};
use raw_core::{decode, pipeline, png, xmp};
use std::{fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(&args[1])?)?;
    let out = Path::new(&args[2]);
    let fixture = &args[3];
    let edge: u32 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(1024);
    let case = manifest["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"].as_str() == Some(&format!("{fixture}/baseline")))
        .unwrap();
    let path = Path::new(case["raw"].as_str().unwrap());
    let raw = decode::decode(path)?;
    let baseline = xmp::parse(&fs::read_to_string(case["xmp"].as_str().unwrap())?)?;
    fs::create_dir_all(out)?;
    let quality = pipeline::RenderQuality::Full;
    for (profile_name, profile) in [("neutral", Profile::Neutral), ("auto", Profile::Auto)] {
        for (name, whites, exposure) in [
            ("baseline", 0.0, 0.0),
            ("whites_p25", 25.0, 0.0),
            ("whites_p50", 50.0, 0.0),
            ("whites_max", 100.0, 0.0),
            ("whites_m50", -50.0, 0.0),
            ("whites_min", -100.0, 0.0),
            ("exposure_p1", 0.0, 1.0),
            ("exposure_m1", 0.0, -1.0),
        ] {
            let model = xmp::AdjustmentModel {
                profile,
                whites,
                exposure,
                ..baseline.clone()
            };
            let (w, h, rgb) = pipeline::render_sized_from_raw_with_quality_and_source(
                &raw,
                &model,
                quality,
                Some(pipeline::RawInput::Path(path)),
                edge,
            )?;
            fs::write(
                out.join(format!("{fixture}_{profile_name}_{name}.png")),
                png::encode(w, h, &rgb)?,
            )?;
            println!("{fixture}/{profile_name}/{name}: {w}x{h}");
        }
    }
    // Production develop output, both AE modes. Never combine a hand-built
    // decode's percentiles with a gain measured from a different buffer.
    for (name, mode) in [("off", AutoExposureMode::Off), ("on", AutoExposureMode::On)] {
        let model = xmp::AdjustmentModel {
            auto_exposure: mode,
            ..baseline.clone()
        };
        let (scene, gain) = pipeline::develop_scene_linear_sized_from_raw_with_quality_with_gain(
            &raw, &model, quality, edge,
        )?;
        let mut ys: Vec<f32> = scene
            .pixels
            .iter()
            .map(|p| 0.2627 * p[0] + 0.6780 * p[1] + 0.0593 * p[2])
            .filter(|y| y.is_finite())
            .collect();
        ys.sort_unstable_by(f32::total_cmp);
        let percentiles: Vec<_> = [0.9, 0.95, 0.98, 0.99, 0.995, 0.999]
            .iter()
            .map(|p| {
                let i = (p * (ys.len() - 1) as f64).round() as usize;
                (ys[i].max(1e-8) / 0.18).log2()
            })
            .collect();
        let stats = serde_json::json!({"ae_mode":name,"gain":gain,"whites_anchor_ev":scene.whites_anchor_ev,"percentiles_ev":percentiles,
            "width":scene.width,"height":scene.height,"stage":"production develop output"});
        fs::write(
            out.join(format!("{fixture}_scene_ae_{name}.json")),
            serde_json::to_vec_pretty(&stats)?,
        )?;
    }
    Ok(())
}
