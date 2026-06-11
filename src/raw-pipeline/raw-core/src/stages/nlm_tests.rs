//! Unit tests for [`super`] (the fast-NLM kernel). Split out of `nlm.rs`
//! under the 600-LOC file-size budget (#951 added the in-kernel cancellation
//! proof, which pushed the inline module over). Contents moved verbatim; the
//! `#951` `preset_cancel_returns_input_unchanged_before_any_shift` test is the
//! load-bearing proof that the cancel check fires *inside* the kernel.

use super::*;

#[test]
fn constant_plane_unchanged() {
    let w = 32;
    let h = 32;
    let plane = vec![0.5f32; w * h];
    let out = denoise_plane(
        &plane,
        w,
        h,
        NlmParams {
            patch_radius: 2,
            search_radius: 3,
            h: 0.1,
        },
    );
    for &v in &out {
        assert!((v - 0.5).abs() < 1e-5, "constant plane changed: {}", v);
    }
}

#[test]
fn zero_h_is_identity() {
    let w = 16;
    let h = 16;
    let mut plane = vec![0.0f32; w * h];
    for i in 0..plane.len() {
        plane[i] = (i as f32) * 0.001;
    }
    let out = denoise_plane(
        &plane,
        w,
        h,
        NlmParams {
            patch_radius: 2,
            search_radius: 2,
            h: 0.0,
        },
    );
    for i in 0..plane.len() {
        assert_eq!(out[i], plane[i], "h=0 should be identity at {}", i);
    }
}

#[test]
fn noise_stdev_drops_on_flat_patch() {
    let w = 64;
    let h = 64;
    let mut plane = vec![0.0f32; w * h];
    let mut rng_state: u32 = 0x12345678;
    for v in plane.iter_mut() {
        rng_state ^= rng_state << 13;
        rng_state ^= rng_state >> 17;
        rng_state ^= rng_state << 5;
        let u1 = (rng_state as f32 / u32::MAX as f32).max(1e-6);
        rng_state ^= rng_state << 13;
        rng_state ^= rng_state >> 17;
        rng_state ^= rng_state << 5;
        let u2 = rng_state as f32 / u32::MAX as f32;
        let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
        *v = 0.5 + 0.05 * z;
    }
    let input_stdev = stdev(&plane);
    let out = denoise_plane(
        &plane,
        w,
        h,
        NlmParams {
            patch_radius: 3,
            search_radius: 5,
            h: 0.05,
        },
    );
    let output_stdev = stdev(&out);
    assert!(
        output_stdev < input_stdev * 0.5,
        "stdev not reduced: in={} out={}",
        input_stdev,
        output_stdev,
    );
}

fn stdev(v: &[f32]) -> f32 {
    let mean: f32 = v.iter().sum::<f32>() / v.len() as f32;
    let var: f32 = v.iter().map(|&x| (x - mean).powi(2)).sum::<f32>() / v.len() as f32;
    var.sqrt()
}

/// #951 — the load-bearing proof that the cancel check is *inside* the
/// NLM kernel, not just at the develop-stage boundary. A flag pre-set to
/// cancelled makes `denoise_plane_cancellable` bail before the first shift
/// and return the untouched input; a never-cancel run on the same plane
/// denoises it. Fixture-free and deterministic, so it runs (and proves
/// something) in CI without the gitignored RAWs.
#[test]
fn preset_cancel_returns_input_unchanged_before_any_shift() {
    use crate::cancel::CancelToken;
    use std::sync::atomic::{AtomicBool, Ordering};
    let w = 64;
    let h = 64;
    // Deterministic noisy plane (same generator as the stdev test).
    let mut plane = vec![0.0f32; w * h];
    let mut rng: u32 = 0x12345678;
    for v in plane.iter_mut() {
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        let u1 = (rng as f32 / u32::MAX as f32).max(1e-6);
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        let u2 = rng as f32 / u32::MAX as f32;
        let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos();
        *v = 0.5 + 0.05 * z;
    }
    let params = NlmParams {
        patch_radius: 3,
        search_radius: 5,
        h: 0.05,
    };

    // Pre-set cancel ⇒ bails on the first (dx, dy) iteration ⇒ returns
    // the EXACT input (bit-for-bit), proving no shift ran.
    let flag = AtomicBool::new(true);
    let cancelled = denoise_plane_cancellable(&plane, w, h, params, CancelToken::new(&flag));
    assert_eq!(
        cancelled, plane,
        "pre-set cancel must return the untouched input — the in-kernel \
         check did not fire before the first shift",
    );

    // Never-cancel ⇒ the kernel runs and actually denoises (stdev drops),
    // so the cancelled passthrough above is meaningful, not a no-op stage.
    let flag2 = AtomicBool::new(false);
    let ran = denoise_plane_cancellable(&plane, w, h, params, CancelToken::new(&flag2));
    assert!(
        stdev(&ran) < stdev(&plane) * 0.5,
        "never-cancel run should denoise (stdev in={} out={})",
        stdev(&plane),
        stdev(&ran),
    );
    // And the never-cancel cancellable path equals the plain entry
    // (bit-identical), locking the never-cancel default as a no-op.
    let plain = denoise_plane(&plane, w, h, params);
    assert_eq!(ran, plain, "never-cancel must be bit-identical to denoise_plane");
    // Flag never observed as set on the never path.
    assert!(!flag2.load(Ordering::Relaxed));
}

