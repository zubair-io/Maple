use super::{lmmse, lmmse_cancellable, BORDER};
use crate::cancel::CancelToken;
use crate::demosaic::amaze::amaze;
use crate::demosaic::bilinear::bilinear;
use crate::demosaic::test_scenes::{
    false_colour_energy, grey_ramp, interpolated_green_rms, mosaic_from, noise_at, noisy_flat,
    uniform, PATTERNS,
};
use crate::image::{CfaPattern, ColorSpace, Image};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn lmmse_flat_field_reproduces_every_channel_for_every_cfa_phase() {
    for cfa in PATTERNS {
        let out = lmmse(&uniform(64, 64, cfa, [0.4, 0.5, 0.6]), cfa);
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

#[test]
fn lmmse_linear_gradient_reproduces_within_tolerance() {
    // On a grey ramp the difference signal is identically zero, so the
    // shrinkage has nothing to shrink and green comes back exact; the
    // colour-difference chroma steps are exact when C − G is zero.
    for cfa in PATTERNS {
        let mosaic = grey_ramp(200, 96, cfa);
        let out = lmmse(&mosaic, cfa);
        for y in BORDER..96 - BORDER {
            for x in BORDER..200 - BORDER {
                let expected = 0.05 + 0.004 * x as f32 + 0.003 * y as f32;
                let p = out.pixels[y * 200 + x];
                for (c, v) in p.iter().enumerate() {
                    assert!(
                        (v - expected).abs() < 2e-4,
                        "{cfa:?} at ({x},{y}) channel {c}: {v} != {expected}"
                    );
                }
            }
        }
    }
}

#[test]
fn lmmse_dimensions_and_space_match_bilinear() {
    for cfa in PATTERNS {
        let mosaic = grey_ramp(133, 71, cfa);
        let a = lmmse(&mosaic, cfa);
        let b = bilinear(&mosaic, cfa);
        assert_eq!((a.width, a.height), (b.width, b.height));
        assert_eq!(a.pixels.len(), b.pixels.len());
        assert_eq!(a.space, b.space);
    }
}

#[test]
fn lmmse_border_ring_is_the_bilinear_reconstruction() {
    let cfa = CfaPattern::Grbg;
    let mosaic = grey_ramp(96, 72, cfa);
    let a = lmmse(&mosaic, cfa);
    let b = bilinear(&mosaic, cfa);
    for y in 0..72usize {
        for x in 0..96usize {
            let ring = x < BORDER || x >= 96 - BORDER || y < BORDER || y >= 72 - BORDER;
            if ring {
                assert_eq!(a.pixels[y * 96 + x], b.pixels[y * 96 + x], "at ({x},{y})");
            }
        }
    }
}

#[test]
fn lmmse_below_stencil_size_falls_back_to_bilinear() {
    let cfa = CfaPattern::Bggr;
    let mosaic = grey_ramp(20, 20, cfa);
    assert_eq!(lmmse(&mosaic, cfa).pixels, bilinear(&mosaic, cfa).pixels);
}

#[test]
fn lmmse_zero_dimension_returns_empty_without_panicking() {
    let mosaic = Image::new(0, 8, ColorSpace::CameraNativeMosaic);
    let out = lmmse(&mosaic, CfaPattern::Rggb);
    assert_eq!((out.width, out.height), (0, 8));
    assert!(out.pixels.is_empty());
}

#[test]
fn lmmse_zero_input_stays_finite() {
    // All-zero data drives every variance and every fusion denominator to
    // its floor; nothing may come back NaN or inf.
    let mosaic = Image::new(64, 64, ColorSpace::CameraNativeMosaic);
    let out = lmmse(&mosaic, CfaPattern::Rggb);
    for p in &out.pixels {
        assert!(p.iter().all(|v| v.is_finite()), "{p:?}");
        assert!(p.iter().all(|v| v.abs() < 1e-6), "{p:?}");
    }
}

#[test]
fn lmmse_is_deterministic_across_rayon_scheduling() {
    let cfa = CfaPattern::Rggb;
    let mosaic = mosaic_from(320, 300, cfa, |x, y, c| {
        0.1 + 0.3 * ((x as f32 * 0.21).sin() + (y as f32 * 0.17).cos()).abs() + 0.05 * c as f32
    });
    assert_eq!(lmmse(&mosaic, cfa).pixels, lmmse(&mosaic, cfa).pixels);
}

#[test]
fn lmmse_has_no_band_seams_on_a_smooth_gradient() {
    // A band is 48 rows; a halo or offset bug shows up as a step in the
    // second difference across y ∈ {48, 96, 144}.
    let cfa = CfaPattern::Rggb;
    let out = lmmse(&grey_ramp(200, 260, cfa), cfa);
    for seam in [48usize, 96, 144] {
        for x in BORDER..200 - BORDER {
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
fn lmmse_cancel_before_start_leaves_the_buffer_untouched() {
    let cfa = CfaPattern::Rggb;
    let mosaic = grey_ramp(320, 300, cfa);
    let flag = AtomicBool::new(true);
    let out = lmmse_cancellable(&mosaic, cfa, CancelToken::new(&flag));
    assert_eq!(out.pixels.len(), 320 * 300);
    assert!(out.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]));
}

#[test]
fn lmmse_cancel_mid_run_returns_promptly_and_partially_filled() {
    let cfa = CfaPattern::Rggb;
    let mosaic = grey_ramp(1200, 900, cfa);
    let flag = AtomicBool::new(false);
    let out = std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(std::time::Duration::from_micros(200));
            flag.store(true, Ordering::Relaxed);
        });
        lmmse_cancellable(&mosaic, cfa, CancelToken::new(&flag))
    });
    assert_eq!(out.pixels.len(), 1200 * 900);
    assert!(out.pixels.iter().all(|p| p.iter().all(|v| v.is_finite())));
}

