//! Parity tests for the vectorscope-scope WGSL kernel (#3272). Split out of
//! `scope.rs` to keep that module under the 600-LOC budget (mirrors the
//! `local_adjustments.rs` / `local_adjustments/tests.rs` split). Included via
//! `#[path = "scope/tests.rs"] mod tests;` so it reaches the parent's private
//! items through `super::*`.
//!
//! The gate compares against `raw_core::scope::vectorscope_histogram_rgba`
//! itself — the shipping Rust producer, through the test-only dev-dep —
//! rather than a transcribed CPU twin, so there is nothing that can drift
//! out from under the kernel.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;
use crate::local_adjustments::LocalAdjustmentsPass;
use raw_core::scope::vectorscope_histogram_rgba;
use raw_core::types::{layers_to_flat, LocalAdjustment, Mask, PartialAdjustments, Point2};

/// The constant this crate mirrors from raw-core (see `scope.rs`'s doc) must
/// actually match it — the parity test both files' doc comments promise.
#[test]
fn vectorscope_bins_matches_raw_core() {
    assert_eq!(VECTORSCOPE_BINS, raw_core::scope::VECTORSCOPE_BINS);
}

fn gradient_rgba(w: u32, h: u32) -> Vec<f32> {
    (0..w * h)
        .flat_map(|i| {
            let t = i as f32 / (w * h) as f32;
            [t, 1.0 - t, (t * 7.0).fract(), 1.0]
        })
        .collect()
}

/// Sum of |gpu − cpu| over every bin, relative to the total weight. A pure
/// count-agreement check (not a bin-VALUE tolerance) would be too strict at
/// bin boundaries, where f32 rounding can nudge one pixel into the
/// neighbouring bin on one side but not the other — this bounds how much of
/// the TOTAL weight that kind of boundary jitter is allowed to move.
fn relative_l1(a: &[u32], b: &[u32], total: u32) -> f32 {
    let l1: u64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| (*x as i64 - *y as i64).unsigned_abs())
        .sum();
    l1 as f32 / total.max(1) as f32
}

#[test]
fn vectorscope_kernel_matches_the_cpu_histogram_on_a_plain_frame() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (64u32, 48u32);
    let rgba = gradient_rgba(w, h);
    let img = GpuImage::upload(&ctx, &rgba, w, h);
    let got = run_vectorscope_blocking(&ctx, &img.buffer, w * h, false);
    let want = vectorscope_histogram_rgba(&rgba, false);
    assert_eq!(got.total, want.total);
    assert!(
        relative_l1(&got.bins, &want.bins, want.total) < 0.005,
        "bins drift beyond boundary-rounding tolerance"
    );
}

#[test]
fn vectorscope_kernel_weighs_by_alpha_written_by_the_scope_target_layer() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (64u32, 48u32);
    let rgba = gradient_rgba(w, h);
    let layer = LocalAdjustment {
        mask: Mask::Linear {
            start: Point2::new(0.0, 0.5),
            end: Point2::new(1.0, 0.5),
            feather: 0.5,
        },
        range: None,
        adjustments: PartialAdjustments::default(),
    };
    let img = GpuImage::upload(&ctx, &rgba, w, h);
    let runner = ChainRunner::new(&ctx, &img);
    let pass = LocalAdjustmentsPass::new(&layers_to_flat(&[layer]), &[]).with_scope_layer(0);
    let after: Vec<f32> = runner.run_blocking(&[&pass]);
    // The alpha lane now carries the mask weight; the colour lanes are untouched.
    for (i, px) in after.chunks_exact(4).enumerate() {
        assert_eq!(&px[..3], &rgba[i * 4..i * 4 + 3]);
    }
    assert_eq!(after[3], 0.0, "x=0 is the w=0 end");
    assert!(
        (after[((w - 1) * 4 + 3) as usize] - 1.0).abs() < 1e-6,
        "x=w-1 is the w=1 end"
    );
    let out_img = GpuImage::upload(&ctx, &after, w, h);
    let got = run_vectorscope_blocking(&ctx, &out_img.buffer, w * h, true);
    let want = vectorscope_histogram_rgba(&after, true);
    assert_eq!(got.total, want.total);
    assert!(relative_l1(&got.bins, &want.bins, want.total) < 0.005);
}
