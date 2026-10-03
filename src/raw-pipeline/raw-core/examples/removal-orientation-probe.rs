//! #3941: exact shared-core RGB f32 orientation for native model research.
//! Never modifies originals, color samples, XMP, or production admission.

use clap::Parser;
use raw_core::image::{apply_orientation, ExifOrientation};
use serde_json::json;
use std::path::PathBuf;

#[derive(Parser)]
struct Args {
    input: PathBuf,
    width: u32,
    height: u32,
    orientation: u16,
    output: PathBuf,
    /// Undo the given EXIF orientation using the same shared pixel permutation.
    #[arg(long)]
    inverse: bool,
    /// Verify the requested EXIF tag against the actual shared RAW decoder.
    #[arg(long)]
    raw: Option<PathBuf>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    if !(1..=8).contains(&args.orientation) || args.output.exists() {
        return Err("Require an EXIF tag 1–8 and a fresh output file".into());
    }
    let raw_identity = if let Some(path) = &args.raw {
        let bytes = std::fs::read(path)?;
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .ok_or("RAW extension missing")?;
        let raw = raw_core::decode_raw(&bytes, &ext.to_lowercase())?;
        if raw.orientation != ExifOrientation::from_u16(args.orientation) {
            return Err("Requested orientation differs from the shared RAW decoder".into());
        }
        Some(json!({
            "original_blake3": blake3::hash(&bytes).to_hex().to_string(),
            "decoded_orientation": format!("{:?}", raw.orientation),
            "decoder_verified": true
        }))
    } else {
        None
    };
    let count = args.width.checked_mul(args.height).ok_or("size overflow")?;
    if count == 0 || count > 1_800_000 {
        return Err("Native research pixel budget exceeded".into());
    }
    let bytes = std::fs::read(&args.input)?;
    if bytes.len() != count as usize * 3 * 4 {
        return Err("Expected native interleaved little-endian RGB f32".into());
    }
    let source: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
        .collect();
    let orientation = if args.inverse {
        match args.orientation {
            6 => 8,
            8 => 6,
            other => other,
        }
    } else {
        args.orientation
    };
    let (width, height, output) = apply_orientation(
        &source,
        args.width,
        args.height,
        ExifOrientation::from_u16(orientation),
    );
    let output: Vec<u8> = output
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect();
    std::fs::write(&args.output, &output)?;
    println!(
        "{}",
        json!({
            "width": width, "height": height,
            "orientation": args.orientation, "inverse": args.inverse,
            "raw_identity": raw_identity,
            "input_blake3": blake3::hash(&bytes).to_hex().to_string(),
            "output_blake3": blake3::hash(&output).to_hex().to_string(),
            "sample_math": "shared-core exact pixel permutation; no color math or resizing",
            "releaseQualified": false
        })
    );
    Ok(())
}
