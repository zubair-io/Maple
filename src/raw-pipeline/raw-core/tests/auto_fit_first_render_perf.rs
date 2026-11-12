//! Opt-in timing guard for the first Auto render of an unfitted asset (#5104).
//!
//! The first `render_detail_base` of an asset fits the Auto profile inline,
//! which is what Web cold open pays. Run on an otherwise idle machine:
//! `cargo test --release -p raw-core --test auto_fit_first_render_perf -- --ignored --nocapture`
//!
//! Wall time is only meaningful on an idle machine. On a loaded one, run the
//! `first-auto-render-cpu` example with `MAPLE_PROFILE=1` instead: every stage
//! line carries the process CPU time next to its wall time (#5172).

use raw_core::{
    decode,
    pipeline::{self, DetailRenderOptions, RawInput, RenderQuality},
    xmp::AdjustmentModel,
};
use std::path::PathBuf;
use std::time::Instant;

const BUDGET_MS: f64 = 1_400.;
/// The uncached-open budget the 22 MP case must meet (#5172).
const BUDGET_22MP_MS: f64 = 1_000.;

fn first_auto_base_render_ms(file: &str, ext: &str) -> Option<f64> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test-fixtures/raws")
        .join(file);
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping: {} not present", path.display());
        return None;
    };
    let raw = decode::decode_bytes(&bytes, ext).expect("decode the fixture");
    let start = Instant::now();
    let (width, height, _, _) = pipeline::render_detail_base(
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
    .expect("render the first Auto base");
    let elapsed_ms = start.elapsed().as_secs_f64() * 1e3;
    eprintln!("{file} first Auto base render {width}x{height}: {elapsed_ms:.1} ms");
    Some(elapsed_ms)
}

#[test]
#[ignore = "timing: run with --release --ignored on an idle machine with the 100 MP fixture"]
fn first_auto_base_render_of_the_100mp_reference_fits_the_cold_open_budget() {
    let Some(elapsed_ms) = first_auto_base_render_ms("dji-mavic3pro-100mp.dng", "dng") else {
        return;
    };
    assert!(
        elapsed_ms <= BUDGET_MS,
        "first Auto base render took {elapsed_ms:.1} ms, over the {BUDGET_MS} ms cold-open budget"
    );
}

#[test]
#[ignore = "timing: run with --release --ignored on an idle machine with test_0007"]
fn first_auto_base_render_of_a_22mp_raw_fits_the_one_second_budget() {
    let Some(elapsed_ms) = first_auto_base_render_ms("test_0007.DNG", "dng") else {
        return;
    };
    assert!(
        elapsed_ms <= BUDGET_22MP_MS,
        "first Auto base render took {elapsed_ms:.1} ms, over the {BUDGET_22MP_MS} ms uncached-open budget"
    );
}
