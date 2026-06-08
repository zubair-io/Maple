//! Headless parity tests for the clarity SPATIAL stage (epic #925 P2 wave 3b /
//! #990). The contract gate is GPU vs the REAL `raw_core::stages::clarity::apply`
//! (via the test-only `raw-core` dev-dep) `< 1e-4`. `box_blur_channel` /
//! `guided_filter` are `pub(crate)` in raw-core, so the only cross-crate surface
//! is the public `apply` — we gate end-to-end through it.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A 64×64 RGBA f32 test image whose content VARIES near the borders, so the
/// shrinking-window box-blur edge handling is exercised non-vacuously, while
/// interior pixels (≥ 20 px from every edge — clarity's radius) still get full
/// windows. Built as a diagonal gradient plus a bright cross near two edges and a
/// dark block in a corner; a slight per-channel skew keeps R:G:B non-neutral so
/// the luma-only scale is a real test.
fn border_varying_image(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let gx = x as f32 / (w - 1) as f32;
            let gy = y as f32 / (h - 1) as f32;
            // Diagonal gradient base, modest scene values.
            let mut luma = 0.15 + 0.55 * (gx + gy) * 0.5;
            // A bright vertical stripe hugging the LEFT edge (cols 0..3) and a
            // bright horizontal stripe hugging the TOP edge (rows 0..3) — forces
            // the truncated-window border path to differ from the interior.
            if x < 3 || y < 3 {
                luma += 0.30;
            }
            // A dark block in the BOTTOM-RIGHT corner (also a border region).
            if x >= w - 4 && y >= h - 4 {
                luma *= 0.25;
            }
            let i = (y * w + x) * 4;
            // Non-neutral skew so the luma-only scale actually moves chroma-bearing
            // pixels; keep all channels positive and finite.
            v[i] = luma * 1.05;
            v[i + 1] = luma * 0.95;
            v[i + 2] = luma * 0.85;
            v[i + 3] = 1.0;
        }
    }
    v
}

/// Run `raw_core::stages::clarity::apply` on a flat interleaved RGBA f32 buffer,
/// returning a new buffer (alpha carried through untouched — the kernel + oracle
/// leave alpha alone). The ticket's actual reference: the Rust stage itself.
fn raw_core_clarity(buf: &[f32], w: u32, h: u32, clarity: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::clarity::apply(&mut img, clarity);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// Max abs diff between two flat RGBA buffers, plus the worst index — so a border
/// failure reports WHERE (the index reveals row/col, hence whether it's an edge).
fn max_diff_at(a: &[f32], b: &[f32]) -> (f32, usize) {
    let mut worst = 0.0f32;
    let mut worst_i = 0usize;
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        let d = (x - y).abs();
        if d > worst {
            worst = d;
            worst_i = i;
        }
    }
    (worst, worst_i)
}

/// THE PARITY GATE: the WGSL clarity pipeline matches
/// `raw_core::stages::clarity::apply` within 1e-4 across a spread of slider
/// values, on a 64×64 image whose borders carry real content. Border + interior
/// pixels are BOTH in the diff (the whole buffer is compared); the worst-index
/// report confirms which region drives the max.
#[test]
fn wgsl_clarity_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (64usize, 64usize);
    let input = border_varying_image(w, h);

    for &clarity in &[-100.0_f32, -50.0, 30.0, 100.0] {
        let reference = raw_core_clarity(&input, w as u32, h as u32, clarity);

        let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&ClarityPass { clarity }]);

        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        let (wx, wy) = (px % w, px / w);
        eprintln!(
            "PARITY vs raw-core clarity={clarity}: max abs diff = {max_diff:e} \
             at pixel ({wx},{wy}) [border={}]",
            wx < 3 || wy < 3 || wx >= w - 4 || wy >= h - 4
        );
        assert!(
            max_diff < 1e-4,
            "clarity={clarity}: GPU vs raw-core stage max abs diff {max_diff} exceeds 1e-4 \
             (worst at pixel ({wx},{wy}))"
        );
    }
}

