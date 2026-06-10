//! Headless parity tests for the sharpen SPATIAL stage (epic #925 P3 wave 2 /
//! #991). The full `SharpenPass` (luma extract → blur → USM scale → edge-mix) is
//! gated DIRECTLY vs `raw_core::stages::sharpen::apply` `< 1e-4` on RGBA images.
//!
//! ## Test-image design (why HIGH-FREQUENCY content keeps the gate honest)
//!
//! Unsharp masking is a near-fixed-point on a smooth gradient: `blur(luma) ≈ luma`
//! so the USM delta `li - lb ≈ 0` and the output ≈ the input. A gentle-gradient
//! fixture would pass VACUOUSLY (nothing sharpened) — so we mirror raw-core's own
//! fixtures: STEP EDGES carrying chroma. A step edge drives a large `li - lb` at
//! the transition (real sharpening) AND, with masking on, exercises BOTH sides of
//! the gradient gate (`g_norm >= threshold → 1.0` at the edge, the flat
//! `→ detail_atten` away from it). Every parity test asserts the reference
//! actually MOVED the input by ≫ 1e-4 so passthrough can't satisfy it.
//!
//! ## Coverage
//!
//! - `masking == 0` (no gradient branch) AND `masking > 0` (the central-difference
//!   gradient + edge gate) — separate code paths in `sharpen_mix.wgsl`.
//! - `amount` at 100 and PAST 100 (overall_mix up to 1.5).
//! - BORDER (clamp-to-edge gradient) + INTERIOR (full windows) pixels, asserted
//!   separately and non-vacuously.

use super::*;
use crate::chain::ChainRunner;
use crate::context::GpuContext;
use crate::image::GpuImage;

// ── Fixtures ──────────────────────────────────────────────────────────────────

/// A `w×h` RGBA image with a sharp VERTICAL step edge down the middle (left vs
/// right block) PLUS a few smaller blocks hugging the borders, so both the
/// interior step and the clamp-to-edge gradient strip carry real high-frequency
/// content. Channels carry a per-side chroma skew (left R-heavy, right G/B-heavy)
/// so the luma-only scaling has non-neutral pixels to preserve. Values stay inside
/// scene-linear [0, 1].
fn stepped_image(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            // Main vertical step: dark-warm left, bright-cool right.
            let mut px = if x < w / 2 {
                [0.30f32, 0.18, 0.12]
            } else {
                [0.55f32, 0.62, 0.70]
            };
            // A bright block in the TOP-LEFT corner and a dark block in the
            // BOTTOM-RIGHT corner — exercise the border gradient strip.
            if x < 4 && y < 4 {
                px = [0.85, 0.80, 0.75];
            }
            if x >= w - 4 && y >= h - 4 {
                px = [0.05, 0.06, 0.04];
            }
            // A thin horizontal stripe a few rows in, to add a second edge axis.
            if y == 5 {
                px = [px[0] * 0.5, px[1] * 0.5, px[2] * 0.5];
            }
            let i = (y * w + x) * 4;
            v[i] = px[0];
            v[i + 1] = px[1];
            v[i + 2] = px[2];
            v[i + 3] = 1.0;
        }
    }
    v
}

// ── Reference + helpers ─────────────────────────────────────────────────────────

/// `raw_core::stages::sharpen::apply` on a flat RGBA buffer — the stage-level
/// reference (alpha carried through untouched, like the NLM gate).
fn raw_core_sharpen(
    buf: &[f32],
    w: u32,
    h: u32,
    amount: f32,
    radius: f32,
    detail: f32,
    masking: f32,
) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::sharpen::apply(&mut img, amount, radius, detail, masking);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// Run `SharpenPass` on the GPU over `input`, read back the flat RGBA result.
#[allow(clippy::too_many_arguments)] // test plumbing: ctx/input/dims/the four sliders.
fn sharpen_gpu(
    ctx: &GpuContext,
    input: &[f32],
    w: u32,
    h: u32,
    amount: f32,
    radius: f32,
    detail: f32,
    masking: f32,
) -> Vec<f32> {
    let img = GpuImage::upload(ctx, input, w, h);
    let runner = ChainRunner::new(ctx, &img);
    runner.run_blocking(&[&SharpenPass {
        amount,
        radius,
        detail,
        masking,
    }])
}

