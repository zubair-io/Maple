//! Validation, no-op-guard, and image-property tests for the
//! capture-sharpening stage. Split out of `capture_sharpening.rs` to
//! satisfy the file-size budget (`tools/check-file-budget.sh`); the
//! #1089 parallelism + cancellation tests live in the sibling
//! `cancel_tests.rs`. `super` is `stages::capture_sharpening`.

use super::*;
use crate::stages::blur::gaussian_kernel_1d;

fn build_image(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for y in 0..h {
        for x in 0..w {
            img.pixels[(y * w + x) as usize] = f(x, y);
        }
    }
    img
}

#[test]
fn gaussian_kernel_sums_to_one() {
    for &sigma in &[0.25_f32, 0.5, 0.68, 1.0, 1.5, 2.0, 4.0] {
        let k = gaussian_kernel_1d(sigma);
        let sum: f32 = k.iter().sum();
        assert!(
            (sum - 1.0).abs() < 1e-6,
            "kernel for sigma={sigma} sums to {sum}, expected 1.0"
        );
        // Window size matches ceil(3*sigma).max(1) → length 2*half+1.
        let expected_half = (3.0 * sigma).ceil().max(1.0) as usize;
        assert_eq!(
            k.len(),
            2 * expected_half + 1,
            "kernel size for sigma={sigma}"
        );
        // Symmetry: k[i] == k[len-1-i].
        for i in 0..k.len() / 2 {
            assert!(
                (k[i] - k[k.len() - 1 - i]).abs() < 1e-6,
                "kernel asymmetric at sigma={sigma}, i={i}"
            );
        }
    }
}

#[test]
fn gaussian_kernel_subpixel_sigma_does_not_explode() {
    // ceil(3*0.1) = 1, so kernel has 3 taps. Center is enormously
    // dominant; renormalization should still produce a finite sum-1
    // kernel with all-finite weights.
    let k = gaussian_kernel_1d(0.1);
    assert_eq!(k.len(), 3);
    let sum: f32 = k.iter().sum();
    assert!((sum - 1.0).abs() < 1e-6);
    for &v in &k {
        assert!(v.is_finite() && v >= 0.0);
    }
    // Center weight dominates at sub-pixel sigma (>0.99).
    assert!(k[1] > 0.99, "center weight {} at sigma=0.1 too small", k[1]);
}

/// Bit-exact no-op when `strength == 0.0`. This is the ticket's
/// "off by default must remain bit-identical" assertion at the stage
/// level: a non-trivial synthetic input must come back unchanged.
/// Run on a multi-channel image with a sharp step so the assert
/// catches any accidental side effect of the blur/RL passes (even
/// though we short-circuit before any work runs).
#[test]
fn disabled_at_zero_strength() {
    let mut img = build_image(32, 16, |x, y| {
        let v = if x < 16 { 0.2 } else { 0.8 };
        [v, v * 0.9 + (y as f32) * 1e-3, v * 1.1 - (x as f32) * 1e-4]
    });
    let before = img.pixels.clone();
    apply_capture_sharpening(
        &mut img,
        &CaptureSharpeningParams {
            strength: 0.0,
            ..Default::default()
        },
    );
    assert_eq!(img.pixels, before, "strength=0 must be a bit-exact no-op");
}

#[test]
fn disabled_at_zero_iterations() {
    let mut img = build_image(16, 16, |x, _| {
        let v = x as f32 / 15.0;
        [v, v, v]
    });
    let before = img.pixels.clone();
    apply_capture_sharpening(
        &mut img,
        &CaptureSharpeningParams {
            iterations: 0,
            ..Default::default()
        },
    );
    assert_eq!(img.pixels, before);
}

#[test]
fn disabled_at_zero_sigma() {
    let mut img = build_image(16, 16, |x, _| {
        let v = x as f32 / 15.0;
        [v, v, v]
    });
    let before = img.pixels.clone();
    apply_capture_sharpening(
        &mut img,
        &CaptureSharpeningParams {
            sigma: 0.0,
            ..Default::default()
        },
    );
    assert_eq!(img.pixels, before);
}

#[test]
fn disabled_at_nonfinite_sigma() {
    // Defensive: non-finite sigma must not panic or produce non-finite
    // pixels. Mirrors the helper's `is_finite` guard.
    for sigma in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -1.0] {
        let mut img = build_image(8, 8, |_, _| [0.5, 0.5, 0.5]);
        let before = img.pixels.clone();
        apply_capture_sharpening(
            &mut img,
            &CaptureSharpeningParams {
                sigma,
                ..Default::default()
            },
        );
        assert_eq!(
            img.pixels, before,
            "non-finite/negative sigma {sigma} must be a no-op"
        );
    }
}

