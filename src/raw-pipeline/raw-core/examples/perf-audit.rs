//! Whole-pipeline timings for the performance audit: read + decode, the sized
//! editor-open render (Preview quality, 2048 long edge) and the full-resolution
//! export render (AMaZE), each for the default model and for an edited model
//! that moves the per-pixel adjustment stages off their identity short
//! circuits. Run with `MAPLE_PROFILE=1` for per-stage lines.
//!
//! cargo run --release -p raw-core --example perf-audit -- <RAW> [sized|full|both] [default|edited|both]
use raw_core::{
    decode,
    pipeline::{self, DetailRenderOptions, RawInput, RenderQuality},
    xmp::AdjustmentModel,
};
use std::time::Instant;

fn edited() -> AdjustmentModel {
    AdjustmentModel {
        exposure: 0.4,
        contrast: 15.0,
        highlights: -40.0,
        shadows: 35.0,
        whites: 10.0,
        blacks: -8.0,
        vibrance: 20.0,
        saturation: 8.0,
        clarity: 18.0,
        texture: 12.0,
        dehaze: 10.0,
        nr_luminance: 20.0,
        vignette_amount: -20.0,
        grain_amount: 15.0,
        hue_adjustment_orange: 8.0,
        saturation_adjustment_blue: 15.0,
        luminance_adjustment_green: -10.0,
        color_grade_midtone_hue: 40.0,
        color_grade_midtone_saturation: 12.0,
        split_tone_highlight_hue: 50.0,
        split_tone_highlight_saturation: 10.0,
        ..AdjustmentModel::default()
    }
}

fn digest(pixels: &[u8]) -> u64 {
    pixels.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let out = f();
    println!(
        "AUDIT {label:<32} {:>9.1} ms",
        start.elapsed().as_secs_f64() * 1e3
    );
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = std::path::Path::new(&args[0]);
    let mode = args.get(1).map(String::as_str).unwrap_or("both");
    let models = args.get(2).map(String::as_str).unwrap_or("both");
    let bytes = timed("read", || std::fs::read(path).expect("read RAW"));
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = timed("decode", || {
        decode::decode_bytes(&bytes, ext).expect("decode RAW")
    });
    let cases = [
        ("default", AdjustmentModel::default()),
        ("edited", edited()),
    ];
    for (name, model) in cases
        .iter()
        .filter(|(n, _)| models == "both" || models == *n)
    {
        if mode != "full" {
            let (_, _, pixels, _) = timed(&format!("sized_2048_{name}"), || {
                pipeline::render_detail_base(
                    &raw,
                    model,
                    RawInput::Bytes { bytes: &bytes, ext },
                    DetailRenderOptions {
                        target: raw_core::view::encode::TargetPrimaries::Srgb,
                        quality: RenderQuality::Preview,
                        max_long_edge: 2048,
                        film_lut: None,
                    },
                )
                .expect("sized render")
            });
            println!("DIGEST sized_2048_{name} {:016x}", digest(&pixels));
        }
        if mode != "sized" {
            let (_, _, pixels) = timed(&format!("full_amaze_{name}"), || {
                pipeline::render_from_raw_with_quality_and_source(
                    &raw,
                    model,
                    RenderQuality::Amaze,
                    Some(RawInput::Bytes { bytes: &bytes, ext }),
                )
                .expect("full render")
            });
            println!("DIGEST full_amaze_{name} {:016x}", digest(&pixels));
        }
    }
}