/// Max abs diff between two flat buffers, plus the worst index.
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

// ── Stage-level parity ───────────────────────────────────────────────────────────

/// THE PRIMARY GATE (masking OFF): `SharpenPass` matches
/// `raw_core::stages::sharpen::apply` `< 1e-4` across amount values INCLUDING past
/// 100 (overall_mix up to 1.5), with masking=0 (no gradient branch — mix is
/// uniform `overall_mix`). Asserts raw-core actually sharpened (moved ≫ 1e-4).
#[test]
fn sharpen_pass_matches_raw_core_masking_off() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 32usize);
    let input = stepped_image(w, h);
    for &amount in &[50.0_f32, 100.0, 140.0] {
        let reference = raw_core_sharpen(&input, w as u32, h as u32, amount, 1.0, 25.0, 0.0);
        let (moved, _) = max_diff_at(&input, &reference);
        let gpu = sharpen_gpu(&ctx, &input, w as u32, h as u32, amount, 1.0, 25.0, 0.0);
        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        eprintln!(
            "SHARPEN PARITY (masking=0) amount={amount}: max abs diff = {max_diff:e} \
             at pixel ({},{}); raw-core moved input by {moved:e}",
            px % w,
            px / w
        );
        assert!(
            moved > 1e-3,
            "sharpen amount={amount} barely moved the image ({moved:e}) — gate is vacuous"
        );
        assert!(
            max_diff < 1e-4,
            "SharpenPass vs apply (masking=0) amount={amount} max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// THE MASKING-ON GATE: with `masking > 0` the edge-mix runs the central-difference
/// luma gradient and gates flat vs edge regions (`detail_atten` vs 1.0). This path
/// is NEVER exercised by the masking=0 test, so it must move the image AND match
/// `< 1e-4`. Two masking thresholds (one low, one high) probe both sides of the
/// `g_norm >= threshold` gate over the step edge.
#[test]
fn sharpen_pass_matches_raw_core_masking_on() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 32usize);
    let input = stepped_image(w, h);
    for &masking in &[20.0_f32, 70.0] {
        let reference = raw_core_sharpen(&input, w as u32, h as u32, 100.0, 2.0, 40.0, masking);
        let (moved, _) = max_diff_at(&input, &reference);
        let gpu = sharpen_gpu(&ctx, &input, w as u32, h as u32, 100.0, 2.0, 40.0, masking);
        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        eprintln!(
            "SHARPEN PARITY (masking={masking}) detail=40 radius=2: max abs diff = {max_diff:e} \
             at pixel ({},{}); raw-core moved input by {moved:e}",
            px % w,
            px / w
        );
        assert!(
            moved > 1e-3,
            "sharpen masking={masking} barely moved the image ({moved:e}) — the gradient \
             branch is only vacuously gated"
        );
        assert!(
            max_diff < 1e-4,
            "SharpenPass vs apply (masking={masking}) max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// BORDER + INTERIOR coverage is non-vacuous (masking ON, so the gradient reads
/// the clamp-to-edge border strip). Assert the 1-px border ring (where the
/// gradient closure clamps its samples) AND the interior BOTH match `< 1e-4`, and
/// that the interior actually MOVED from the input (sharpening happened there).
#[test]
fn sharpen_border_and_interior_coverage_non_vacuous() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 32usize);
    let input = stepped_image(w, h);
    let reference = raw_core_sharpen(&input, w as u32, h as u32, 100.0, 2.0, 30.0, 50.0);
    let gpu = sharpen_gpu(&ctx, &input, w as u32, h as u32, 100.0, 2.0, 30.0, 50.0);

    let mut border_worst = 0.0f32;
    let mut border_counted = 0usize;
    let mut interior_worst = 0.0f32;
    let mut interior_counted = 0usize;
    let mut interior_moved = 0.0f32;
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            // 1-px ring is where the central-difference gradient clamps a sample.
            let on_border = x == 0 || y == 0 || x == w - 1 || y == h - 1;
            for c in 0..4 {
                let d = (reference[i + c] - gpu[i + c]).abs();
                if on_border {
                    border_worst = border_worst.max(d);
                } else {
                    interior_worst = interior_worst.max(d);
                    interior_moved = interior_moved.max((reference[i + c] - input[i + c]).abs());
                }
            }
            if on_border {
                border_counted += 1;
            } else {
                interior_counted += 1;
            }
        }
    }
    eprintln!(
        "BORDER ring: {border_counted} px, worst {border_worst:e}; \
         INTERIOR: {interior_counted} px, worst {interior_worst:e}, max move {interior_moved:e}"
    );
    assert!(
        border_counted > 0 && interior_counted > 0,
        "coverage vacuous"
    );
    assert!(
        interior_moved > 1e-4,
        "interior never moved ({interior_moved:e}) — sharpening is a no-op, gate is vacuous"
    );
    assert!(
        border_worst < 1e-4,
        "border-ring diff {border_worst} exceeds 1e-4"
    );
    assert!(
        interior_worst < 1e-4,
        "interior diff {interior_worst} exceeds 1e-4"
    );
}

