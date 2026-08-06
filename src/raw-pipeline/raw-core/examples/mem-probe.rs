//! Peak-memory probe for the CPU develop chain (#2661) — renders a RAW
//! through the same raw-core entries the WASM render fns call, unsized
//! (`render_from_raw_with_quality_and_source`) or sized
//! (`render_sized_from_raw_with_quality_and_source`), so peak RSS can be
//! measured at candidate long-edge caps. The wasm32 memory-budget constants
//! in `raw-wasm/src/cpu_budget.rs` were derived with this probe; re-run it
//! (single-threaded, mirroring the wasm worker) when the stage set changes:
//!
//! ```sh
//! cargo build --release -p raw-core --example mem-probe
//! RAYON_NUM_THREADS=1 /usr/bin/time -l \
//!     ./target/release/examples/mem-probe <RAW> [max_long_edge]
//! ```
//!
//! Usage: mem-probe <RAW> [max_long_edge]

use raw_core::pipeline::{
    render_from_raw_with_quality_and_source, render_sized_from_raw_with_quality_and_source,
    RawInput, RenderQuality,
};
use raw_core::xmp::AdjustmentModel;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: mem-probe <RAW> [max_long_edge]");
    let cap: Option<u32> = args.next().map(|s| s.parse().expect("cap must be u32"));

    let bytes = std::fs::read(&path).expect("read RAW");
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("dng")
        .to_lowercase();
    let raw_img = raw_core::decode::decode_bytes(&bytes, &ext).expect("decode");
    let model = AdjustmentModel::default();
    let source = Some(RawInput::Bytes {
        bytes: &bytes,
        ext: &ext,
    });

    let (w, h, out) = match cap {
        Some(c) => render_sized_from_raw_with_quality_and_source(
            &raw_img,
            &model,
            RenderQuality::Amaze,
            source,
            c,
        )
        .expect("sized render"),
        None => render_from_raw_with_quality_and_source(
            &raw_img,
            &model,
            RenderQuality::Amaze,
            source,
        )
        .expect("render"),
    };
    println!("rendered {w}x{h}, {} bytes", out.len());
}
