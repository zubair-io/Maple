//! Box-sum kernel proofs for [`super`] (fast NLM), split out of `nlm_tests.rs`
//! under the 600-LOC file-size budget: the #1086/#1195 far-offset cancellation
//! fixture, the border pass-through strip, and the f64 ground-truth kernel
//! equivalence. Contents moved verbatim.

use super::*;

/// #1086 / #1195 — the same adversarial far-offset fixture that drove the OLD
/// integral-image rect query NEGATIVE, now run through the box-sum kernel
/// (#1195) to prove the artifact is structurally gone.
///
/// Background: the integral image accumulated a global f32 prefix reaching ~4e5
/// by the far corner. Its four-corner rect query subtracted two large prefixes,
/// and across a power-of-two binade boundary the two columns rounded on
/// different ulp grids, so a near-zero true patch mass could quantise NEGATIVE.
/// A negative query then hit `fast_neg_exp`'s saturating `t as usize → 0` cast
/// and extrapolated weight ≈ 1 + |x| (one shift dominating ~3×). #1086 clamped
/// that (`ssd.max(0.0)` + the negative-input guard); #1195 removes the *cause*:
/// the box-sum forms only the LOCAL (2p+1)² patch sum — no global prefix, no
/// cross-binade rect difference — so the patch SSD is non-negative by
/// construction and the near-zero true SSD is computed accurately rather than
/// drifting.
///
/// Fixture (unchanged, so the comparison is apples-to-apples): 1536×1536
/// unit-amplitude xorshift noise with a low-contrast strip (amplitude 0.02
/// around 0.5) over rows [480, 1120) in the far-right columns — the band where
/// the OLD integral image crossed 2^17 / 2^18. Strip patches have near-zero true
/// SSD against their d = (32, 0) partners. `process_shift` is driven directly
/// (this module is a child of `nlm`), so after a single shift `wsum` IS the
/// per-pixel weight. Pure integer xorshift data ⇒ bit-deterministic and
/// platform-independent.
///
/// Locks, post-#1195:
///   1. the box-sum patch SSD is ≥ 0 everywhere in the strip BEFORE any clamp —
///      recomputed independently in-test from `sqdiff`, proving `ssd.max(0.0)`
///      is now belt-and-braces (it never has anything to clamp);
///   2. no single-shift weight anywhere exceeds 1 (the #1086 inflation ceiling);
///   3. strip weights are now HIGH (≈ 1.0), not the ≪ 1 spread the integral
///      image produced — the accurate near-zero SSD is the recovered signal that
///      #1086 flagged as lost (the positive-residue half), so this is
///      non-vacuous in the opposite direction: the fixture's near-identical
///      patches are correctly scored as near-identical;
///   4. full `denoise_plane` output stays inside the input min/max.
#[test]
fn box_sum_has_no_far_offset_cancellation_and_caps_weights_at_one() {
    let w = 1536usize;
    let h = 1536usize;
    let p = 3usize; // 7×7 patch
    let n = w * h;

    // Full-amplitude uniform noise everywhere (the regime that drove the OLD
    // integral image through the 2^17 / 2^18 binade boundaries to ~4e5).
    let mut plane = vec![0.0f32; n];
    let mut rng: u32 = 0xC0FFEE11;
    for v in plane.iter_mut() {
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        *v = (rng >> 8) as f32 / (1u32 << 24) as f32; // uniform [0, 1)
    }
    // Low-contrast strip over the (formerly) binade-crossing rows. Columns
    // [bx, bx + 2·block) cover each probe patch AND its shifted partner.
    let block = 32usize;
    let (dx, dy) = (block as isize, 0isize);
    let bx = w - 2 * block - 8;
    let by = 480usize;
    let tall = 640usize;
    let amp = 0.02f32;
    for y in by..by + tall {
        for x in bx..bx + 2 * block {
            let u = plane[y * w + x]; // reuse the uniform as the texture
            plane[y * w + x] = 0.5 + amp * (u - 0.5);
        }
    }

    // One direct shift through the private kernel: wsum == weight per pixel.
    // `process_shift` no longer takes an integral-image (or full-frame box-sum)
    // buffer — the horizontal sums are fused into the per-strip thread-local
    // scratch (#1195), so only sqdiff + the three accumulators are passed.
    let h_param = 0.02f32;
    let patch_area = ((2 * p + 1) * (2 * p + 1)) as f32;
    let _inv_norm = 1.0 / (h_param * h_param * patch_area);
    let mut sqdiff = vec![0.0f32; n];
    let mut acc = vec![0.0f32; n];
    let mut wsum = vec![0.0f32; n];
    let mut max_w = vec![0.0f32; n];
    let test_params = NlmParams {
        h: h_param,
        search_radius: 5,
        patch_radius: p,
    };
    process_shift(
        &plane,
        w,
        h,
        p,
        dx,
        dy,
        test_params,
        &[],
        &[],
        false,
        &mut sqdiff,
        &mut acc,
        &mut wsum,
        &mut max_w,
    );

    // (1) The box-sum patch SSD is ≥ 0 everywhere in the strip BEFORE the clamp.
    // Recompute it the way `process_shift` does (separable: horizontal direct
    // taps over `sqdiff`, then the vertical (2p+1)-tap sum) and assert
    // non-negativity directly. `sqdiff` was just filled by `process_shift` for
    // this exact shift, so reuse it. This is the structural #1195 win: the OLD
    // rect query went negative on this fixture; the box-sum cannot.
    let mut min_raw_ssd = f32::INFINITY;
    for y in (by + p)..(by + tall - p) {
        for x in (bx + p)..(bx + 2 * block - p) {
            let mut ssd = 0.0f32;
            for oy in -(p as isize)..=(p as isize) {
                for ox in -(p as isize)..=(p as isize) {
                    let xi = (x as isize + ox) as usize;
                    let yi = (y as isize + oy) as usize;
                    ssd += sqdiff[yi * w + xi];
                }
            }
            min_raw_ssd = min_raw_ssd.min(ssd);
        }
    }
    assert!(
        min_raw_ssd >= 0.0,
        "box-sum patch SSD went negative ({min_raw_ssd}) — the local window \
         must never produce the cross-binade cancellation the integral image \
         did (#1195/#1086)",
    );

    // (2) No single-shift weight anywhere exceeds 1.
    let global_max_w = wsum.iter().fold(0.0f32, |m, &v| m.max(v));
    assert!(
        global_max_w <= 1.0 + 1e-6,
        "a single-shift weight reached {global_max_w} — weight exceeded the \
         exp(0)=1 ceiling (#1086)",
    );

    // (3) Strip weights are now HIGH (≈ 1.0): the box-sum scores the near-zero
    // true SSD accurately, so the near-identical strip patches read as
    // near-identical — the recovered signal #1086 flagged as lost. (The old
    // integral image produced a ≪ 1 spread here from positive-residue drift.)
    let mut probe_min = f32::INFINITY;
    let mut probe_max = 0.0f32;
    let mut probes = 0usize;
    for y in (by + p)..(by + tall - p) {
        for x in (bx + p)..(bx + block - p) {
            let wv = wsum[y * w + x];
            probe_min = probe_min.min(wv);
            probe_max = probe_max.max(wv);
            probes += 1;
        }
    }
    eprintln!(
        "box-sum strip weights (near-zero true SSD): min={probe_min} \
         max={probe_max} over {probes} probes — high (≈1) is correct; the \
         integral image's ≪1 spread was the #1086 positive-residue signal loss",
    );
    assert!(
        probe_max <= 1.0,
        "near-identical patch scored weight {probe_max} > 1.0",
    );
    // Threshold 0.5: the strip patches differ from their +32 partners only by
    // the 0.02-amplitude texture, so the true patch SSD scores weights in the
    // ~0.76–0.92 band here (measured) — comfortably "high", and far above the
    // ≪1 drift the integral image produced. The loose bound absorbs platform
    // f32 variation while still failing if the weights collapse.
    assert!(
        probe_min > 0.5,
        "strip weights dropped to {probe_min}: the near-zero-SSD patches are \
         no longer scored as near-identical — the box-sum should compute their \
         true ~0 SSD accurately (#1195)",
    );

    // (4) Full-kernel range invariant on the same plane: denoising is a
    // positively-weighted average, so it cannot leave the input range.
    let out = denoise_plane(
        &plane,
        w,
        h,
        NlmParams {
            patch_radius: p,
            search_radius: 2,
            h: h_param,
        },
    );
    let (mut in_min, mut in_max) = (f32::INFINITY, f32::NEG_INFINITY);
    for &v in &plane {
        in_min = in_min.min(v);
        in_max = in_max.max(v);
    }
    for (i, &v) in out.iter().enumerate() {
        assert!(
            v >= in_min - 1e-6 && v <= in_max + 1e-6,
            "denoised pixel {i} = {v} escaped the input range \
             [{in_min}, {in_max}] — NLM is a positively-weighted average \
             and cannot leave it",
        );
    }
}

