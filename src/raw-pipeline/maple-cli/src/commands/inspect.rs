//! `maple-cli inspect` — debug helper. Prints either the parsed
//! `AdjustmentModel` for a `.xmp` sidecar or the decoded RAW metadata
//! (dimensions, CFA, levels, camera identity, color matrices) for any
//! supported RAW.

use raw_core::xmp;
use std::path::Path;

pub fn run(path: &Path) -> Result<i32, Box<dyn std::error::Error>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "lcp" {
        use std::io::Read;
        let mut xml = String::new();
        std::fs::File::open(path)?
            .take(32 * 1024 * 1024 + 1)
            .read_to_string(&mut xml)?;
        let profile = raw_core::lens_profile::parse(&xml)?;
        println!("{}", serde_json::to_string_pretty(&profile.inspection())?);
        return Ok(0);
    }

    if ext == "xmp" {
        let xml = std::fs::read_to_string(path)?;
        let model = xmp::parse(&xml)?;
        println!("{:#?}", model);
        return Ok(0);
    }

    // Try as RAW.
    let bytes = std::fs::read(path)?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = raw_core::decode::decode_bytes(&bytes, ext)?;
    println!("RAW metadata for {}", path.display());
    println!("  dimensions: {} \u{00d7} {}", raw.width, raw.height);
    println!("  CFA:        {:?}", raw.cfa);
    println!("  black:      {:?}", raw.black_level);
    println!("  white:      {}", raw.white_level);
    println!("  camera:     {} {}", raw.camera_make, raw.camera_model);
    println!("  as-shot WB: {:?}", raw.as_shot_neutral);
    println!("  as-shot CCT:{:?}", raw.as_shot_cct);
    println!("  color matrices: {} illuminants", raw.color_matrices.len());
    for (illum, _) in &raw.color_matrices {
        println!("    {:?}", illum);
    }

    Ok(0)
}
