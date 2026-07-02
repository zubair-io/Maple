//! Headless parity tests for the capture-sharpening SPATIAL stage (epic #925 P3
//! wave 2 / #991). The full `CaptureSharpeningPass` (extract → RL iterations →
//! highlight-faded scale) is gated DIRECTLY vs
//! `raw_core::stages::capture_sharpening::apply_capture_sharpening` `< 1e-4` on
//! RGBA images.
//!
//! ## Test-image design (why a BLURRED step edge keeps the gate honest)
//!
//! Richardson–Lucy is a near-fixed-point on a smooth gradient: `blur(estimate) ≈
//! estimate` so `original / blur_est ≈ 1` and the estimate barely moves. raw-core's
//! own `sharpens_blurry_step_edge` test uses a BLURRED RAMP between two plateaus —
//! the deconvolution then has a genuine PSF to invert, steepening the ramp. We
//! mirror that: a soft step edge carrying chroma. Every parity test asserts the
//! reference actually MOVED the input by ≫ 1e-4 so passthrough can't satisfy it.
//!
//! ## Coverage
//!
//! - 1, 2 (default), and 3 RL iterations — the per-iteration dispatch loop.
//! - Sub-pixel (0.5) and larger (1.5) sigma — different kernel lengths
//!   (`half = ceil(3σ).max(1)`), so different uploaded weights + conv reach.
//! - The highlight-fade ramp (values near 1.0 → faded scale; `hi_thresh` clamp).
//! - BORDER (clamp-to-edge conv) + INTERIOR pixels, asserted non-vacuously.
//! - The full no-op guard set (strength/iterations/sigma/highlight_threshold).

use super::*;
use crate::chain::ChainRunner;
use crate::context::GpuContext;
use crate::image::GpuImage;

// ── Fixtures ──────────────────────────────────────────────────────────────────

/// A `w×h` RGBA image with a SOFT (pre-blurred) vertical step: two plateaus joined
/// by a linear ramp a few px wide — the content RL has a PSF to deconvolve (a hard
/// step would already be maximally sharp). Plus a soft feature hugging the borders
/// so the clamp-to-edge conv strip carries real high-frequency content. Channels
/// carry a per-side chroma skew so the luma-only scale has non-neutral pixels to
/// preserve. Values stay inside [0, 1].
fn soft_step_image(w: usize, h: usize) -> Vec<f32> {
    let ramp_lo = w / 2 - 3;
    let ramp_hi = w / 2 + 3;
    let mut v = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            // Soft vertical step (luma), warm→cool across it.
            let t = if x <= ramp_lo {
                0.0
            } else if x >= ramp_hi {
                1.0
            } else {
                (x - ramp_lo) as f32 / (ramp_hi - ramp_lo) as f32
            };
            let luma = 0.30 + 0.40 * t;
            // Per-side chroma skew (warm low, cool high), wobbling a touch with t.
            let r = luma * (1.10 - 0.20 * t);
            let g = luma * 0.98;
            let b = luma * (0.85 + 0.20 * t);
            let mut px = [r, g, b];
            // A soft bright feature on the TOP edge, dark dip on the BOTTOM edge.
            if y < 2 {
                px = [px[0] + 0.06, px[1] + 0.06, px[2] + 0.06];
            }
            if y >= h - 2 {
                px = [px[0] - 0.05, px[1] - 0.05, px[2] - 0.05];
            }
            let i = (y * w + x) * 4;
            v[i] = px[0].clamp(0.0, 1.0);
            v[i + 1] = px[1].clamp(0.0, 1.0);
            v[i + 2] = px[2].clamp(0.0, 1.0);
            v[i + 3] = 1.0;
        }
    }
    v
}

// ── Reference + helpers ─────────────────────────────────────────────────────────

