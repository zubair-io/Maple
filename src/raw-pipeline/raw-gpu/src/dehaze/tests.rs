//! Headless parity tests for the dehaze SPATIAL stage (epic #925 P2 wave 3b /
//! #990). The contract gate is GPU vs the REAL `raw_core::stages::dehaze::apply`
//! (via the test-only `raw-core` dev-dep) `< 1e-4`. Dehaze's internals
//! (`dark_channel`, `atmospheric_light`, `transmission`, `guided_filter`,
//! `sky_mask`, `recover_with_mask`) are all private in raw-core, so the only
//! cross-crate surface is the public `apply` — we gate end-to-end through it.
//!
//! Dehaze's GLOBAL airlight reduction makes the test image design load-bearing.
//! The top-0.1% of the dark channel must be selected UNAMBIGUOUSLY — the same
//! pixels regardless of the sort comparator — or the CPU airlight derive and
//! raw-core's `sort_unstable_by` could tie-break differently and `A` (which
//! feeds both transmission and recovery) would diverge. In this image that
//! unambiguity comes from the smooth diagonal gradient: the brightest
//! dark-channel positions have DISTINCT values, so no two straddle the cut
//! (the `total_cmp`-vs-`partial_cmp` cross-check in
//! `compute_airlight_is_byte_exact_vs_independent_selection` confirms it — the
//! measured A is ~[0.666, 0.627, 0.576], drawn from the bright gradient/border,
//! NOT the small specular patch, whose 15×15 min-erosion keeps it out of the
//! top-N). The image is 128×128 so the guided filter's radius-60 window has
//! interior pixels with FULL (non-truncated) windows as well as the truncated
//! border ring.

use super::*;
use crate::chain::ChainRunner;
use crate::image::GpuImage;

/// A 128×128 hazy RGBA f32 test image with: a hazy base + diagonal gradient
/// (whose distinct dark-channel values give the airlight top-N an unambiguous,
/// comparator-independent cut), a darker low-transmission structure block (gives
/// the dark channel real spatial variation), border-hugging features (so the
/// clamp-to-edge min and the shrinking-window guided blurs both differ at the
/// frame), and a small bright "specular" patch that adds chroma variety. A
/// slight per-channel skew keeps R:G:B non-neutral so the per-channel recovery is
/// a real test.
fn hazy_image(w: usize, h: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let gx = x as f32 / (w - 1) as f32;
            let gy = y as f32 / (h - 1) as f32;
            // Hazy mid-distance base: moderately high, low local contrast.
            let mut luma = 0.45 + 0.20 * (gx + gy) * 0.5;
            // A darker structure block off-centre (low transmission region).
            if (24..56).contains(&x) && (72..104).contains(&y) {
                luma *= 0.35;
            }
            // Border-hugging bright stripe (left + top edges) and a dark
            // bottom-right corner — exercise the border paths non-vacuously.
            if x < 3 || y < 3 {
                luma += 0.15;
            }
            if x >= w - 4 && y >= h - 4 {
                luma *= 0.4;
            }
            let i = (y * w + x) * 4;
            v[i] = (luma * 1.04).min(1.0);
            v[i + 1] = (luma * 0.98).min(1.0);
            v[i + 2] = (luma * 0.90).min(1.0);
            v[i + 3] = 1.0;
        }
    }
    // A small bright "specular" patch (12×12) near the top-right for extra
    // chroma variety. NOTE: the 15×15 dark-channel min erodes a patch this
    // small, so it does NOT dominate the airlight top-0.1% (the measured A is
    // ~[0.666,…], drawn from the bright gradient/border). Airlight unambiguity
    // comes from the gradient's distinct dc values, not this patch — see the
    // module header and the byte-exact selection test.
    for y in 8..20 {
        for x in (w - 20)..(w - 8) {
            let i = (y * w + x) * 4;
            v[i] = 0.97;
            v[i + 1] = 0.965;
            v[i + 2] = 0.96;
        }
    }
    v
}

/// Run `raw_core::stages::dehaze::apply` on a flat interleaved RGBA f32 buffer,
/// returning a new buffer (alpha carried through untouched). The ticket's actual
/// reference: the Rust stage itself.
fn raw_core_dehaze(buf: &[f32], w: u32, h: u32, dehaze: f32) -> Vec<f32> {
    use raw_core::image::{ColorSpace, Image};
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, chunk) in buf.chunks_exact(4).enumerate() {
        img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
    }
    raw_core::stages::dehaze::apply(&mut img, dehaze);
    let mut out = Vec::with_capacity(buf.len());
    for (i, p) in img.pixels.iter().enumerate() {
        out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
    }
    out
}

/// Max abs diff between two flat RGBA buffers, plus the worst flat index.
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

/// A `DehazePass` whose airlight is derived from `input` — the chain feeds the
/// pass that same buffer as `src`, so the CPU-side global reduction matches.
fn pass(input: &[f32], w: usize, h: usize, dehaze: f32) -> DehazePass {
    DehazePass::new(input, w, h, dehaze)
}

