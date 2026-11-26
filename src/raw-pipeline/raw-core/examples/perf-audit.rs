//! Whole-pipeline timings for the performance audit: read + decode, the sized
//! editor-open render (Preview quality, 2048 long edge) and the full-resolution
//! export render (AMaZE), a 1024 px native deep-zoom tile and a CPU slider
//! tick (the f32 scene-linear chain on the 2048 px sized scene, and on a
//! 1024 px native crop of the full develop), each for the default model and
//! for an edited model that moves the per-pixel adjustment stages off their
//! identity short circuits. `codecs` times the embedded-preview JPEG decode
//! and the JPEG / AVIF encodes of the preview and thumbnail tiers. Each case
//! prints min and median of `runs`. Run with `MAPLE_PROFILE=1` for
//! per-stage lines.
//!
//! cargo run --release -p raw-core --features avif --example perf-audit -- <RAW> [sized|full|tile|tick|codecs|all] [default|edited|both] [runs]
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

fn timed<T>(label: &str, runs: usize, mut f: impl FnMut() -> T) -> T {
    let mut times = Vec::with_capacity(runs);
    let mut out = None;
    for _ in 0..runs.max(1) {
        let start = Instant::now();
        out = Some(f());
        times.push(start.elapsed().as_secs_f64() * 1e3);
    }
    times.sort_by(f64::total_cmp);
    println!(
        "AUDIT {label:<32} min {:>9.1} ms  median {:>9.1} ms",
        times[0],
        times[times.len() / 2]
    );
    out.unwrap()
}

fn digest_f32(pixels: &[f32]) -> u64 {
    pixels.iter().fold(0xcbf2_9ce4_8422_2325, |hash, v| {
        (hash ^ u64::from(v.to_bits())).wrapping_mul(0x0100_0000_01b3)
    })
}

fn codecs(bytes: &[u8], ext: &str, runs: usize) {
    let (preview, _) = timed("embedded_preview_decode", runs, || {
        raw_core::preview::extract_embedded_preview(bytes, ext).expect("embedded preview")
    });
    println!("PREVIEW {}x{}", preview.width(), preview.height());
    let resized = |edge| {
        image::DynamicImage::from(raw_core::preview::resize_long_edge(preview.clone(), edge))
            .into_rgb8()
    };
    let jpeg_source = resized(1280);
    let (w, h) = jpeg_source.dimensions();
    timed("jpeg_encode_1280_q85", runs, || {
        raw_core::jpeg::encode(w, h, jpeg_source.as_raw(), 85).expect("jpeg")
    });
    #[cfg(feature = "avif")]
    {
        let avif_source = resized(512);
        let (w, h) = avif_source.dimensions();
        timed("avif_encode_512_q55", runs, || {
            raw_core::avif::encode(w, h, avif_source.as_raw(), 55).expect("avif")
        });
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = std::path::Path::new(&args[0]);
    let mode = args.get(1).map(String::as_str).unwrap_or("all");
    let models = args.get(2).map(String::as_str).unwrap_or("both");
    let runs: usize = args.get(3).map_or(1, |r| r.parse().expect("runs"));
    let wants = |m: &str| mode == "all" || mode == m;
    let bytes = timed("read", 1, || std::fs::read(path).expect("read RAW"));
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = timed("decode", runs, || {
        decode::decode_bytes(&bytes, ext).expect("decode RAW")
    });
    if wants("codecs") {
        codecs(&bytes, ext, runs);
    }
    let cases = [
        ("default", AdjustmentModel::default()),
        ("edited", edited()),
    ];
    for (name, model) in cases
        .iter()
        .filter(|(n, _)| models == "both" || models == *n)
    {
        if wants("sized") {
            let (_, _, pixels, _) = timed(&format!("sized_2048_{name}"), runs, || {
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
        if wants("full") {
            let (_, _, pixels) = timed(&format!("full_amaze_{name}"), runs, || {
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
        if wants("tile") {
            let rect = pipeline::TileRect {
                src_x: raw.width / 2 - 512,
                src_y: raw.height / 2 - 512,
                src_w: 1024,
                src_h: 1024,
                out_w: 1024,
                out_h: 1024,
            };
            let (_, _, tile) = timed(&format!("tile_native_1024_{name}"), runs, || {
                pipeline::render_scene_linear_tile_from_raw_with_quality_f32(
                    &raw,
                    model,
                    rect,
                    RenderQuality::Full,
                )
                .expect("tile render")
            });
            println!("DIGEST tile_native_1024_{name} {:016x}", digest_f32(&tile));
        }
        if wants("tick") {
            let (w, h, scene) = pipeline::render_scene_linear_sized_from_raw_with_quality_f32(
                &raw,
                &AdjustmentModel::default(),
                RenderQuality::Preview,
                2048,
            )
            .expect("sized scene");
            let options = pipeline::ChainOptions {
                nr_sampling_scale: (w.max(h) as f32 / raw.width.max(raw.height) as f32).min(1.0),
                ..pipeline::ChainOptions::default()
            };
            let out = timed(&format!("cpu_tick_2048_{name}"), runs, || {
                pipeline::apply_scene_linear_chain_f32(&scene, w, h, model, &options)
                    .expect("chain")
            });
            println!("DIGEST cpu_tick_2048_{name} {:016x}", digest_f32(&out));
            let (fw, fh, full) = pipeline::render_scene_linear_tile_from_raw_with_quality_f32(
                &raw,
                &AdjustmentModel::default(),
                pipeline::TileRect {
                    src_x: raw.width / 2 - 512,
                    src_y: raw.height / 2 - 512,
                    src_w: 1024,
                    src_h: 1024,
                    out_w: 1024,
                    out_h: 1024,
                },
                RenderQuality::Full,
            )
            .expect("native crop");
            let native = pipeline::ChainOptions::default();
            let out = timed(&format!("cpu_tick_native_1024_{name}"), runs, || {
                pipeline::apply_scene_linear_chain_f32(&full, fw, fh, model, &native)
                    .expect("chain")
            });
            println!(
                "DIGEST cpu_tick_native_1024_{name} {:016x}",
                digest_f32(&out)
            );
        }
    }
}