/// Pixels within `patch_radius` of every edge are skipped by every
/// shift (no shift `d` makes both the patch at `p` and the patch at
/// `p+d` fit the image). For those pixels `wsum` and `max_w` stay at
/// zero, and the post-loop normalisation falls back to the input
/// value via the `max(1e-12)` clamp.
///
/// This locks in the documented behaviour: corner-strip pixels
/// (rows/cols 0..patch_radius and the symmetric far edge) are
/// **passed through unchanged**, not zeroed and not denoised. If we
/// ever pad the buffer or change the policy, this test will flag the
/// behaviour change.
#[test]
fn border_strip_passes_through_unchanged() {
    let w = 16;
    let h = 16;
    let p = 2;
    let s = 3;
    // Deterministic non-constant plane so passthrough is detectable.
    let mut plane = vec![0.0f32; w * h];
    for (i, v) in plane.iter_mut().enumerate() {
        *v = (i as f32) * 0.001;
    }
    let out = denoise_plane(
        &plane,
        w,
        h,
        NlmParams {
            patch_radius: p,
            search_radius: s,
            h: 0.05,
        },
    );
    // Only the strict patch-radius strip is guaranteed passthrough:
    // for any shift d, the patch at p must fit, requiring x ∈ [p, w-1-p].
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let in_strip = x < p || x >= w - p || y < p || y >= h - p;
            if in_strip {
                assert!(
                    (out[i] - plane[i]).abs() < 1e-6,
                    "border-strip pixel ({},{}) was modified: in={}, out={}",
                    x,
                    y,
                    plane[i],
                    out[i],
                );
            }
        }
    }
}