/// THE PARITY GATE: the WGSL dehaze pipeline matches
/// `raw_core::stages::dehaze::apply` within 1e-4 across the strength range, on a
/// 128×128 hazy image. Border + interior pixels are BOTH in the diff; the
/// worst-index report confirms which region drives the max.
#[test]
fn wgsl_dehaze_matches_raw_core_stage_within_1e_4() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (128usize, 128usize);
    let input = hazy_image(w, h);

    for &dehaze in &[-100.0_f32, -50.0, 50.0, 100.0] {
        let reference = raw_core_dehaze(&input, w as u32, h as u32, dehaze);

        let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&pass(&input, w, h, dehaze)]);

        let (max_diff, worst_i) = max_diff_at(&reference, &gpu);
        let px = worst_i / 4;
        let (wx, wy) = (px % w, px / w);
        eprintln!(
            "PARITY vs raw-core dehaze={dehaze}: max abs diff = {max_diff:e} \
             at pixel ({wx},{wy}) [border={}]",
            wx < 3 || wy < 3 || wx >= w - 4 || wy >= h - 4
        );
        assert!(
            max_diff < 1e-4,
            "dehaze={dehaze}: GPU vs raw-core stage max abs diff {max_diff} exceeds 1e-4 \
             (worst at pixel ({wx},{wy}))"
        );
    }
}

/// Explicitly assert the BORDER ring is covered non-vacuously: diff only the
/// outermost frame (where clamp-to-edge min + truncated-window blurs both differ
/// from the interior) and confirm parity there too.
#[test]
fn wgsl_dehaze_border_ring_matches_raw_core() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (128usize, 128usize);
    let input = hazy_image(w, h);
    let dehaze = 100.0f32;
    let reference = raw_core_dehaze(&input, w as u32, h as u32, dehaze);

    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&pass(&input, w, h, dehaze)]);

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
        "dehaze border-ring GPU vs raw-core max abs diff {worst} exceeds 1e-4"
    );
}

/// Assert the INTERIOR (≥ radius-60 from every edge) is covered: the
/// full-window guided-filter region. Without this, a full-window bug could hide
/// behind a border-dominated global max (or vice versa).
#[test]
fn wgsl_dehaze_interior_matches_raw_core() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (128usize, 128usize);
    let input = hazy_image(w, h);
    let dehaze = 80.0f32;
    let reference = raw_core_dehaze(&input, w as u32, h as u32, dehaze);

    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&pass(&input, w, h, dehaze)]);

    // 128 - 2*60 = 8 interior columns/rows have a full radius-60 window.
    let mut worst = 0.0f32;
    let mut counted = 0usize;
    for y in 60..(h - 60) {
        for x in 60..(w - 60) {
            counted += 1;
            let i = (y * w + x) * 4;
            for c in 0..3 {
                worst = worst.max((reference[i + c] - gpu[i + c]).abs());
            }
        }
    }
    eprintln!("INTERIOR parity: {counted} full-window pixels, max abs diff = {worst:e}");
    assert!(counted > 0, "interior region was empty — test is vacuous");
    assert!(
        worst < 1e-4,
        "dehaze interior GPU vs raw-core max abs diff {worst} exceeds 1e-4"
    );
}

/// `dehaze = 0` is identity: the GPU must reproduce the input bit-for-bit (the
/// Pass copies src → dst). Mirrors raw-core's `|dehaze| < 1e-3` early return.
#[test]
fn wgsl_dehaze_zero_is_identity() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (32usize, 32usize);
    let input = hazy_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&pass(&input, w, h, 0.0)]);
    assert_eq!(gpu, input, "dehaze=0 must pass the image through unchanged");
}

/// Pin the local CPU oracle (`apply_dehaze`) to raw-core's stage, so the crate's
/// convenience oracle can't silently drift from the canonical math. This also
/// transitively pins `compute_airlight` (the oracle calls the same private
/// `atmospheric_light` it does), localising any future airlight drift here.
#[test]
fn local_oracle_matches_raw_core_stage_within_1e_4() {
    let (w, h) = (128usize, 128usize);
    let input = hazy_image(w, h);
    for &dehaze in &[-100.0_f32, -50.0, 50.0, 100.0] {
        let reference = raw_core_dehaze(&input, w as u32, h as u32, dehaze);
        let mut local = input.clone();
        apply_dehaze(&mut local, w, h, dehaze);
        let (max_diff, _) = max_diff_at(&reference, &local);
        assert!(
            max_diff < 1e-4,
            "dehaze={dehaze}: local oracle vs raw-core stage diff {max_diff} exceeds 1e-4"
        );
    }
}

