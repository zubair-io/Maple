//! One cold first Auto `render_detail_base` (Preview, cap 2048, default model)
//! per process, with per-phase CPU time (#5172). Run with `MAPLE_PROFILE=1`:
//! `first-auto-render-cpu <RAW>` prints one `TOTAL_CPU_MS wall_ms` line after
//! the `[raw-core]` stage lines. CPU time (all threads) stays comparable on a
//! loaded machine where wall time does not.
use raw_core::{
    decode,
    pipeline::{self, DetailRenderOptions, RawInput, RenderQuality},
    xmp::AdjustmentModel,
};
use std::path::Path;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("RAW path");
    let path = Path::new(&path);
    let bytes = std::fs::read(path).expect("read RAW");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = decode::decode_bytes(&bytes, ext).expect("decode RAW");
    let start = Instant::now();
    pipeline::stage("first_auto_render", || {
        pipeline::render_detail_base(
            &raw,
            &AdjustmentModel::default(),
            RawInput::Bytes { bytes: &bytes, ext },
            DetailRenderOptions {
                target: raw_core::view::encode::TargetPrimaries::Srgb,
                quality: RenderQuality::Preview,
                max_long_edge: 2048,
                film_lut: None,
            },
        )
        .expect("render the first Auto base")
    });
    println!("WALL_MS {:.1}", start.elapsed().as_secs_f64() * 1e3);
}
