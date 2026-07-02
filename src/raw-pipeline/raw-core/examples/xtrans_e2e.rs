//! End-to-end smoke test for Fuji X-Trans render (#420).
//! Runs the full develop chain on test_0008.RAF and reports basic
//! sanity stats on the rendered RGB.

use raw_core::api::decode_raw;
use raw_core::pipeline::render_from_raw;
use raw_core::types::adjustment::AdjustmentModel;

fn main() {
    let fixture_root =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/raws");
    let raf = fixture_root.join("test_0008.RAF");

    println!("=== End-to-end X-Trans render ===");
    let bytes = std::fs::read(&raf).expect("read fixture");
    let raw = decode_raw(&bytes, "raf").expect("decode");
    println!(
        "decoded: {}x{}, cfa={:?}",
        raw.width,
        raw.height,
        match raw.cfa {
            raw_core::image::CfaPattern::XTrans(_) => "XTrans",
            raw_core::image::CfaPattern::Rggb => "Rggb",
            raw_core::image::CfaPattern::Bggr => "Bggr",
            raw_core::image::CfaPattern::Grbg => "Grbg",
            raw_core::image::CfaPattern::Gbrg => "Gbrg",
            raw_core::image::CfaPattern::LinearRgb => "LinearRgb",
        }
    );

    let model = AdjustmentModel::default();
    let t0 = std::time::Instant::now();
    let (out_w, out_h, rgb) = render_from_raw(&raw, &model).expect("render");
    let elapsed = t0.elapsed();
    println!(
        "render OK in {:.2}s: {}x{} bytes={}",
        elapsed.as_secs_f64(),
        out_w,
        out_h,
        rgb.len()
    );

    // Compute very basic per-channel mean to confirm the buffer isn't all
    // zeros or all clipped.
    let n = (out_w as usize) * (out_h as usize);
    let mut sum = [0.0_f64; 3];
    for px in rgb.chunks_exact(3) {
        sum[0] += px[0] as f64;
        sum[1] += px[1] as f64;
        sum[2] += px[2] as f64;
    }
    let m = [sum[0] / n as f64, sum[1] / n as f64, sum[2] / n as f64];
    println!(
        "mean R={:.1} G={:.1} B={:.1} (sane range: ~40-220)",
        m[0], m[1], m[2]
    );
}
