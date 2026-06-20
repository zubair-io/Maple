//! Parity tests for the vignette WGSL kernel (#1109).
//!
//! Split out of `vignette.rs` to keep that module under the 600-LOC budget
//! (mirrors saturation's `tests.rs` split). Included via
//! `#[path = "vignette/tests.rs"] mod tests;` so it reaches the parent's
//! private helpers through `super::*`.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A 2-D test buffer with varied values — vignette is POSITION-dependent,
/// so unlike the point-op stages the buffer must carry real width × height
/// (a count×1 strip would only exercise one row of the radius field).
/// 16×12 spans centre (r = 0), the mask band, and saturated corners
/// (r ≈ 1.4), plus HDR headroom + a slightly-negative channel.
fn buffer_16x12() -> (Vec<f32>, u32, u32) {
    let (w, h) = (16u32, 12u32);
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let t = i as f32 / (w * h) as f32;
            let (r, g, b) = match i % 7 {
                0 => (0.80, 0.10, 0.10),  // saturated red
                3 => (5.00, 3.00, 1.50),  // HDR scene-headroom
                5 => (-0.01, 0.20, 0.40), // slightly-negative channel
                _ => (0.05 + t, 0.9 - t * 0.5, 0.2 + t * 0.3),
            };
            v.extend_from_slice(&[r, g, b, 1.0]);
        }
    }
    (v, w, h)
}

/// Run `raw_core::stages::vignette::apply` on a flat interleaved RGBA f32
/// buffer, returning a new buffer (alpha carried through untouched). The
/// ticket's actual reference — the Rust stage itself.
fn raw_core_vignette(buf: &[f32], w: u32, h: u32, amount: f32, feather: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::vignette::apply(&mut img, amount, feather);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// THE PARITY GATE: the WGSL vignette kernel matches
/// `raw_core::stages::vignette::apply` — the actual Rust stage, via the
/// test-only dev-dep — within 1e-4 across amount/feather spreads on a 2-D
/// buffer spanning centre, band, and saturated-corner radii.
#[test]
fn wgsl_vignette_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (input, w, h) = buffer_16x12();

    for &(amount, feather) in &[
        (-100.0_f32, 0.0_f32),
        (-100.0, 50.0),
        (-35.0, 100.0),
        (40.0, 25.0),
        (100.0, 100.0),
    ] {
        let reference = raw_core_vignette(&input, w, h, amount, feather);

        let img = GpuImage::upload(&ctx, &input, w, h);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&VignettePass { amount, feather }]);

        let max_diff = reference
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        eprintln!(
            "PARITY vs raw-core vignette amount={amount} feather={feather}: \
             max abs diff = {max_diff:e}"
        );
        assert!(
            max_diff < 1e-4,
            "vignette({amount}, {feather}): GPU vs raw-core stage max abs diff \
             {max_diff} exceeds 1e-4"
        );
    }
}

/// Pin the local CPU oracle (`apply_vignette`) to raw-core's stage too, so
/// the transcribed constants can't silently drift from the canonical math.
#[test]
fn local_oracle_matches_raw_core_stage_exactly() {
    let (input, w, h) = buffer_16x12();
    for &(amount, feather) in &[(-100.0_f32, 0.0_f32), (-60.0, 50.0), (80.0, 100.0)] {
        let reference = raw_core_vignette(&input, w, h, amount, feather);
        let mut local = input.clone();
        apply_vignette(
            &mut local,
            w as usize,
            h as usize,
            VignetteOptions {
                origin: (0, 0),
                full: (w, h),
                amount,
                feather,
            },
        );
        let max_diff = reference
            .iter()
            .zip(&local)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            max_diff == 0.0,
            "vignette({amount}, {feather}): local oracle vs raw-core stage diff \
             {max_diff} != 0 (same float sequence expected)"
        );
    }
}

/// The window contract on the GPU oracle: a tile evaluated with its origin
/// reproduces the full render's pixels exactly (tile-safe point op). The
/// kernel carries the same uniform; the live chain pins origin (0, 0).
#[test]
fn oracle_window_matches_full_render() {
    let (input, w, h) = buffer_16x12();
    let mut full = input.clone();
    apply_vignette(
        &mut full,
        w as usize,
        h as usize,
        VignetteOptions {
            origin: (0, 0),
            full: (w, h),
            amount: -80.0,
            feather: 40.0,
        },
    );

    // An 8×6 tile at (8, 6) — the bottom-right quadrant.
    let (tx, ty, tw, th) = (8u32, 6u32, 8u32, 6u32);
    let mut tile: Vec<f32> = Vec::with_capacity((tw * th * 4) as usize);
    for y in 0..th {
        for x in 0..tw {
            let src = (((ty + y) * w + (tx + x)) * 4) as usize;
            tile.extend_from_slice(&input[src..src + 4]);
        }
    }
    apply_vignette(
        &mut tile,
        tw as usize,
        th as usize,
        VignetteOptions {
            origin: (tx, ty),
            full: (w, h),
            amount: -80.0,
            feather: 40.0,
        },
    );
    for y in 0..th {
        for x in 0..tw {
            let t = ((y * tw + x) * 4) as usize;
            let f = (((ty + y) * w + (tx + x)) * 4) as usize;
            assert_eq!(
                &tile[t..t + 4],
                &full[f..f + 4],
                "tile pixel ({x},{y}) diverges from the full render"
            );
        }
    }
}

/// Centre identity on the GPU: the centre pixel sits at r = 0 → m = 0 →
/// gain = exp2(±0) = 1.0, a bit-exact multiply. Drive an ODD-dims buffer
/// so one pixel lands exactly on the centre.
#[test]
fn center_pixel_is_bit_exact_identity_on_gpu() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (9u32, 7u32);
    let mut input = vec![0.0f32; (w * h * 4) as usize];
    for px in input.chunks_exact_mut(4) {
        px.copy_from_slice(&[0.42, 0.18, 0.07, 1.0]);
    }
    let img = GpuImage::upload(&ctx, &input, w, h);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&VignettePass {
        amount: -100.0,
        feather: 100.0,
    }]);
    let c = (((h / 2) * w + (w / 2)) * 4) as usize;
    assert_eq!(
        &gpu[c..c + 4],
        &[0.42, 0.18, 0.07, 1.0],
        "centre must be untouched"
    );
    // ... while the corner IS attenuated (the pass did run).
    assert!(gpu[0] < 0.42, "corner must darken at amount −100");
}