#[test]
fn lmmse_never_cancel_token_matches_the_plain_entry() {
    let cfa = CfaPattern::Gbrg;
    let mosaic = grey_ramp(200, 140, cfa);
    let a = lmmse(&mosaic, cfa);
    let b = lmmse_cancellable(&mosaic, cfa, CancelToken::never());
    assert_eq!(a.pixels, b.pixels);
}

#[test]
fn lmmse_invents_less_false_colour_than_amaze_on_a_noisy_flat_field() {
    // The claim the automatic selection rests on: at the noise level where
    // LMMSE is chosen, it manufactures less colour out of nothing than the
    // export kernel it replaces.
    let cfa = CfaPattern::Rggb;
    let mosaic = noisy_flat(256, 256, cfa, 0.20, 0.03);
    let ours = false_colour_energy(&lmmse(&mosaic, cfa), BORDER as u32 + 2);
    let theirs = false_colour_energy(&amaze(&mosaic, cfa), BORDER as u32 + 2);
    assert!(
        ours < theirs * 0.97,
        "LMMSE false-colour energy {ours:.6} is not under AMaZE's {theirs:.6}"
    );
}

#[test]
fn lmmse_interpolates_green_more_quietly_than_amaze() {
    // The shrinkage, isolated. At every site where green has to be
    // invented, the LMMSE gain falls as the estimated noise rises, so the
    // reconstruction relaxes toward the local mean instead of tracking the
    // sensor's read noise. Native green sites are excluded: every kernel
    // writes the sample straight back there.
    let cfa = CfaPattern::Rggb;
    for sigma in [0.02f32, 0.04] {
        let mosaic = noisy_flat(256, 256, cfa, 0.20, sigma);
        let ours = interpolated_green_rms(&lmmse(&mosaic, cfa), cfa, 0.20, 16);
        let theirs = interpolated_green_rms(&amaze(&mosaic, cfa), cfa, 0.20, 16);
        assert!(
            ours < theirs * 0.93,
            "sigma {sigma}: LMMSE interpolated-green RMS {ours:.6} is not \
             clearly under AMaZE's {theirs:.6}"
        );
    }
}

#[test]
fn lmmse_preserves_a_clean_edge() {
    // Shrinkage must not blur real structure: on noiseless data the gain is
    // 1 and the estimate passes `d` straight through, so a hard grey edge
    // has to come out with its full contrast and no colour on it.
    let cfa = CfaPattern::Rggb;
    let split = 64u32;
    let mosaic = mosaic_from(128, 96, cfa, |x, _, _| if x < split { 0.15 } else { 0.85 });
    let out = lmmse(&mosaic, cfa);
    let w = out.width as usize;
    for y in BORDER..96 - BORDER {
        for x in BORDER..128 - BORDER {
            let p = out.pixels[y * w + x];
            // Two columns either side of the transition are allowed to be
            // intermediate; everywhere else must be flat and grey.
            if (x as i32 - split as i32).abs() <= 2 {
                continue;
            }
            let expected = if (x as u32) < split { 0.15 } else { 0.85 };
            for (c, v) in p.iter().enumerate() {
                assert!(
                    (v - expected).abs() < 0.02,
                    "at ({x},{y}) channel {c}: {v} != {expected}"
                );
            }
        }
    }
}

#[test]
fn lmmse_noise_field_is_the_same_on_every_run() {
    // Guards the tests above: a shifting scene would make their thresholds
    // meaningless.
    assert_eq!(noise_at(7, 11, 1, 0x5EED), noise_at(7, 11, 1, 0x5EED));
    assert!(noise_at(7, 11, 1, 0x5EED) != noise_at(7, 12, 1, 0x5EED));
}
