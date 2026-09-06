//! Profile the shared native-detail path on the generated 12288x8192 Bayer DNG.
//! Run with MAPLE_PROFILE=1 and RAYON_NUM_THREADS=8 to print stage timings:
//! cargo run --release -p raw-core --example native-detail-profile -- /tmp/100mp.dng
//! Synthetic timings qualify allocation and stencil work, not real-camera color.

use raw_core::{
    decode,
    pipeline::{self, DetailRenderOptions, RawInput, RenderQuality, TileRect},
    xmp::AdjustmentModel,
};
use std::time::Instant;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).expect("DNG path");
    let bytes = std::fs::read(&path)?;
    let raw = decode::decode_bytes(&bytes, "dng")?;
    let model = AdjustmentModel {
        exposure: 0.4,
        contrast: 15.0,
        highlights: -20.0,
        shadows: 20.0,
        clarity: 10.0,
        texture: 5.0,
        ..Default::default()
    };
    let start = Instant::now();
    let (_, _, _, context) = pipeline::render_detail_base(
        &raw,
        &model,
        RawInput::Bytes {
            bytes: &bytes,
            ext: "dng",
        },
        DetailRenderOptions {
            quality: RenderQuality::Preview,
            max_long_edge: 1600,
            film_lut: None,
        },
    )?;
    eprintln!("BASE_TOTAL {:?}", start.elapsed());
    for i in 0..3 {
        let start = Instant::now();
        let result = pipeline::render_detail_tile(
            &raw,
            &context,
            TileRect {
                src_x: 4000 + i * 400,
                src_y: 3000,
                src_w: 1600,
                src_h: 1040,
                out_w: 1600,
                out_h: 1040,
            },
            None,
            8 * 1024 * 1024,
        )?;
        eprintln!(
            "TILE_TOTAL {i} {:?}, bytes={}",
            start.elapsed(),
            result.2.len()
        );
    }
    Ok(())
}