/// `apply_capture_sharpening` on a flat RGBA buffer — the stage-level reference
/// (alpha carried through). Translates our local `CaptureSharpeningParams` into
/// raw-core's identical struct.
fn raw_core_capture(buf: &[f32], w: u32, h: u32, params: CaptureSharpeningParams) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let rc = raw_core::stages::capture_sharpening::CaptureSharpeningParams {
        sigma: params.sigma,
        iterations: params.iterations,
        highlight_threshold: params.highlight_threshold,
        strength: params.strength,
        noise_floor: params.noise_floor,
    };
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::capture_sharpening::apply_capture_sharpening(&mut img, &rc);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// Run `CaptureSharpeningPass` on the GPU over `input`, read back the flat RGBA.
fn capture_gpu(
    ctx: &GpuContext,
    input: &[f32],
    w: u32,
    h: u32,
    params: CaptureSharpeningParams,
) -> Vec<f32> {
    let img = GpuImage::upload(ctx, input, w, h);
    let runner = ChainRunner::new(ctx, &img);
    runner.run_blocking(&[&CaptureSharpeningPass { params }])
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

// ── kernel parity (gaussian_kernel_1d vs raw-core's private fn) ─────────────────

/// The CPU-built Gaussian kernel must match raw-core's `gaussian_kernel_1d`
/// structurally — sums to 1.0, length `2*ceil(3σ).max(1)+1`, symmetric. raw-core's
/// fn is private (unreachable from the dev-dep), so we pin the STRUCTURE here; the
/// stage parity tests below confirm the END-TO-END convolution agrees `< 1e-4`,
/// which is the real "kernel is identical" proof.
#[test]
fn gaussian_kernel_matches_raw_core_structure() {
    for &sigma in &[0.25_f32, 0.5, 0.68, 1.0, 1.5, 2.0] {
        let k = gaussian_kernel_1d(sigma);
        let sum: f32 = k.iter().sum();
        assert!(
            (sum - 1.0).abs() < 1e-6,
            "kernel for sigma={sigma} sums to {sum}"
        );
        let expected_half = (3.0 * sigma).ceil().max(1.0) as usize;
        assert_eq!(
            k.len(),
            2 * expected_half + 1,
            "kernel len for sigma={sigma}"
        );
        for i in 0..k.len() / 2 {
            assert!(
                (k[i] - k[k.len() - 1 - i]).abs() < 1e-6,
                "kernel asymmetric at sigma={sigma}, i={i}"
            );
        }
    }
}

// ── Stage-level parity ───────────────────────────────────────────────────────────

/// THE PRIMARY GATE: `CaptureSharpeningPass` matches `apply_capture_sharpening`
/// `< 1e-4` across iteration counts (1, 2, 3) — the per-iteration RL dispatch
/// loop. Asserts raw-core actually deconvolved (moved ≫ 1e-4).
#[test]
fn capture_pass_matches_raw_core_across_iterations() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (64usize, 24usize);
    let input = soft_step_image(w, h);
    for &iterations in &[1u32, 2, 3] {
        let params = CaptureSharpeningParams {
            iterations,
            ..Default::default()
        };
        let reference = raw_core_capture(&input, w as u32, h as u32, params);
        let (moved, _) = max_diff_at(&input, &reference);
        let gpu = capture_gpu(&ctx, &input, w as u32, h as u32, params);
        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        eprintln!(
            "CAPTURE PARITY iterations={iterations}: max abs diff = {max_diff:e} \
             at pixel ({},{}); raw-core moved input by {moved:e}",
            px % w,
            px / w
        );
        assert!(
            moved > 1e-3,
            "capture iterations={iterations} barely moved the image ({moved:e}) — gate vacuous"
        );
        assert!(
            max_diff < 1e-4,
            "CaptureSharpeningPass vs apply iterations={iterations} max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// Sigma parity: sub-pixel (0.5) and larger (1.5) sigma → different kernel lengths
/// (`half = ceil(3σ).max(1)` = 2 vs 5) and conv reach. Confirms the uploaded
/// weights + clamp-to-edge conv match raw-core at both ends of the sigma range.
#[test]
fn capture_pass_matches_raw_core_across_sigma() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (64usize, 24usize);
    let input = soft_step_image(w, h);
    for &sigma in &[0.5_f32, 1.5] {
        let params = CaptureSharpeningParams {
            sigma,
            ..Default::default()
        };
        let reference = raw_core_capture(&input, w as u32, h as u32, params);
        let (moved, _) = max_diff_at(&input, &reference);
        let gpu = capture_gpu(&ctx, &input, w as u32, h as u32, params);
        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        eprintln!(
            "CAPTURE PARITY sigma={sigma}: max abs diff = {max_diff:e} at pixel ({},{}); \
             raw-core moved input by {moved:e}",
            px % w,
            px / w
        );
        assert!(
            moved > 1e-3,
            "capture sigma={sigma} barely moved the image ({moved:e}) — gate vacuous"
        );
        assert!(
            max_diff < 1e-4,
            "CaptureSharpeningPass vs apply sigma={sigma} max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// The HIGHLIGHT-FADE path: an image with luma near/at 1.0 exercises the
/// `y_old >= hi_thresh` ramp `strength * clamp((1-y_old)/(1-hi_thresh), 0, 1)` and
/// the `hi_thresh = min(0.999)` clamp (so a `highlight_threshold == 1.0` input
/// can't divide by zero). Must match `< 1e-4` AND stay finite. This is the path
/// the soft-step fixture (luma ≤ ~0.76) does NOT fully exercise.
#[test]
fn capture_pass_matches_raw_core_highlight_fade() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 16usize);
    // Soft step from a near-clipped highlight (0.995) down to mid (0.5), so a
    // band of pixels lands above the default 0.99 highlight threshold.
    let mut input = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let t = (x as f32 / (w - 1) as f32).clamp(0.0, 1.0);
            let luma = 0.995 - 0.495 * t;
            let i = (y * w + x) * 4;
            input[i] = (luma * 1.02).clamp(0.0, 1.0);
            input[i + 1] = luma;
            input[i + 2] = (luma * 0.97).clamp(0.0, 1.0);
            input[i + 3] = 1.0;
        }
    }
    // Test both the default threshold and the divide-by-zero edge (== 1.0).
    for &hi in &[0.99_f32, 1.0] {
        let params = CaptureSharpeningParams {
            highlight_threshold: hi,
            ..Default::default()
        };
        let reference = raw_core_capture(&input, w as u32, h as u32, params);
        let gpu = capture_gpu(&ctx, &input, w as u32, h as u32, params);
        let (max_diff, _) = max_diff_at(&reference, &gpu);
        eprintln!("CAPTURE PARITY highlight_threshold={hi}: max abs diff = {max_diff:e}");
        assert!(
            gpu.iter().all(|v| v.is_finite()),
            "capture (hi={hi}) produced non-finite output"
        );
        assert!(
            max_diff < 1e-4,
            "CaptureSharpeningPass vs apply hi={hi} max abs diff {max_diff} exceeds 1e-4"
        );
    }
}

/// BORDER + INTERIOR coverage is non-vacuous: the Gaussian conv clamps samples in
/// the border strip (reach `half = ceil(3σ)` px). Assert the border strip AND the
/// interior BOTH match `< 1e-4`, and the interior actually MOVED from the input.
#[test]
fn capture_border_and_interior_coverage_non_vacuous() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (64usize, 24usize);
    let params = CaptureSharpeningParams::default(); // sigma 0.68 → half = ceil(2.04) = 3
    let strip = (3.0_f32 * params.sigma).ceil().max(1.0) as usize;
    let input = soft_step_image(w, h);
    let reference = raw_core_capture(&input, w as u32, h as u32, params);
    let gpu = capture_gpu(&ctx, &input, w as u32, h as u32, params);

    let mut border_worst = 0.0f32;
    let mut border_counted = 0usize;
    let mut interior_worst = 0.0f32;
    let mut interior_counted = 0usize;
    let mut interior_moved = 0.0f32;
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let in_strip = x < strip || x >= w - strip || y < strip || y >= h - strip;
            for c in 0..4 {
                let d = (reference[i + c] - gpu[i + c]).abs();
                if in_strip {
                    border_worst = border_worst.max(d);
                } else {
                    interior_worst = interior_worst.max(d);
                    interior_moved = interior_moved.max((reference[i + c] - input[i + c]).abs());
                }
            }
            if in_strip {
                border_counted += 1;
            } else {
                interior_counted += 1;
            }
        }
    }
    eprintln!(
        "BORDER strip ({strip}px): {border_counted} px, worst {border_worst:e}; \
         INTERIOR: {interior_counted} px, worst {interior_worst:e}, max move {interior_moved:e}"
    );
    assert!(
        border_counted > 0 && interior_counted > 0,
        "coverage vacuous"
    );
    assert!(
        interior_moved > 1e-4,
        "interior never moved ({interior_moved:e}) — deconvolution is a no-op, gate vacuous"
    );
    assert!(
        border_worst < 1e-4,
        "border-strip diff {border_worst} exceeds 1e-4"
    );
    assert!(
        interior_worst < 1e-4,
        "interior diff {interior_worst} exceeds 1e-4"
    );
}

