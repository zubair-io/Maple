//! Parity tests for the saturation WGSL kernel (epic #925 / #990).
//!
//! Split out of `saturation.rs` to keep that module under the 600-LOC budget
//! (mirrors raw-core's `view/auto_profile/tests.rs`). Included via
//! `#[path = "saturation/tests.rs"] mod tests;` so it reaches the parent's
//! private helpers through `super::*`.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A test buffer that deliberately exercises every saturation branch:
///   - PURE BLACK (exact zero Oklab chroma → the `c_in < 1e-6` NaN-guard
///     passthrough; CPU and GPU both pass it through, so parity is 0 here),
///   - near-Rec.2020 primaries + saturated yellow (positive saturation drives a
///     channel negative → the bisection + soft-compress branch),
///   - an HDR-headroom saturated red (> 1 → confirms the lower-bound-only gamut
///     predicate lets scene values above 1 through the fast path),
///   - a low-chroma red (well inside gamut → the in-gamut fast path at +sat),
///   - mid-grey (chroma ~1e-4, NOT zero — takes the scale path, not the guard).
///
/// These primaries are raw-core's own #269 test inputs, known to round-trip
/// cleanly through the identical 24-iter bisection (no pixel sits exactly on the
/// hull, which would risk a per-platform branch-flip at the boundary).
fn branchy_buffer() -> Vec<f32> {
    vec![
        // r,    g,    b,    a
        0.00, 0.00, 0.00, 1.0, // pure black → zero chroma → passthrough (NaN guard)
        0.90, 0.05, 0.05, 1.0, // near-Rec.2020 red → +sat goes OOG → bisect path
        0.05, 0.90, 0.05, 0.7, // near-Rec.2020 green → bisect path
        0.05, 0.05, 0.90, 1.0, // near-Rec.2020 blue → bisect path
        0.70, 0.70, 0.05, 1.0, // saturated yellow → bisect path
        4.00, 0.50, 0.50, 0.5, // HDR-headroom saturated red (> 1)
        0.40, 0.35, 0.35, 1.0, // low-chroma red → in-gamut fast path at +sat
        0.50, 0.50, 0.50, 1.0, // mid grey: chroma ~1e-4 → scale path (not guard)
    ]
}