/// DoS/OOM hardening: a `pub` caller could in principle hand the stage
/// an absurd sigma. The stage-level ceiling (`MAX_SIGMA_PX_STAGE = 50`)
/// must reject anything above that as a no-op, with no allocation of the
/// `2 * ceil(3 * sigma) + 1` taps the kernel would otherwise demand.
#[test]
fn disabled_at_huge_sigma() {
    for sigma in [50.001_f32, 1e6, 1e9, f32::MAX] {
        let mut img = build_image(8, 8, |_, _| [0.5, 0.5, 0.5]);
        let before = img.pixels.clone();
        apply_capture_sharpening(
            &mut img,
            &CaptureSharpeningParams {
                sigma,
                ..Default::default()
            },
        );
        assert_eq!(
            img.pixels, before,
            "sigma {sigma} above MAX_SIGMA_PX_STAGE must be a no-op"
        );
    }
}

/// `gaussian_kernel_1d` is private but reachable from the convolution
/// path; its own clamp is the last-line safeguard if a future entry
/// point bypasses `apply_capture_sharpening`'s guards. Verify the
/// allocation stays bounded for absurd sigma and the kernel still sums
/// to ~1.0 with all-finite weights.
#[test]
fn gaussian_kernel_1d_clamps_huge_sigma() {
    let max_taps = 2 * (3.0 * MAX_SIGMA_PX_STAGE).ceil() as usize + 1;
    for sigma in [50.0_f32, 100.0, 1e6, 1e9, f32::MAX, f32::INFINITY, f32::NAN] {
        let k = gaussian_kernel_1d(sigma);
        assert!(
            k.len() <= max_taps,
            "kernel for sigma={sigma} expanded to {} taps (max {max_taps})",
            k.len()
        );
        let sum: f32 = k.iter().sum();
        assert!(
            (sum - 1.0).abs() < 1e-5,
            "kernel for sigma={sigma} sums to {sum}, expected 1.0"
        );
        for &v in &k {
            assert!(
                v.is_finite(),
                "kernel for sigma={sigma} has non-finite weight"
            );
        }
    }
}

/// NaN `strength` must short-circuit, not propagate into pixels. Without
/// the `is_finite` guard, the `y_old * (1.0 - blend) + y_new * blend`
/// blend produces NaN output for every non-shadow pixel.
#[test]
fn apply_capture_sharpening_is_noop_on_nan_strength() {
    for strength in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut img = build_image(16, 16, |x, _| {
            let v = x as f32 / 15.0;
            [v, v, v]
        });
        let before = img.pixels.clone();
        apply_capture_sharpening(
            &mut img,
            &CaptureSharpeningParams {
                strength,
                ..Default::default()
            },
        );
        assert_eq!(
            img.pixels, before,
            "non-finite strength {strength} must be a no-op"
        );
        for p in &img.pixels {
            for &v in p.iter() {
                assert!(v.is_finite(), "non-finite pixel from strength={strength}");
            }
        }
    }
}

/// Inf / NaN `highlight_threshold` must short-circuit. The blend math
/// computes `(1.0 - y_old) / (1.0 - hi_thresh)` for highlights — a
/// non-finite `hi_thresh` would emit NaN/Inf into pixels otherwise.
#[test]
fn apply_capture_sharpening_is_noop_on_inf_highlight_threshold() {
    for hi in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut img = build_image(16, 16, |x, _| {
            let v = x as f32 / 15.0;
            [v, v, v]
        });
        let before = img.pixels.clone();
        apply_capture_sharpening(
            &mut img,
            &CaptureSharpeningParams {
                highlight_threshold: hi,
                ..Default::default()
            },
        );
        assert_eq!(
            img.pixels, before,
            "non-finite highlight_threshold {hi} must be a no-op"
        );
        for p in &img.pixels {
            for &v in p.iter() {
                assert!(v.is_finite(), "non-finite pixel from hi_thresh={hi}");
            }
        }
    }
}

