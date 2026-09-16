//! #3633: measure actual sized scene preparation, separately from display/encode.
//! Run each variant in a fresh process under `/usr/bin/time -l` for peak RSS.
//! Example: MAPLE_PROFILE=1 RAYON_NUM_THREADS=4 cargo run --release -p raw-core
//! --example sized-open-probe -- fixture.dng preview 1600
use raw_core::{
    decode,
    pipeline::{develop_scene_linear_sized_from_raw_with_quality, RenderQuality},
    xmp::{AdjustmentModel, AutoExposureMode, Profile},
};
use std::{collections::hash_map::DefaultHasher, hash::Hasher, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let path = args.get(1).ok_or("expected DNG path")?;
    let quality = match args.get(2).map(String::as_str) {
        Some("preview") => RenderQuality::Preview,
        Some("amaze") => RenderQuality::Amaze,
        _ => return Err("expected preview or amaze".into()),
    };
    let size = args.get(3).ok_or("expected long edge")?.parse()?;
    let bytes = std::fs::read(path)?;
    let raw = decode::decode_bytes(&bytes, "dng")?;
    let model = AdjustmentModel {
        auto_exposure: AutoExposureMode::Off,
        profile: Profile::Neutral,
        ..Default::default()
    };
    let start = Instant::now();
    let scene = develop_scene_linear_sized_from_raw_with_quality(&raw, &model, quality, size)?;
    let elapsed = start.elapsed();
    let mut hash = DefaultHasher::new();
    for pixel in &scene.pixels {
        for value in pixel {
            hash.write_u32(value.to_bits());
        }
    }
    println!(
        "sized_open_ms={:.3} dimensions={}x{} hash={:016x}",
        elapsed.as_secs_f64() * 1000.0,
        scene.width,
        scene.height,
        hash.finish()
    );
    Ok(())
}