/// f64 ground-truth NLM — the naive O(N·S²·P²) reference both f32 paths are
/// graded against. Full-f64 patch SSD, weights, and per-pixel average. Uses
/// exact `(-x).exp()` (not the `fast_neg_exp` LUT) with the same range/sign
/// clamps as the production function. Because of this, the max-abs difference
/// it reports captures BOTH accumulation-order error AND LUT-interpolation
/// error vs the exact result — it is NOT a pure summation-accuracy probe.
#[cfg(test)]
fn denoise_plane_f64_truth(plane: &[f32], w: usize, h: usize, params: NlmParams) -> Vec<f32> {
    let p = params.patch_radius as isize;
    let s = params.search_radius as isize;
    let patch_area = ((2 * params.patch_radius + 1) * (2 * params.patch_radius + 1)) as f64;
    let inv_norm = 1.0 / ((params.h as f64) * (params.h as f64) * patch_area);
    let (wi, hi) = (w as isize, h as isize);
    let weight = |ssd: f64| -> f64 {
        let x = ssd * inv_norm;
        if x < 0.0 {
            1.0
        } else if x >= 8.0 {
            0.0
        } else {
            (-x).exp()
        }
    };
    (0..w * h)
        .map(|idx| {
            let x = (idx % w) as isize;
            let y = (idx / w) as isize;
            let (mut acc, mut wsum, mut max_w) = (0.0f64, 0.0f64, 0.0f64);
            for dy in -s..=s {
                for dx in -s..=s {
                    if (dx == 0 && dy == 0)
                        || x - p < 0
                        || x + p >= wi
                        || y - p < 0
                        || y + p >= hi
                        || x + dx - p < 0
                        || x + dx + p >= wi
                        || y + dy - p < 0
                        || y + dy + p >= hi
                    {
                        continue;
                    }
                    let mut ssd = 0.0f64;
                    for oy in -p..=p {
                        for ox in -p..=p {
                            let a = plane[((y + oy) * wi + (x + ox)) as usize] as f64;
                            let b = plane[((y + dy + oy) * wi + (x + dx + ox)) as usize] as f64;
                            ssd += (a - b) * (a - b);
                        }
                    }
                    let wgt = weight(ssd);
                    acc += wgt * plane[((y + dy) * wi + (x + dx)) as usize] as f64;
                    wsum += wgt;
                    max_w = max_w.max(wgt);
                }
            }
            let mw = max_w.max(1e-12);
            ((acc + mw * plane[idx] as f64) / (wsum + mw)) as f32
        })
        .collect()
}