/// The two PER-PIXEL skip-paths in `apply_scale` (raw-core's
/// `if y_old < 1e-6 { return }` and `if blend <= 0.0 { return }`) — the silent
/// trap where a bare GPU return would leave stale `dst` instead of `dst = src`.
/// Other fixtures never TRIGGER them (soft-step floors at luma ~0.25, the
/// highlight fixture tops at ~0.997), so this one plants a NEAR-BLACK pixel
/// (extracted luma < 1e-6 → first skip) and a FULLY-CLIPPED pixel (luma >= 1.0 →
/// `blend = strength * clamp((1-1)/(1-hi),0,1) = 0` → second skip) and confirms the
/// GPU still matches raw-core `< 1e-4` (i.e. both write the source value through).
#[test]
fn capture_apply_scale_skip_paths_match_raw_core() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (32usize, 16usize);
    // Mid-tone soft step (so most pixels DO get scaled — the gate isn't trivial)
    // with two planted pathological pixels.
    let mut input = soft_step_image(w, h);
    let black = 0usize; // top-left (x=0,y=0): (0 * w + 0) * 4 == 0; drive extracted luma to 0.
    input[black] = 0.0;
    input[black + 1] = 0.0;
    input[black + 2] = 0.0;
    let clipped = (8 * w + 16) * 4; // interior: luma >= 1.0 → blend == 0.
    input[clipped] = 1.2;
    input[clipped + 1] = 1.2;
    input[clipped + 2] = 1.2;

    let params = CaptureSharpeningParams::default();
    let reference = raw_core_capture(&input, w as u32, h as u32, params);
    let gpu = capture_gpu(&ctx, &input, w as u32, h as u32, params);

    // The two planted pixels must come back unchanged on BOTH sides (raw-core's
    // per-pixel `return` leaves them == input; the GPU must do the same via
    // dst = src, NOT leave stale buffer data).
    for (label, base) in [("near-black", black), ("clipped", clipped)] {
        for c in 0..3 {
            assert!(
                (reference[base + c] - input[base + c]).abs() < 1e-6,
                "{label} pixel: raw-core did not pass it through (policy drift)"
            );
            assert!(
                (gpu[base + c] - input[base + c]).abs() < 1e-4,
                "{label} pixel ch{c}: GPU skip-path left {} not src {} — dst=src missing",
                gpu[base + c],
                input[base + c]
            );
        }
    }
    let (max_diff, _) = max_diff_at(&reference, &gpu);
    eprintln!("CAPTURE PARITY (skip-paths planted): max abs diff = {max_diff:e}");
    assert!(
        max_diff < 1e-4,
        "skip-path fixture max abs diff {max_diff} exceeds 1e-4"
    );
}