/// Explicitly assert the BORDER ring is covered non-vacuously: diff only the
/// outermost 3-px frame (the truncated-window region) and confirm parity there
/// too. Without this, a border bug could hide if the interior happened to
/// dominate the global max.
#[test]
fn wgsl_clarity_border_ring_matches_raw_core() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (64usize, 64usize);
    let input = border_varying_image(w, h);
    let clarity = 100.0f32;
    let reference = raw_core_clarity(&input, w as u32, h as u32, clarity);

    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&ClarityPass { clarity }]);

    let mut worst = 0.0f32;
    let mut counted = 0usize;
    for y in 0..h {
        for x in 0..w {
            let is_border = x < 3 || y < 3 || x >= w - 3 || y >= h - 3;
            if !is_border {
                continue;
            }
            counted += 1;
            let i = (y * w + x) * 4;
            for c in 0..3 {
                worst = worst.max((reference[i + c] - gpu[i + c]).abs());
            }
        }
    }
    eprintln!("BORDER parity: {counted} border pixels, max abs diff = {worst:e}");
    assert!(counted > 0, "border ring was empty — test is vacuous");
    assert!(
        worst < 1e-4,
        "clarity border-ring GPU vs raw-core max abs diff {worst} exceeds 1e-4"
    );
}

/// `clarity = 0` is identity: the GPU must reproduce the input bit-for-bit
/// (the Pass copies src → dst). Mirrors raw-core's `|clarity| < 1e-3` early return.
#[test]
fn wgsl_clarity_zero_is_identity() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (16usize, 16usize);
    let input = border_varying_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&ClarityPass { clarity: 0.0 }]);
    assert_eq!(gpu, input, "clarity=0 must pass the image through unchanged");
}

/// A flat neutral field has no detail, so clarity is a no-op at any amount — the
/// GPU must keep every pixel on the flat value (raw-core's closed-form invariant).
#[test]
fn wgsl_clarity_flat_stays_flat() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (32usize, 32usize);
    let input: Vec<f32> = (0..w * h).flat_map(|_| [0.5f32, 0.5, 0.5, 1.0]).collect();
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    for &clarity in &[-100.0_f32, 50.0, 100.0] {
        let gpu = runner.run_blocking(&[&ClarityPass { clarity }]);
        let (max_diff, _) = max_diff_at(&input, &gpu);
        assert!(
            max_diff < 1e-4,
            "clarity={clarity}: flat field drifted by {max_diff}"
        );
    }
}

/// Pin the local CPU oracle (`apply_clarity`) to raw-core's stage too, so the
/// crate's convenience oracle can't silently drift from the canonical math.
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_4() {
    let (w, h) = (64usize, 64usize);
    let input = border_varying_image(w, h);
    for &clarity in &[-100.0_f32, -50.0, 30.0, 100.0] {
        let reference = raw_core_clarity(&input, w as u32, h as u32, clarity);
        let mut local = input.clone();
        apply_clarity(&mut local, w, h, clarity);
        let (max_diff, _) = max_diff_at(&reference, &local);
        assert!(
            max_diff < 1e-4,
            "clarity={clarity}: local oracle vs raw-core stage diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Pure-black pixels (luma 0) must not yield NaN/Inf via the luma-ratio divide —
/// the GPU's `max(luma, LUMA_FLOOR)` guard mirrors raw-core. Plant one bright
/// pixel so the field isn't flat.
#[test]
fn wgsl_clarity_handles_pure_black() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (32usize, 32usize);
    let mut input = vec![0.0f32; w * h * 4];
    for px in input.chunks_exact_mut(4) {
        px[3] = 1.0;
    }
    let bi = (10 * w + 10) * 4;
    input[bi] = 0.5;
    input[bi + 1] = 0.5;
    input[bi + 2] = 0.5;
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&ClarityPass { clarity: 100.0 }]);
    assert!(gpu.iter().all(|v| v.is_finite()), "clarity produced non-finite output");
}
