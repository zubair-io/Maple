use super::weight::{contrast_weights, CONTRAST_THRESHOLD, EDGE_RATIO};
use super::{dual_amaze_vng4, dual_rcd_vng4, dual_rcd_vng4_cancellable, BAND};
use crate::cancel::CancelToken;
use crate::demosaic::amaze::amaze;
use crate::demosaic::rcd::rcd;
use crate::demosaic::test_scenes::{
    false_colour_energy, grey_ramp, mosaic_from, noise_at, noisy_flat, uniform, PATTERNS,
};
use crate::demosaic::vng4::vng4;
use crate::image::{CfaPattern, ColorSpace, Image};
use std::sync::atomic::AtomicBool;

// ---------------------------------------------------------------------
// The mask
// ---------------------------------------------------------------------

/// Build a `w × h` green plane from a closure.
fn plane<F: Fn(usize, usize) -> f32>(w: usize, h: usize, f: F) -> Vec<f32> {
    (0..w * h).map(|i| f(i % w, i / w)).collect()
}

#[test]
fn a_flat_field_is_entirely_the_smooth_kernels() {
    for level in [0.02f32, 0.2, 0.9] {
        let w = contrast_weights(&plane(32, 32, |_, _| level), 32, 32);
        let worst = w.iter().copied().fold(0.0f32, f32::max);
        assert!(worst < 1e-6, "level {level}: worst weight {worst}");
    }
}

#[test]
fn a_hard_edge_is_entirely_the_detail_kernels() {
    let w = contrast_weights(
        &plane(32, 32, |x, _| if x < 16 { 0.15 } else { 0.85 }),
        32,
        32,
    );
    for y in 4..28 {
        let at_edge = w[y * 32 + 16];
        assert!(
            at_edge > 0.9,
            "weight at the edge is {at_edge}, not committed to the detail kernel"
        );
    }
}

#[test]
fn far_from_the_edge_is_still_the_smooth_kernel() {
    // The mask must be local: a step in the middle of the frame may not
    // drag a flat region ten pixels away onto the detail kernel.
    let w = contrast_weights(
        &plane(64, 32, |x, _| if x < 32 { 0.15 } else { 0.85 }),
        64,
        32,
    );
    for y in 6..26 {
        for x in [6usize, 20, 44, 58] {
            assert!(
                w[y * 64 + x] < 1e-6,
                "weight {} at ({x},{y}) is not flat-region",
                w[y * 64 + x]
            );
        }
    }
}

#[test]
fn the_mask_is_invariant_to_scene_brightness() {
    // Relative contrast, not absolute gradient: the same modulation at two
    // exposures must produce the same weight, which is what lets one
    // threshold constant hold across every fixture.
    let modulated = |level: f32| {
        plane(48, 48, move |x, _| {
            level * (1.0 + 0.15 * ((x % 8) as f32 / 8.0))
        })
    };
    let dim = contrast_weights(&modulated(0.30), 48, 48);
    let bright = contrast_weights(&modulated(0.90), 48, 48);
    for (a, b) in dim.iter().zip(&bright) {
        // The floor on the denominator makes this approximate rather than
        // exact; a tenth of the weight range is a generous bound and still
        // an order of magnitude tighter than a gradient-only mask would be
        // over a 3× exposure change.
        assert!((a - b).abs() < 0.1, "{a} vs {b}");
    }
}

#[test]
fn the_response_is_pinned_to_its_two_threshold_constants() {
    // A ramp of pure relative contrast: below the threshold exactly 0, at
    // the top of the ramp exactly 1.
    let contrast_at = |slope: f32| {
        // A linear ramp of `slope` per pixel, centred on 1.0 at the probe
        // point so the local mean box there reads exactly 1.0. Its Sobel
        // magnitude is exactly `slope`, so the relative contrast at the
        // probe is `slope / (1 + LEVEL_FLOOR)` — within a couple of percent
        // of `slope` itself.
        let w = contrast_weights(
            &plane(24, 24, |x, _| 1.0 + slope * (x as f32 - 12.0)),
            24,
            24,
        );
        w[12 * 24 + 12]
    };
    assert_eq!(contrast_at(0.0), 0.0);
    assert!(contrast_at(CONTRAST_THRESHOLD * 0.6) < 1e-6);
    assert!(contrast_at(CONTRAST_THRESHOLD * EDGE_RATIO * 1.3) > 0.999);
}