// ── Identity / robustness (the no-op guard set) ──────────────────────────────────

/// `strength == 0.0` is a bit-exact no-op (raw-core's `disabled_at_zero_strength`):
/// the GPU must reproduce the input bit-for-bit (the Pass copies src → dst).
#[test]
fn capture_zero_strength_is_identity() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16usize, 16usize);
    let input = soft_step_image(w, h);
    let gpu = capture_gpu(
        &ctx,
        &input,
        w as u32,
        h as u32,
        CaptureSharpeningParams {
            strength: 0.0,
            ..Default::default()
        },
    );
    assert_eq!(
        gpu, input,
        "strength=0 must pass the image through unchanged"
    );
}

/// The remaining no-op guards each copy src → dst: zero iterations, zero / huge /
/// non-finite sigma, non-finite strength, non-finite highlight_threshold. Mirrors
/// raw-core's leading guard set — all must reproduce the input bit-for-bit.
#[test]
fn capture_noop_guards_are_identity() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (16usize, 16usize);
    let input = soft_step_image(w, h);
    let base = CaptureSharpeningParams::default();
    let cases = [
        CaptureSharpeningParams {
            iterations: 0,
            ..base
        },
        CaptureSharpeningParams { sigma: 0.0, ..base },
        CaptureSharpeningParams {
            sigma: 50.001,
            ..base
        },
        CaptureSharpeningParams {
            sigma: f32::NAN,
            ..base
        },
        CaptureSharpeningParams {
            strength: f32::INFINITY,
            ..base
        },
        CaptureSharpeningParams {
            highlight_threshold: f32::NAN,
            ..base
        },
    ];
    for (i, params) in cases.into_iter().enumerate() {
        let gpu = capture_gpu(&ctx, &input, w as u32, h as u32, params);
        assert_eq!(
            gpu, input,
            "no-op guard case {i} ({params:?}) must pass the image through unchanged"
        );
    }
}

