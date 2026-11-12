//! #4373 evidence for the bounded sized develop's RCD quad kernel
//! (`test-fixtures/qualification/rcd-quad-sized-4373.md`). Run under
//! `/usr/bin/time -l` for peak RSS. Usage: RAW MODE [ARGS]
//! - `demosaic`: linearize, then `rcd_quad_half_cancellable` only.
//! - `half`: linearize, then `half_res_cancellable` only.
//! - `sized EDGE`: the default-model Full sized scene-linear develop.
//! - `png EDGE SIZED.png [EXPORT.png]`: the default (Auto) sized display
//!   render, and optionally the unsized export, both from the RAW's path.
use raw_core::decode::decode_bytes;
use raw_core::pipeline::{develop_scene_linear_sized_from_raw_with_quality, RenderQuality};
use raw_core::xmp::AdjustmentModel;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = std::path::Path::new(&args[1]);
    let bytes = std::fs::read(path).unwrap();
    let ext = path
        .extension()
        .unwrap()
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    let raw = decode_bytes(&bytes, &ext).unwrap();
    drop(bytes);
    match args[2].as_str() {
        "demosaic" => {
            let mosaic = raw_core::linearize::sensor_linearize(&raw);
            let t = std::time::Instant::now();
            let out = raw_core::demosaic::rcd_quad_half_cancellable(
                &mosaic,
                raw.cfa,
                raw_core::CancelToken::never(),
            );
            eprintln!("demosaic {}x{} in {:?}", out.width, out.height, t.elapsed());
        }
        "half" => {
            let mosaic = raw_core::linearize::sensor_linearize(&raw);
            let out = raw_core::demosaic::half_res_cancellable(
                &mosaic,
                raw.cfa,
                raw_core::CancelToken::never(),
            );
            eprintln!("half {}x{}", out.width, out.height);
        }
        "sized" => {
            let edge: u32 = args[3].parse().unwrap();
            let out = develop_scene_linear_sized_from_raw_with_quality(
                &raw,
                &AdjustmentModel::default(),
                RenderQuality::Full,
                edge,
            )
            .unwrap();
            eprintln!("sized {}x{}", out.width, out.height);
        }
        "png" => {
            use raw_core::pipeline::{
                render_from_raw_with_quality_source_and_film,
                render_sized_from_raw_with_quality_and_source, RawInput,
            };
            let model = AdjustmentModel::default();
            let edge: u32 = args[3].parse().unwrap();
            let save = |out: &str, (w, h, px): (u32, u32, Vec<u8>)| {
                image::RgbImage::from_raw(w, h, px)
                    .unwrap()
                    .save(out)
                    .unwrap();
            };
            save(
                &args[4],
                render_sized_from_raw_with_quality_and_source(
                    &raw,
                    &model,
                    RenderQuality::Full,
                    Some(RawInput::Path(path)),
                    edge,
                )
                .unwrap(),
            );
            if let Some(export) = args.get(5) {
                save(
                    export,
                    render_from_raw_with_quality_source_and_film(
                        &raw,
                        &model,
                        RenderQuality::Full,
                        Some(RawInput::Path(path)),
                        None,
                    )
                    .unwrap(),
                );
            }
        }
        other => panic!("mode {other}"),
    }
}
