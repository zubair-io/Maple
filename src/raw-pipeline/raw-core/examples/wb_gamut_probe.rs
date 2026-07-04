//! Ad-hoc probe for #1726 acceptance: renders a RAW through the full
//! develop chain at an extreme user WB (default 12000K / +17, the
//! yellow-filter/banding repro) and reports the fraction of scene-linear
//! Rec.2020 pixels with any negative channel — the out-of-gamut signature
//! that the pipeline's hard gamut clip subsequently collapses into flat
//! plates (the banding mechanism this ticket addresses).
//!
//! Usage:
//!   cargo run --release -p raw-core --example wb_gamut_probe -- <raw_path> [temp] [tint]

use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
use raw_core::xmp::AdjustmentModel;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: wb_gamut_probe <raw> [temp] [tint]");
    let temperature: f32 = args.next().map(|s| s.parse()).transpose()?.unwrap_or(12000.0);
    let tint: f32 = args.next().map(|s| s.parse()).transpose()?.unwrap_or(17.0);

    let raw = raw_core::decode::decode(std::path::Path::new(&path))?;
    println!("file: {}", path);
    println!("camera: {} {}", raw.camera_make, raw.camera_model);
    println!("target: {:.0}K / tint {:+.1}", temperature, tint);

    let model = AdjustmentModel {
        temperature,
        tint,
        temperature_seen: true,
        tint_seen: true,
        ..AdjustmentModel::default()
    };
    let scene = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Full)?;

    let total = scene.pixels.len();
    let negative = scene
        .pixels
        .iter()
        .filter(|p| p[0] < 0.0 || p[1] < 0.0 || p[2] < 0.0)
        .count();
    let strongly_negative = scene
        .pixels
        .iter()
        .filter(|p| p[0] < -1e-3 || p[1] < -1e-3 || p[2] < -1e-3)
        .count();
    let min_channel = scene
        .pixels
        .iter()
        .fold(f32::INFINITY, |m, p| m.min(p[0]).min(p[1]).min(p[2]));

    println!("pixels: {}", total);
    println!(
        "out-of-gamut (any channel < 0):      {} ({:.4}%)",
        negative,
        100.0 * negative as f64 / total as f64
    );
    println!(
        "strongly out-of-gamut (< -1e-3):     {} ({:.4}%)",
        strongly_negative,
        100.0 * strongly_negative as f64 / total as f64
    );
    println!("min scene-linear channel value:      {:.6}", min_channel);

    Ok(())
}