/// Flat field stays flat: with no patch differences, `blur(estimate) == estimate`
/// so `ratio == 1` and the estimate is unchanged → scale 1.0. Mirrors raw-core's
/// `preserves_flat_regions_within_tolerance`, carried through the GPU path.
#[test]
fn capture_flat_field_stays_flat() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (32usize, 32usize);
    let input: Vec<f32> = (0..w * h).flat_map(|_| [0.5f32, 0.5, 0.5, 1.0]).collect();
    let gpu = capture_gpu(
        &ctx,
        &input,
        w as u32,
        h as u32,
        CaptureSharpeningParams::default(),
    );
    assert!(
        gpu.iter().all(|v| v.is_finite()),
        "flat field produced non-finite output"
    );
    let (diff, _) = max_diff_at(&input, &gpu);
    assert!(diff < 1e-3, "flat field drifted by {diff} (expected ~0)");
}

/// Composition: capture-sharpening behaves as ONE [`Pass`] — after an identity
/// exposure pass it equals capture-alone, and two spatial passes back-to-back
/// finish without a resource/validation error (the per-encode scratch planes don't
/// collide across encodes).
#[test]
fn capture_composes_as_one_pass_in_a_chain() {
    use crate::exposure::ExposurePass;
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (48usize, 24usize);
    let input = soft_step_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let params = CaptureSharpeningParams::default();

    let solo = runner.run_blocking(&[&CaptureSharpeningPass { params }]);
    let chained =
        runner.run_blocking(&[&ExposurePass { ev: 0.0 }, &CaptureSharpeningPass { params }]);
    let (diff, _) = max_diff_at(&solo, &chained);
    assert!(
        diff < 1e-4,
        "capture after an identity exposure pass diverged from capture-alone by {diff} \
         — the stage does not compose as a clean src→dst Pass"
    );
}