/// `highlight_threshold == 1.0` is the divide-by-zero edge: the
/// highlight-fade ramp is `(1.0 - y_old) / (1.0 - hi_thresh)`, so at
/// `hi == 1.0` paired with a `y_old == 1.0` pixel the math is `0/0`.
/// The stage clamps `hi` to `< 1.0` internally, so the run must
/// complete with finite pixels.
#[test]
fn apply_capture_sharpening_handles_highlight_threshold_one() {
    // Mix of values including y_old == 1.0 (the pathological pixel).
    let mut img = build_image(16, 16, |x, _| {
        let v = if x < 8 { 1.0 } else { x as f32 / 15.0 };
        [v, v, v]
    });
    apply_capture_sharpening(
        &mut img,
        &CaptureSharpeningParams {
            highlight_threshold: 1.0,
            ..Default::default()
        },
    );
    for p in &img.pixels {
        for &v in p.iter() {
            assert!(
                v.is_finite(),
                "non-finite pixel with highlight_threshold=1.0: {v}"
            );
            assert!(v < 1.5, "highlight exploded with hi=1.0: {v}");
        }
    }
}

#[test]
fn sharpens_blurry_step_edge() {
    // Make a blurry step edge then sharpen: edge gradient should grow.
    let (w, h) = (64u32, 16u32);
    let mut img = build_image(w, h, |x, _| {
        let v = if x < 28 {
            0.3
        } else if x < 36 {
            let t = (x - 28) as f32 / 8.0;
            0.3 + 0.4 * t
        } else {
            0.7
        };
        [v, v, v]
    });
    let before = img.pixels.clone();
    apply_capture_sharpening(&mut img, &CaptureSharpeningParams::default());

    let edge_grad = |pixels: &[[f32; 3]]| -> f32 {
        let mut m: f32 = 0.0;
        for y in 0..h {
            for x in 1..w {
                let l = pixels[(y * w + x - 1) as usize][0];
                let r = pixels[(y * w + x) as usize][0];
                m = m.max((r - l).abs());
            }
        }
        m
    };
    let g_before = edge_grad(&before);
    let g_after = edge_grad(&img.pixels);
    assert!(
        g_after > g_before,
        "capture sharpening did not enhance edge: before={g_before} after={g_after}"
    );
}

#[test]
fn preserves_flat_regions_within_tolerance() {
    let mut img = build_image(32, 32, |_, _| [0.5, 0.5, 0.5]);
    let before = img.pixels.clone();
    apply_capture_sharpening(&mut img, &CaptureSharpeningParams::default());
    for (a, b) in img.pixels.iter().zip(before.iter()) {
        for c in 0..3 {
            assert!(
                (a[c] - b[c]).abs() < 1e-3,
                "flat region drifted: {:?} vs {:?}",
                a,
                b
            );
        }
    }
}

#[test]
fn near_clipped_highlights_stay_safe() {
    let mut img = build_image(16, 16, |x, _| {
        let v = if x < 8 { 0.999 } else { 0.5 };
        [v, v, v]
    });
    apply_capture_sharpening(&mut img, &CaptureSharpeningParams::default());
    for p in &img.pixels {
        for &v in p.iter() {
            assert!(v.is_finite(), "non-finite output");
            assert!(v < 1.5, "highlight exploded: {v}");
        }
    }
}