/// `search_radius > image_width` previously caused `process_shift` to
/// index `out_row[x]` for `x in 0..xs_lo` with `xs_lo > w`, panicking
/// on the first negative-dx shift. Clamping `xs_lo`/`xs_hi` to `w`
/// turns the over-wide shift into a fully-zero sqdiff row, which the
/// patch-fit guard at the accumulator stage then early-returns on.
#[test]
fn search_radius_larger_than_width_does_not_panic() {
    let w = 3;
    let h = 10;
    let plane = vec![0.5f32; w * h];
    // search_radius = 5 means dx ranges over [-5, 5], so for dx = -4
    // and dx = -5, (-dx) as usize > w.
    let out = denoise_plane(
        &plane,
        w,
        h,
        NlmParams {
            patch_radius: 1,
            search_radius: 5,
            h: 0.1,
        },
    );
    for &v in &out {
        assert!((v - 0.5).abs() < 1e-5, "constant plane changed: {}", v);
    }
}

/// #1086 — the NLM weight function can never exceed 1.0 for any non-NaN
/// input. (A NaN SSD never reaches it in production: the call site's
/// `ssd.max(0.0)` neutralizes NaN too — Rust's `f32::max` returns the
/// non-NaN operand — so the weight becomes exp(0) = 1.0.)
/// Historically a negative input (f32 cancellation residue from the
/// integral-image rect query, scaled by `inv_norm`) hit the saturating
/// `t as usize → 0` cast and EXTRAPOLATED the first table segment to
/// ≈ 1 + |x| — weights growing linearly in |x| instead of capping at the
/// exp(0) = 1 ceiling. The hardened function returns exactly 1.0 for
/// x < 0 (the correct limit for ssd → 0⁻).
#[test]
fn fast_neg_exp_weight_never_exceeds_one_for_any_input() {
    // Negative inputs: exactly 1.0, never 1 + |x|. Pre-#1086, -4.0 gave
    // ≈ 4.97 and -256.0 gave ≈ 255.
    let negatives = [
        -0.0f32,
        -1e-30,
        -1e-6,
        -0.5,
        -4.0,
        -256.0,
        -1e30,
        f32::NEG_INFINITY,
    ];
    for &x in &negatives {
        assert_eq!(
            fast_neg_exp(x),
            1.0,
            "negative input {x} must clamp to the exp(0)=1 ceiling",
        );
    }
    // Zero is the ceiling itself.
    assert_eq!(fast_neg_exp(0.0), 1.0);
    // Positive sweep across the LUT range and past FAST_EXP_RANGE = 8:
    // bounded to [0, 1], non-increasing, and — inside the table range —
    // within the LUT's linear-interpolation budget (~3e-5 per segment) of
    // hardware exp. Past the range the function documents truncation to 0
    // (drops the ≤ ~3.4e-4 tail).
    let mut prev = 1.0f32;
    for i in 0..=4096 {
        let x = i as f32 * (10.0 / 4096.0);
        let w = fast_neg_exp(x);
        assert!((0.0..=1.0).contains(&w), "weight {w} out of [0,1] at x={x}");
        assert!(
            w <= prev,
            "weight not non-increasing at x={x}: {w} > {prev}"
        );
        if x < FAST_EXP_RANGE {
            assert!(
                (w - (-x).exp()).abs() < 1e-4,
                "weight {w} deviates from exp(-x) at x={x} beyond the LUT budget",
            );
        } else {
            assert_eq!(w, 0.0, "x={x} ≥ FAST_EXP_RANGE must truncate to 0");
        }
        prev = w;
    }
}

