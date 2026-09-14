//! Reproducible production-render measurements for #3601.
//! Usage: tone_exposure_isolation MANIFEST OUTPUT FIXTURE [LONG_EDGE]
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
    for (name, exposure) in [
        ("baseline", 0.0),
        ("exposure_p1", 1.0),
        ("exposure_m1", -1.0),
    ] {
        let model = xmp::AdjustmentModel {
            profile: Profile::Neutral,
            auto_exposure: AutoExposureMode::Off,
            whites: 0.0,
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
            out.join(format!("{fixture}_neutral_off_{name}.png")),
            png::encode(w, h, &rgb)?,
        )?;
        println!("{fixture}/neutral_off/{name}: {w}x{h}");
    }
    Ok(())
}