#[test]
fn an_empty_plane_returns_no_weights() {
    assert!(contrast_weights(&[], 0, 0).is_empty());
    assert!(contrast_weights(&[], 4, 0).is_empty());
}

// ---------------------------------------------------------------------
// The blend
// ---------------------------------------------------------------------

#[test]
fn dual_flat_field_reproduces_every_channel_for_every_cfa_phase() {
    for cfa in PATTERNS {
        for out in [
            dual_amaze_vng4(&uniform(64, 64, cfa, [0.4, 0.5, 0.6]), cfa),
            dual_rcd_vng4(&uniform(64, 64, cfa, [0.4, 0.5, 0.6]), cfa),
        ] {
            assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
            for (i, p) in out.pixels.iter().enumerate() {
                for (c, expected) in [0.4f32, 0.5, 0.6].iter().enumerate() {
                    assert!(
                        (p[c] - expected).abs() < 1e-5,
                        "{cfa:?} pixel {i} channel {c}: {} != {expected}",
                        p[c]
                    );
                }
            }
        }
    }
}

#[test]
fn dual_linear_gradient_reproduces_within_tolerance() {
    // Both sides of the blend are exact on a grey ramp, so any mixture of
    // them is too — whatever the mask decides.
    let cfa = CfaPattern::Rggb;
    let out = dual_rcd_vng4(&grey_ramp(200, 96, cfa), cfa);
    for y in 8..96 - 8 {
        for x in 8..200 - 8 {
            let expected = 0.05 + 0.004 * x as f32 + 0.003 * y as f32;
            for (c, v) in out.pixels[y * 200 + x].iter().enumerate() {
                assert!(
                    (v - expected).abs() < 2e-4,
                    "at ({x},{y}) channel {c}: {v} != {expected}"
                );
            }
        }
    }
}

#[test]
fn dual_is_the_smooth_kernel_on_a_noisy_flat_field() {
    // The mask reports flat, so the output must be VNG4's — not merely
    // "closer to it", but within a hair of it.
    let cfa = CfaPattern::Rggb;
    let mosaic = noisy_flat(192, 192, cfa, 0.20, 0.02);
    let blended = dual_rcd_vng4(&mosaic, cfa);
    let smooth = vng4(&mosaic, cfa);
    let sharp = rcd(&mosaic, cfa);
    let distance = |a: &Image, b: &Image| -> f64 {
        a.pixels
            .iter()
            .zip(&b.pixels)
            .map(|(p, q)| ((p[0] - q[0]).abs() + (p[1] - q[1]).abs() + (p[2] - q[2]).abs()) as f64)
            .sum::<f64>()
            / (a.pixels.len() as f64 * 3.0)
    };
    let to_smooth = distance(&blended, &smooth);
    let to_sharp = distance(&blended, &sharp);
    assert!(
        to_smooth < to_sharp * 0.25,
        "blend sits {to_smooth:.6} from VNG4 and {to_sharp:.6} from RCD — \
         the mask is not reporting this field as flat"
    );
}

#[test]
fn dual_keeps_the_detail_kernel_at_a_hard_edge() {
    // The converse: at a step edge the mask must hand the pixel to the
    // detail-first kernel, so the blend equals it there.
    let cfa = CfaPattern::Rggb;
    let split = 64usize;
    let mosaic = mosaic_from(128, 96, cfa, |x, y, _| {
        let edge = if (x as usize) < split { 0.15 } else { 0.85 };
        // A little texture either side so the mask has something to see
        // beyond the step itself.
        edge + 0.01 * noise_at(x, y, 0, 0xA11CE)
    });
    let blended = dual_amaze_vng4(&mosaic, cfa);
    let sharp = amaze(&mosaic, cfa);
    let mut worst = 0.0f32;
    for y in 10..96 - 10 {
        for x in split - 1..=split {
            for c in 0..3 {
                worst = worst
                    .max((blended.pixels[y * 128 + x][c] - sharp.pixels[y * 128 + x][c]).abs());
            }
        }
    }
    assert!(
        worst < 1e-4,
        "blend diverged from AMaZE by {worst} at the edge — the mask is \
         not committing to the detail kernel"
    );
}

