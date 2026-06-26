//! `maple-cli batch` — render every case in a JSON manifest. The end-to-end
//! color-pipeline harness (`src/scripts/test_color_pipeline.sh`) drives this
//! command. Uses bilinear Full demosaic (`DemosaicChoice::Full`) by default —
//! pass `--demosaic amaze` to enable AMaZE for highest quality on Bayer images.

use serde::Deserialize;
use std::path::{Path, PathBuf};

use super::render;
use super::types::{DemosaicChoice, ProfileChoice};

#[derive(Deserialize)]
struct ManifestOutput {
    #[allow(dead_code)]
    resolution: String,
    #[allow(dead_code)]
    long_edge: u32,
    #[allow(dead_code)]
    png: PathBuf,
}

#[derive(Deserialize)]
struct ManifestCase {
    raw: PathBuf,
    xmp: PathBuf,
    name: String,
    #[allow(dead_code)]
    outputs: Vec<ManifestOutput>,
}

#[derive(Deserialize)]
struct Manifest {
    cases: Vec<ManifestCase>,
}

pub fn run(
    manifest_path: &Path,
    out_dir: &Path,
    filter: Option<&str>,
    profile: ProfileChoice,
) -> Result<i32, Box<dyn std::error::Error>> {
    let manifest: Manifest = serde_json::from_str(&std::fs::read_to_string(manifest_path)?)?;
    std::fs::create_dir_all(out_dir)?;
    let mut ok = 0usize;
    let mut fail = 0usize;
    for case in &manifest.cases {
        if let Some(f) = filter {
            if !case.name.contains(f) {
                continue;
            }
        }
        let flat = case.name.replace('/', "_");
        let out_png = out_dir.join(format!("{}.png", flat));
        match render::run(
            &case.raw,
            Some(&case.xmp),
            &out_png,
            None,
            92,
            DemosaicChoice::Full,
            profile,
        ) {
            Ok(_) => {
                eprintln!("ok  {}", case.name);
                ok += 1;
            }
            Err(e) => {
                eprintln!("err {}: {}", case.name, e);
                fail += 1;
            }
        }
    }
    eprintln!("batch complete: {} ok, {} failed", ok, fail);
    Ok(if fail == 0 { 0 } else { 1 })
}