/// The GLOBAL airlight reduction is the parity-critical sub-stage (A feeds both
/// transmission AND recovery), so we pin it byte-exact against an INDEPENDENT
/// reference selection. `compute_airlight` is raw-core's
/// `sort_unstable_by(partial_cmp descending)` top-N average; here we recompute
/// the same airlight with a DISTINCT selection algorithm — a full `f32::total_cmp`
/// sort accumulated in f64 — and require agreement to f32 round-off. They can
/// only agree if the top-0.1% selection is insensitive to the comparator (no
/// tie-break divergence affecting A), which is exactly the property the
/// full-stage gate above silently depends on. The full-stage gate proves
/// `compute_airlight` matches raw-core's A end-to-end; this localises that A
/// itself is a stable, unambiguous reduction (so a future raw-core refactor that
/// changed the selection would surface HERE, not as a vague 1e-3 stage drift).
#[test]
fn compute_airlight_is_byte_exact_vs_independent_selection() {
    let (w, h) = (128usize, 128usize);
    let input = hazy_image(w, h);
    let a = compute_airlight(&input, w, h);
    eprintln!("airlight A = {a:?}");
    assert!(
        a.iter().all(|v| v.is_finite()),
        "A must be finite, got {a:?}"
    );

    let pixels: Vec<[f32; 3]> = input.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect();
    let dc = independent_dark_channel(&pixels, w, h);
    let n = dc.len();
    let top_n = (n / 1000).max(1);
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&i, &j| dc[j].total_cmp(&dc[i])); // descending, total order
    let mut sum = [0.0f64; 3];
    for &i in &idx[..top_n] {
        sum[0] += pixels[i][0] as f64;
        sum[1] += pixels[i][1] as f64;
        sum[2] += pixels[i][2] as f64;
    }
    let k = top_n as f64;
    let a_ref = [
        (sum[0] / k) as f32,
        (sum[1] / k) as f32,
        (sum[2] / k) as f32,
    ];
    for c in 0..3 {
        assert!(
            (a[c] - a_ref[c]).abs() < 1e-5,
            "airlight ch{c}: compute_airlight {} vs independent selection {} diverge \
             (tie-break sensitivity in the top-N reduction)",
            a[c],
            a_ref[c]
        );
    }
}

/// An independent clamp-to-edge 15×15 dark-channel for the airlight cross-check —
/// deliberately written separately from `super::dark_channel` so the test does
/// not just re-run the code under test.
fn independent_dark_channel(pixels: &[[f32; 3]], w: usize, h: usize) -> Vec<f32> {
    let r = 7i32;
    let (wi, hi) = (w as i32, h as i32);
    let mut out = vec![0.0f32; w * h];
    for y in 0..hi {
        for x in 0..wi {
            let mut m = f32::INFINITY;
            for dy in -r..=r {
                for dx in -r..=r {
                    let ux = (x + dx).clamp(0, wi - 1) as usize;
                    let uy = (y + dy).clamp(0, hi - 1) as usize;
                    let p = pixels[uy * w + ux];
                    let mn = p[0].min(p[1]).min(p[2]);
                    m = m.min(mn);
                }
            }
            out[(y * wi + x) as usize] = m;
        }
    }
    out
}

/// Composition: dehaze behaves as ONE [`Pass`] inside a multi-pass chain. Run
/// `[ExposurePass{0.0}, DehazePass]` — exposure at ev=0 is identity, so the
/// chained result must equal dehaze-alone — AND `[DehazePass, DehazePass]`
/// finishes without a validation error (the scratch buffers a spatial pass
/// allocates per `encode` don't collide across two encodes).
#[test]
fn dehaze_composes_as_one_pass_in_a_chain() {
    use crate::exposure::ExposurePass;
    let ctx = GpuContext::new_blocking();
    let (w, h) = (64usize, 64usize);
    let input = hazy_image(w, h);
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);

    let solo = runner.run_blocking(&[&pass(&input, w, h, 70.0)]);
    let chained = runner.run_blocking(&[&ExposurePass { ev: 0.0 }, &pass(&input, w, h, 70.0)]);
    let (diff, _) = max_diff_at(&solo, &chained);
    assert!(
        diff < 1e-4,
        "dehaze after an identity exposure pass diverged from dehaze-alone by {diff} \
         — the stage does not compose as a clean src→dst Pass"
    );

    let twice = runner.run_blocking(&[&pass(&input, w, h, 70.0), &pass(&input, w, h, 70.0)]);
    assert!(
        twice.iter().all(|v| v.is_finite()),
        "double-dehaze produced non-finite output"
    );
}

/// Pure-black pixels must not yield NaN/Inf via the recovery divide — the t0
/// transmission floor mirrors raw-core. Plant a bright patch so the field isn't
/// flat (and so the airlight is well-defined).
#[test]
fn wgsl_dehaze_handles_pure_black() {
    let ctx = GpuContext::new_blocking();
    let (w, h) = (32usize, 32usize);
    let mut input = vec![0.0f32; w * h * 4];
    for px in input.chunks_exact_mut(4) {
        px[3] = 1.0;
    }
    for y in 4..12 {
        for x in 4..12 {
            let i = (y * w + x) * 4;
            input[i] = 0.9;
            input[i + 1] = 0.88;
            input[i + 2] = 0.86;
        }
    }
    let img = GpuImage::upload(&ctx, &input, w as u32, h as u32);
    let runner = ChainRunner::new(&ctx, &img);
    let gpu = runner.run_blocking(&[&pass(&input, w, h, 100.0)]);
    assert!(
        gpu.iter().all(|v| v.is_finite()),
        "dehaze produced non-finite output"
    );
}