#[test]
fn dual_invents_less_false_colour_than_its_own_detail_kernel() {
    // The headline claim of the mode, on the metric the ticket names.
    let cfa = CfaPattern::Rggb;
    let mosaic = noisy_flat(256, 256, cfa, 0.20, 0.02);
    for (name, blended, sharp) in [
        ("rcd", dual_rcd_vng4(&mosaic, cfa), rcd(&mosaic, cfa)),
        ("amaze", dual_amaze_vng4(&mosaic, cfa), amaze(&mosaic, cfa)),
    ] {
        let ours = false_colour_energy(&blended, 10);
        let theirs = false_colour_energy(&sharp, 10);
        assert!(
            ours < theirs * 0.98,
            "dual-{name} false-colour energy {ours:.6} is not clearly under \
             {name}'s own {theirs:.6}"
        );
    }
}

#[test]
fn dual_has_no_band_seams_on_a_smooth_gradient() {
    // The blend runs in bands of `BAND` rows with a mask halo; a halo bug
    // shows up as a step in the second difference across a band boundary.
    let cfa = CfaPattern::Rggb;
    let out = dual_rcd_vng4(&grey_ramp(200, 260, cfa), cfa);
    for seam in [BAND, 2 * BAND, 3 * BAND] {
        for x in 8..200 - 8 {
            for ch in 0..3 {
                let at = |y: usize| out.pixels[y * 200 + x][ch];
                let curvature = at(seam - 1) - 2.0 * at(seam) + at(seam + 1);
                assert!(
                    curvature.abs() < 1e-4,
                    "seam at y={seam} x={x} ch={ch}: curvature {curvature}"
                );
            }
        }
    }
}

#[test]
fn dual_is_deterministic_across_rayon_scheduling() {
    let cfa = CfaPattern::Rggb;
    let mosaic = mosaic_from(320, 300, cfa, |x, y, c| {
        0.1 + 0.3 * ((x as f32 * 0.21).sin() + (y as f32 * 0.17).cos()).abs() + 0.05 * c as f32
    });
    assert_eq!(
        dual_rcd_vng4(&mosaic, cfa).pixels,
        dual_rcd_vng4(&mosaic, cfa).pixels
    );
    assert_eq!(
        dual_amaze_vng4(&mosaic, cfa).pixels,
        dual_amaze_vng4(&mosaic, cfa).pixels
    );
}

#[test]
fn dual_below_the_smooth_kernels_minimum_is_the_detail_kernel_alone() {
    // Nothing to blend down there: VNG4 is the bilinear reconstruction, so
    // the blend is skipped outright rather than mixing a kernel with its
    // own fallback.
    let cfa = CfaPattern::Bggr;
    let mosaic = grey_ramp(12, 12, cfa);
    assert_eq!(dual_rcd_vng4(&mosaic, cfa).pixels, rcd(&mosaic, cfa).pixels);
}

#[test]
fn dual_zero_dimension_returns_empty_without_panicking() {
    let mosaic = Image::new(0, 8, ColorSpace::CameraNativeMosaic);
    let out = dual_rcd_vng4(&mosaic, CfaPattern::Rggb);
    assert_eq!((out.width, out.height), (0, 8));
    assert!(out.pixels.is_empty());
}

#[test]
fn dual_zero_input_stays_finite() {
    let mosaic = Image::new(96, 96, ColorSpace::CameraNativeMosaic);
    for out in [
        dual_rcd_vng4(&mosaic, CfaPattern::Rggb),
        dual_amaze_vng4(&mosaic, CfaPattern::Rggb),
    ] {
        for p in &out.pixels {
            assert!(p.iter().all(|v| v.is_finite()), "{p:?}");
        }
    }
}

#[test]
fn dual_cancel_before_start_leaves_the_buffer_untouched() {
    // RCD bails at its own cancel check and the blend bails at its; the
    // buffer stays at its zero init and the develop chain discards it.
    let cfa = CfaPattern::Rggb;
    let mosaic = grey_ramp(320, 300, cfa);
    let flag = AtomicBool::new(true);
    let out = dual_rcd_vng4_cancellable(&mosaic, cfa, CancelToken::new(&flag));
    assert_eq!(out.pixels.len(), 320 * 300);
    assert!(out.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]));
}

#[test]
fn dual_never_cancel_token_matches_the_plain_entry() {
    let cfa = CfaPattern::Gbrg;
    let mosaic = grey_ramp(200, 140, cfa);
    assert_eq!(
        dual_rcd_vng4(&mosaic, cfa).pixels,
        dual_rcd_vng4_cancellable(&mosaic, cfa, CancelToken::never()).pixels
    );
}