// ── Identity / robustness ────────────────────────────────────────────────────────

/// `amount == 0` is identity: the GPU reproduces the input bit-for-bit (the Pass
/// copies src → dst). Mirrors raw-core's `amount.abs() < 1e-3` early return.
#[test]
fn sharpen_amount_zero_is_identity() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16usize, 16usize);
    let input = stepped_image(w, h);
    let gpu = sharpen_gpu(&ctx, &input, w as u32, h as u32, 0.0, 1.0, 25.0, 0.0);
    assert_eq!(gpu, input, "amount=0 must pass the image through unchanged");
}

/// Chroma-ratio preservation (the #439 no-fringing contract) survives the GPU
/// path: a saturated red/cyan step edge keeps each pixel's R:G:B ratio because the
/// luma-only USM scales all three channels by ONE scalar. This is implied by the
/// `< 1e-4` parity gate, but pinned here directly as the property sharpen exists to
/// guarantee.
#[test]
fn sharpen_preserves_chroma_ratio_on_saturated_edge() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (32usize, 8usize);
    let left = [0.40f32, 0.05, 0.05];
    let right = [0.05f32, 0.40, 0.40];
    let mut input = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let p = if x < w / 2 { left } else { right };
            let i = (y * w + x) * 4;
            input[i] = p[0];
            input[i + 1] = p[1];
            input[i + 2] = p[2];
            input[i + 3] = 1.0;
        }
    }
    let gpu = sharpen_gpu(&ctx, &input, w as u32, h as u32, 100.0, 1.0, 25.0, 0.0);
    let mut moved = 0.0f32;
    for i in 0..w * h {
        let a = [input[i * 4], input[i * 4 + 1], input[i * 4 + 2]];
        let b = [gpu[i * 4], gpu[i * 4 + 1], gpu[i * 4 + 2]];
        let kr = b[0] / a[0].max(1e-6);
        let kg = b[1] / a[1].max(1e-6);
        let kb = b[2] / a[2].max(1e-6);
        moved = moved.max((b[1] - a[1]).abs());
        assert!(
            (kr - kg).abs() < 1e-4 && (kg - kb).abs() < 1e-4,
            "pixel {i} drifted off luma-only scaling: in={a:?} out={b:?} k={kr}/{kg}/{kb}"
        );
    }
    assert!(
        moved > 1e-4,
        "sharpen did nothing on the saturated edge — chroma-ratio test is vacuous"
    );
}

/// Above-display (scene-headroom) values stay finite through the GPU path —
/// mirrors raw-core's `preserves_scene_headroom`.
#[test]
fn sharpen_preserves_scene_headroom() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16usize, 16usize);
    let mut input = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            // A high-value step so the USM has something to amplify in headroom.
            let v = if x < w / 2 { 5.0f32 } else { 3.0 };
            let i = (y * w + x) * 4;
            input[i] = v;
            input[i + 1] = v * 0.6;
            input[i + 2] = v * 0.3;
            input[i + 3] = 1.0;
        }
    }
    let gpu = sharpen_gpu(&ctx, &input, w as u32, h as u32, 100.0, 1.0, 25.0, 0.0);
    assert!(
        gpu.iter().all(|v| v.is_finite()),
        "sharpen produced non-finite output"
    );
}