/// #1086 — far-offset cancellation: the four-term f32 integral-image rect
/// query can come out NEGATIVE even though the true patch-SSD is ≥ 0 by
/// construction. Within one f32 binade it cannot (all four corners share a
/// uniform ulp grid, so every column-chain step contributes a non-negative
/// whole number of ulps) — but where the integral image crosses a
/// power-of-two boundary, the two query columns cross at DIFFERENT rows
/// (their prefixes differ by the inter-column mass), and inside that window
/// the chains round on different grids: a near-zero true patch mass can
/// quantise to a negative multiple of the finer ulp. A 100MP integral image
/// spans many binades, so such windows are everywhere at full-res
/// refine/export offsets.
///
/// Pre-#1086 a negative query hit `fast_neg_exp`'s saturating
/// `t as usize → 0` cast and EXTRAPOLATED the first table segment to weight
/// ≈ 1 + |ssd·inv_norm|: on this very fixture, 167 single-shift weights
/// exceeded 1, peaking at 3.37 — one shift dominating the average ~3×.
///
/// Fixture: 1536×1536 unit-amplitude xorshift noise (integral mass ~0.167
/// per pixel, reaching ~4e5 by the far corner) with a low-contrast strip
/// (amplitude 0.02 around 0.5) in the far-right columns spanning rows
/// [480, 1120) — the band where the integral image crosses the 2^17 and
/// 2^18 binades. Strip patches have near-zero true SSD against their
/// d = (32, 0) partners, and the binade-crossing windows supply the
/// mixed-grid rounding. `process_shift` is driven directly (this module is
/// a child of `nlm`), so after a single shift `wsum` IS the per-pixel
/// weight.
///
/// Locks, post-#1086:
///   1. no weight anywhere exceeds 1 (+1e-6 slack) — red on the old kernel;
///   2. ≥ 1 strip weight is EXACTLY 1.0, proving the ≤0-query clamp path
///      actually fired (the fixture is non-vacuous);
///   3. full `denoise_plane` output stays inside the input min/max — a
///      positively-weighted average cannot leave the range.
///
/// The positive-residue side (near-identical patches scoring weights ≪ 1,
/// visible in the eprintln spread) is the signal-loss half of #1086; that
/// needs the per-shift sliding box-sum and is deferred to #1089.
///
/// The fixture DATA is pure integer arithmetic (xorshift) ⇒ bit-deterministic
/// and platform-independent, including the sign of every cancellation residue.
/// (The weight LUT itself is seeded from , like production.)
#[test]
fn far_offset_cancellation_cannot_inflate_weights_beyond_one() {
    let w = 1536usize;
    let h = 1536usize;
    let p = 3usize; // 7×7 patch
    let n = w * h;

    // Full-amplitude uniform noise everywhere: drives the integral image
    // through the 2^17 / 2^18 binade boundaries on its way to ~4e5.
    let mut plane = vec![0.0f32; n];
    let mut rng: u32 = 0xC0FFEE11;
    for v in plane.iter_mut() {
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        *v = (rng >> 8) as f32 / (1u32 << 24) as f32; // uniform [0, 1)
    }
    // Low-contrast strip over the binade-crossing rows. Columns
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
    let h_param = 0.02f32;
    let patch_area = ((2 * p + 1) * (2 * p + 1)) as f32;
    let inv_norm = 1.0 / (h_param * h_param * patch_area);
    let (iw, ih) = (w + 1, h + 1);
    let mut sqdiff = vec![0.0f32; n];
    let mut ii = vec![0.0f32; iw * ih];
    let mut acc = vec![0.0f32; n];
    let mut wsum = vec![0.0f32; n];
    let mut max_w = vec![0.0f32; n];
    process_shift(
        &plane,
        w,
        h,
        p,
        dx,
        dy,
        inv_norm,
        &mut sqdiff,
        &mut ii,
        &mut acc,
        &mut wsum,
        &mut max_w,
    );

    // (1) No single-shift weight anywhere exceeds 1.
    let global_max_w = wsum.iter().fold(0.0f32, |m, &v| m.max(v));
    assert!(
        global_max_w <= 1.0 + 1e-6,
        "a single-shift weight reached {global_max_w} — negative-SSD \
         cancellation is inflating weights past the exp(0)=1 ceiling (#1086)",
    );

    // (2) Non-vacuity: strip patches whose query cancelled to ≤ 0 clamp to
    // weight EXACTLY 1.0 (ssd.max(0.0) → fast_neg_exp(0) → table[0]).
    let mut exact_ones = 0usize;
    let mut probe_min = f32::INFINITY;
    let mut probe_max = 0.0f32;
    let mut probes = 0usize;
    for y in (by + p)..(by + tall - p) {
        for x in (bx + p)..(bx + block - p) {
            let wv = wsum[y * w + x];
            probe_min = probe_min.min(wv);
            probe_max = probe_max.max(wv);
            if wv == 1.0 {
                exact_ones += 1;
            }
            probes += 1;
        }
    }
    eprintln!(
        "strip weights (near-zero true SSD): min={probe_min} max={probe_max} \
         exact-1.0 count={exact_ones}/{probes} — the min ≪ 1 spread is the \
         #1089 positive-residue signal loss",
    );
    assert!(
        exact_ones > 0,
        "no strip weight hit the exact-1.0 clamp — the fixture no longer \
         exercises the negative-cancellation path; rebuild it",
    );
    assert!(
        probe_max <= 1.0,
        "near-identical patch scored weight {probe_max} > 1.0",
    );

    // (3) Full-kernel range invariant on the same plane: denoising is a
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
                    x, y, plane[i], out[i],
                );
            }
        }
    }
}