/// Run `raw_core::stages::saturation::apply` on a flat interleaved RGBA f32
/// buffer, returning a new buffer (alpha carried through untouched, matching the
/// kernel + local oracle). This is the ticket's actual reference — the Rust
/// stage itself, not a reimplementation.
fn raw_core_saturation(buf: &[f32], saturation: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let count = buf.len() / 4;
    let mut img = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::saturation::apply(&mut img, saturation);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// THE PARITY GATE (the ticket's contract): the WGSL saturation kernel matches
/// `raw_core::stages::saturation::apply` — the actual Rust stage, via a
/// test-only dev-dep on raw-core — within 1e-4 across a spread of slider values,
/// on a buffer exercising the desaturation, in-gamut-fast, bisection-compress,
/// and near-neutral-passthrough branches. Pins the GPU output to the canonical
/// CPU stage directly, so a transcription error in the local oracle cannot mask
/// a kernel bug.
#[test]
fn wgsl_saturation_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking();
    let input = branchy_buffer();
    let count = (input.len() / 4) as u32;

    // Negative (desaturate), positive in-gamut, and positive past-the-hull
    // (the bisection branch). -100 is full desaturation; +100 doubles chroma.
    for &sat in &[-100.0_f32, -50.0, 25.0, 60.0, 100.0] {
        let reference = raw_core_saturation(&input, sat);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&SaturationPass { saturation: sat }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("PARITY vs raw-core saturation={sat}: max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "saturation={sat}: GPU vs raw-core stage max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle (`apply_saturation`) to raw-core's stage too, so the
/// convenience oracle this crate exports can't silently drift from the canonical
/// math. (The GPU gate above doesn't depend on the local oracle at all.)
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_4() {
    let input = branchy_buffer();
    for &sat in &[-100.0_f32, -50.0, 25.0, 60.0, 100.0] {
        let reference = raw_core_saturation(&input, sat);
        let mut local = input.clone();
        apply_saturation(&mut local, sat);
        let max_diff = reference
            .iter()
            .zip(&local)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_diff < 1e-4,
            "saturation={sat}: local oracle vs raw-core stage diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Self-contained fallback gate: the WGSL kernel matches the local CPU oracle
/// within 1e-4 (no raw-core dep needed to run). A fast, dependency-free signal
/// alongside the raw-core gate; mirrors the vibrance precedent.
#[test]
fn wgsl_saturation_matches_cpu_oracle_within_1e_4() {
    let ctx = GpuContext::new_blocking();
    let input = branchy_buffer();
    let count = (input.len() / 4) as u32;

    for &sat in &[-100.0_f32, -50.0, 25.0, 60.0, 100.0] {
        let mut cpu = input.clone();
        apply_saturation(&mut cpu, sat);

        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&SaturationPass { saturation: sat }]);

        let max_diff = cpu
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!("PARITY saturation={sat}: max abs diff = {max_diff:e}");
        assert!(
            max_diff < 1e-4,
            "saturation={sat}: GPU vs CPU max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pure black is the only input with exact zero Oklab chroma, so it hits the
/// kernel's `c_in < 1e-6` NaN guard, which copies the source pixel (including
/// alpha) bit-exact. Pins that the guard fires and is a straight copy — the
/// branch the step-1 analysis flagged as load-bearing for NaN-safety.
#[test]
fn pure_black_hits_neutral_guard_bit_exact_on_gpu() {
    let ctx = GpuContext::new_blocking();
    let input = vec![0.0_f32, 0.0, 0.0, 0.9];
    let img = GpuImage::upload(&ctx, &input, 1, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&SaturationPass { saturation: 100.0 }]);
    assert_eq!(gpu[0], 0.0, "black R must pass through unchanged");
    assert_eq!(gpu[1], 0.0, "black G must pass through unchanged");
    assert_eq!(gpu[2], 0.0, "black B must pass through unchanged");
    assert_eq!(gpu[3], 0.9, "alpha must pass through unchanged");
}

/// The bisection branch must keep every channel ≥ -GAMUT_EPS on the GPU for
/// highly-saturated inputs whose naive 2× chroma scale would go negative — the
/// GPU analogue of raw-core's `plus_100_keeps_all_channels_non_negative`. This
/// is the direct evidence the WGSL bisection loop actually pulls OOG pixels back
/// into gamut (not just that it numerically matches the oracle).
#[test]
fn plus_100_keeps_all_channels_non_negative_on_gpu() {
    let ctx = GpuContext::new_blocking();
    let cases: [[f32; 4]; 5] = [
        [0.9, 0.05, 0.05, 1.0], // near-Rec.2020 red
        [0.05, 0.9, 0.05, 1.0], // near-Rec.2020 green
        [0.05, 0.05, 0.9, 1.0], // near-Rec.2020 blue
        [0.7, 0.7, 0.05, 1.0],  // saturated yellow
        [4.0, 0.5, 0.5, 1.0],   // HDR-headroom saturated red
    ];
    for rgb in cases {
        let input = rgb.to_vec();
        let img = GpuImage::upload(&ctx, &input, 1, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&SaturationPass { saturation: 100.0 }]);
        let min_c = gpu[0].min(gpu[1]).min(gpu[2]);
        assert!(
            min_c >= -GAMUT_EPS,
            "input {rgb:?} → GPU {gpu:?} has min channel {min_c} < -{GAMUT_EPS}"
        );
        for &c in &gpu[..3] {
            assert!(c.is_finite(), "non-finite channel in GPU output {gpu:?}");
        }
    }
}

/// Full desaturation (-100 → scale 0) drives a saturated pixel to a neutral grey
/// (R ≈ G ≈ B) on the GPU. Exercises the `scale ≤ 1` desaturation branch (which
/// returns the round-tripped pixel, skipping the gamut check) end-to-end.
#[test]
fn minus_100_makes_achromatic_on_gpu() {
    let ctx = GpuContext::new_blocking();
    let input = vec![0.8_f32, 0.1, 0.1, 1.0];
    let img = GpuImage::upload(&ctx, &input, 1, 1);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&SaturationPass { saturation: -100.0 }]);
    assert!((gpu[0] - gpu[1]).abs() < 0.05, "R {} vs G {}", gpu[0], gpu[1]);
    assert!((gpu[1] - gpu[2]).abs() < 0.05, "G {} vs B {}", gpu[1], gpu[2]);
}