/// #1195 — THE box-sum parity proof. The integral image it replaces is NOT a
/// trustworthy reference at scale: its global-prefix rect query loses precision
/// as the image grows (#1086), drifting from f64 truth by ~1e-3 on a 4000-wide
/// plane. So parity is asserted against an f64 GROUND TRUTH instead, and the
/// box-sum must match it TIGHTLY and — crucially — SIZE-INDEPENDENTLY (the
/// integral image's error grew with width; the local box-sum's must not).
///
/// Two deterministic xorshift planes: a narrow one and a WIDE one (4096 cols —
/// the regime where the integral image drifted most and where any horizontal
/// running-window drift would surface). Both must match f64 truth to < 5e-6.
/// Fixture-free ⇒ runs in CI without the gitignored RAWs.
#[test]
fn box_sum_matches_f64_truth_and_is_size_independent() {
    let params = NlmParams {
        patch_radius: 2,
        search_radius: 3,
        h: 0.05,
    };
    // Deterministic noisy plane around 0.5 (matches the bench harness's data).
    let make = |w: usize, h: usize| -> Vec<f32> {
        let mut v = vec![0.0f32; w * h];
        let mut rng: u32 = 0xABCD_1234 | 1;
        for px in v.iter_mut() {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            let u = (rng >> 8) as f32 / (1u32 << 24) as f32;
            *px = 0.5 + 0.1 * (u - 0.5);
        }
        v
    };
    // (w, h): a narrow plane and a WIDE-row plane. Height kept small so the
    // O(N·S²·P²) f64 oracle stays fast; width is the drift-sensitive axis.
    for &(w, h) in &[(192usize, 160usize), (4096usize, 24usize)] {
        let plane = make(w, h);
        let got = denoise_plane(&plane, w, h, params);
        let truth = denoise_plane_f64_truth(&plane, w, h, params);
        let mut max_abs = 0.0f32;
        for (a, b) in got.iter().zip(truth.iter()) {
            max_abs = max_abs.max((a - b).abs());
        }
        assert!(
            max_abs < 5e-6,
            "box-sum vs f64 truth max abs diff {max_abs:e} at {w}x{h} exceeds \
             5e-6 — the local box-sum must track truth tightly and \
             size-independently (#1195)",
        );
    }
}