/// #320 acceptance: sigma is a continuous f32 parameter now, not an
/// integer radius rounded via `.round()`. Before the fix, `sigma=0.9`,
/// `sigma=1.0`, and `sigma=1.1` all rounded to the same integer radius (1)
/// and produced bit-identical box-blur output — a plateau — then jumped
/// discontinuously at the next integer boundary (`sigma=1.5` rounding up
/// to radius 2).
///
/// Two levels are checked against a fine sigma sweep over the model's
/// declared [0.5, 2.0] range (crossing both old integer boundaries, 1.0
/// and 2.0):
///
/// - The blur primitive (`gaussian_blur_plane_sigma`) is a pure linear
///   diffusion of a point source, so its center-pixel response is
///   analytically monotonic (wider PSF ⇒ strictly less energy retained at
///   the source) — checked exactly.
/// - The full stage (RL deconvolution + highlight fade) is nonlinear, so
///   only bounded-step continuity is checked: no single 0.05-wide step's
///   delta may dwarf its neighbors, which is what a reintroduced
///   plateau-then-jump rounding artefact would produce.
#[test]
fn sigma_sweep_output_varies_continuously() {
    let (w, h) = (25u32, 25u32);
    let center = (12 * w + 12) as usize;

    // Fine sweep from 0.5 to 2.0 in 0.05 steps.
    let sigmas: Vec<f32> = (0..=30).map(|i| 0.5 + i as f32 * 0.05).collect();

    // --- Blur primitive: exact monotonicity -------------------------------
    let mut buf = vec![0.0_f32; (w * h) as usize];
    buf[center] = 1.0;
    let blur_values: Vec<f32> = sigmas
        .iter()
        .map(|&s| gaussian_blur_plane_sigma(&buf, w as usize, h as usize, s)[center])
        .collect();
    for pair in blur_values.windows(2) {
        assert!(
            pair[1] < pair[0],
            "blur primitive is not strictly monotonic in sigma: {} -> {}",
            pair[0],
            pair[1]
        );
    }
    // Explicitly confirm sigma=0.9/1.0/1.1 (the old rounded-to-1 plateau)
    // are three distinct values, not the same bit pattern.
    let b09 = gaussian_blur_plane_sigma(&buf, w as usize, h as usize, 0.9)[center];
    let b10 = gaussian_blur_plane_sigma(&buf, w as usize, h as usize, 1.0)[center];
    let b11 = gaussian_blur_plane_sigma(&buf, w as usize, h as usize, 1.1)[center];
    assert!(
        b09 > b10 && b10 > b11,
        "blur primitive plateaued across the old integer-radius boundary: \
         sigma=0.9 -> {b09}, sigma=1.0 -> {b10}, sigma=1.1 -> {b11}"
    );

    // --- Full stage: bounded-step continuity, no outlier jump -------------
    let sample_at = |sigma: f32| -> f32 {
        let mut img = build_image(w, h, |x, y| {
            let v = if x == 12 && y == 12 { 0.9 } else { 0.05 };
            [v, v, v]
        });
        apply_capture_sharpening(
            &mut img,
            &CaptureSharpeningParams {
                sigma,
                ..CaptureSharpeningParams::default()
            },
        );
        img.pixels[center][0]
    };
    let stage_values: Vec<f32> = sigmas.iter().map(|&s| sample_at(s)).collect();
    for &v in &stage_values {
        assert!(v.is_finite(), "sigma sweep produced a non-finite sample");
    }

    let deltas: Vec<f32> = stage_values.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
    let mean_abs_delta: f32 = deltas.iter().sum::<f32>() / deltas.len() as f32;
    let max_abs_delta = deltas.iter().fold(0.0_f32, |m, &d| m.max(d));

    // No step-function artefact: the maximum single-step delta must not
    // dwarf the average step. Under the old integer-radius approximation,
    // most 0.05-wide steps between the same rounded radius were exactly
    // zero while the step that crossed a rounding boundary carried the
    // entire sweep's total movement — an arbitrarily large ratio relative
    // to the (near-zero) mean. A true continuous sigma path spreads the
    // change roughly evenly; a generous 8x ceiling comfortably tolerates
    // the RL update's nonlinearity while still catching a reintroduced
    // plateau-then-jump pattern.
    assert!(
        max_abs_delta < mean_abs_delta * 8.0,
        "sigma sweep has a step-function outlier: max |delta|={max_abs_delta}, mean |delta|={mean_abs_delta}"
    );

    // Explicitly confirm the old plateau is gone at the integer boundary.
    let v_09 = sample_at(0.9);
    let v_10 = sample_at(1.0);
    let v_11 = sample_at(1.1);
    assert_ne!(v_09, v_10, "sigma=0.9 and sigma=1.0 must differ (no plateau)");
    assert_ne!(v_10, v_11, "sigma=1.0 and sigma=1.1 must differ (no plateau)");
}

#[test]
fn larger_sigma_blurs_more_than_smaller_sigma() {
    // Single bright pixel: a larger sigma must diffuse more energy
    // into the immediate neighbor than a smaller sigma does. This is
    // the property that the integer-radius approximation could not
    // express within `radius==1` — both sigma=0.5 and sigma=0.9
    // rounded to the same integer radius.
    let mut buf = vec![0.0_f32; 21 * 21];
    buf[10 * 21 + 10] = 1.0;

    let small = gaussian_blur_plane_sigma(&buf, 21, 21, 0.5);
    let large = gaussian_blur_plane_sigma(&buf, 21, 21, 0.9);

    // Center retains less energy under the larger blur.
    assert!(
        large[10 * 21 + 10] < small[10 * 21 + 10],
        "larger sigma left more at center: small={}, large={}",
        small[10 * 21 + 10],
        large[10 * 21 + 10]
    );
    // Direct neighbor gains more energy under the larger blur.
    assert!(
        large[10 * 21 + 11] > small[10 * 21 + 11],
        "larger sigma diffused less to neighbor: small={}, large={}",
        small[10 * 21 + 11],
        large[10 * 21 + 11]
    );
}
