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
