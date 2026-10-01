//! #3875 diagnostic: compare identical Preview reconstruction with and without
//! early resize. Retains full f32 stage traces and writes reduced copies using
//! the production resize kernel. Camera-space stages must not be treated as
//! Rec.2020 by stage_diff.py; compare post-DCP stages only for perceptual error.
//! Usage: cargo run --release -p raw-core --features stage-dump --example
//! trace-preview-resize -- RAW OUTPUT [edge=1600]
use exr::prelude::read_first_rgba_layer_from_file;
use raw_core::{
    image::{ColorSpace, Image},
    pipeline::{
        develop_scene_linear_from_raw_with_quality,
        develop_scene_linear_sized_from_raw_with_quality, downsample_image_area, RenderQuality,
    },
    types::adjustment::{AutoExposureMode, Profile},
    xmp::AdjustmentModel,
};
use std::path::Path;

fn reduce_trace(source: &Path, output: &Path, edge: u32) {
    std::fs::create_dir_all(output).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("exr") {
            continue;
        }
        let decoded = read_first_rgba_layer_from_file(
            &path,
            |size, _| (size.x(), vec![[0.0_f32; 3]; size.x() * size.y()]),
            |(width, pixels), pos, (r, g, b, _): (f32, f32, f32, f32)| {
                pixels[pos.y() * *width + pos.x()] = [r, g, b];
            },
        )
        .unwrap();
        let size = decoded.layer_data.size;
        let mut image = Image::new(
            size.x() as u32,
            size.y() as u32,
            ColorSpace::SceneLinearRec2020,
        );
        image.pixels = decoded.layer_data.channel_data.pixels.1;
        // Resize is channel-wise and does not inspect the color-space tag.
        downsample_image_area(&mut image, edge);
        raw_core::stage_dump::dump_image(
            path.file_stem().unwrap().to_str().unwrap(),
            &image,
            output,
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() >= 3, "RAW OUTPUT [edge=1600]");
    let path = Path::new(&args[1]);
    let output = Path::new(&args[2]);
    let edge: u32 = args.get(3).map(|v| v.parse().unwrap()).unwrap_or(1600);
    assert!(edge > 0);
    let bytes = std::fs::read(path).unwrap();
    let raw = raw_core::decode::decode_bytes(&bytes, path.extension().unwrap().to_str().unwrap())
        .unwrap();
    let model = AdjustmentModel {
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::Off,
        ..Default::default()
    };
    for label in ["native", "sized"] {
        let trace = output.join(label);
        std::env::set_var("MAPLE_STAGE_DUMP", &trace);
        let image = if label == "native" {
            develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Preview)
        } else {
            develop_scene_linear_sized_from_raw_with_quality(
                &raw,
                &model,
                RenderQuality::Preview,
                edge,
            )
        }
        .unwrap();
        println!("{label}: {}x{}", image.width, image.height);
        drop(image);
        std::env::remove_var("MAPLE_STAGE_DUMP");
        reduce_trace(&trace, &output.join(format!("{label}-reduced")), edge);
        println!("{label}: reduced stage traces complete");
    }
}
