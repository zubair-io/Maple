//! #1472 photographic export attribution, not a product fit-policy change.
//! Writes proxy/native Auto cubes for the same RAW and AMaZE quality.
//! Usage: removal-auto-fit-attribution ORIGINAL_RAW NEW_OUTPUT_DIRECTORY
use raw_core::pipeline::{fit_auto_profile_from_raw_at_cap, FitCap, RawInput, RenderQuality};
use raw_core::types::adjustment::Profile;
use raw_core::view::auto_profile::{bake_auto_profile_lut, bake_profile_lut};
use raw_core::xmp::AdjustmentModel;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("Expected ORIGINAL_RAW NEW_OUTPUT_DIRECTORY".into());
    }
    let source = PathBuf::from(&args[0]);
    let output = PathBuf::from(&args[1]);
    if output.exists() {
        return Err("Output directory already exists; refusing to overwrite".into());
    }
    let bytes = std::fs::read(&source)?;
    let digest = blake3::hash(&bytes).to_hex().to_string();
    let ext = source.extension().and_then(|s| s.to_str()).unwrap_or("");
    let raw = raw_core::decode::decode_bytes(&bytes, ext)?;
    let model = AdjustmentModel {
        profile: Profile::Auto,
        ..AdjustmentModel::default()
    };
    std::fs::create_dir(&output)?;
    let mut cubes = Vec::new();
    let mut artifacts = Vec::new();
    for (cap, label) in [(FitCap::Proxy, "proxy"), (FitCap::Native, "native")] {
        let (curve, residual) = fit_auto_profile_from_raw_at_cap(
            &raw,
            &model,
            RenderQuality::Amaze,
            RawInput::Path(&source),
            cap,
        )
        .ok_or("No Auto fit available for this photographic RAW")?;
        let curve = curve.ok_or("Photographic control requires an actual fitted curve")?;
        for (kind, lanes, edge) in [
            ("curve", curve.to_flat(), 0),
            (
                "residual",
                residual.as_ref().map_or_else(Vec::new, |r| r.data.clone()),
                residual.as_ref().map_or(0, |r| r.size),
            ),
        ] {
            let data: Vec<_> = lanes.iter().flat_map(|v| v.to_le_bytes()).collect();
            let name = format!("{label}-{kind}.f32");
            std::fs::write(output.join(&name), &data)?;
            artifacts.push(serde_json::json!({
                "path": name, "fit": label, "kind": kind, "edge": edge,
                "bytes": data.len(), "blake3": blake3::hash(&data).to_hex().to_string()
            }));
        }
        for dimension in [33, 49, 65] {
            let lut = match &residual {
                Some(residual) => bake_auto_profile_lut(&curve, residual, dimension),
                None => bake_profile_lut(&curve, dimension),
            };
            let data: Vec<_> = lut.iter().flat_map(|v| v.to_le_bytes()).collect();
            let name = format!("{label}-{dimension}.f32");
            std::fs::write(output.join(&name), &data)?;
            cubes.push(serde_json::json!({
                "path": name, "fit": label, "dimension": dimension,
                "bytes": data.len(), "blake3": blake3::hash(&data).to_hex().to_string()
            }));
        }
    }
    if blake3::hash(&std::fs::read(&source)?).to_hex().as_str() != digest {
        return Err("Original RAW changed during diagnostic".into());
    }
    let report = serde_json::json!({
        "issue": 1472, "sourceDigest": digest,
        "sensorWidth": raw.width, "sensorHeight": raw.height,
        "quality": "amaze", "encoding": "little-endian f32 RGB, red fastest",
        "limit": "Native fit is an uncached diagnostic control; production policy unchanged",
        "cubes": cubes, "artifacts": artifacts
    });
    std::fs::write(
        output.join("manifest.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
