use super::{vng4, vng4_cancellable, BORDER};
use crate::cancel::CancelToken;
use crate::demosaic::bilinear::bilinear;
use crate::demosaic::rcd::rcd;
use crate::demosaic::test_scenes::{
    false_colour_energy, grey_ramp, interpolated_green_rms, mosaic_from, noisy_flat, step_edge,
    uniform, PATTERNS,
};
use crate::image::{CfaPattern, ColorSpace, Image};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn vng4_flat_field_reproduces_every_channel_for_every_cfa_phase() {
    for cfa in PATTERNS {
        let out = vng4(&uniform(48, 48, cfa, [0.4, 0.5, 0.6]), cfa);
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
fn vng4_linear_gradient_reproduces_within_tolerance() {
    // Every directional estimate is exact on a linear ramp, so any subset
    // the gradient threshold selects averages to the exact value; the
    // colour-difference chroma steps are exact when C − G is zero
    // everywhere. Only the bilinear border ring (whose mirrored reads fold
    // the ramp back) is approximate.
    for cfa in PATTERNS {
        let mosaic = grey_ramp(200, 96, cfa);
        let out = vng4(&mosaic, cfa);
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
fn vng4_dimensions_and_space_match_bilinear() {
    for cfa in PATTERNS {
        let mosaic = grey_ramp(133, 71, cfa);
        let a = vng4(&mosaic, cfa);
        let b = bilinear(&mosaic, cfa);
        assert_eq!((a.width, a.height), (b.width, b.height));
        assert_eq!(a.pixels.len(), b.pixels.len());
        assert_eq!(a.space, b.space);
    }
}

#[test]
fn vng4_border_ring_is_the_bilinear_reconstruction() {
    let cfa = CfaPattern::Grbg;
    let mosaic = grey_ramp(80, 60, cfa);
    let a = vng4(&mosaic, cfa);
    let b = bilinear(&mosaic, cfa);
    for y in 0..60usize {
        for x in 0..80usize {
            let ring = x < BORDER || x >= 80 - BORDER || y < BORDER || y >= 60 - BORDER;
            if ring {
                assert_eq!(a.pixels[y * 80 + x], b.pixels[y * 80 + x], "at ({x},{y})");
            }
        }
    }
}

#[test]
fn vng4_below_stencil_size_falls_back_to_bilinear() {
    let cfa = CfaPattern::Bggr;
    let mosaic = grey_ramp(12, 12, cfa);
    assert_eq!(vng4(&mosaic, cfa).pixels, bilinear(&mosaic, cfa).pixels);
}

#[test]
fn vng4_zero_dimension_returns_empty_without_panicking() {
    let mosaic = Image::new(0, 8, ColorSpace::CameraNativeMosaic);
    let out = vng4(&mosaic, CfaPattern::Rggb);
    assert_eq!((out.width, out.height), (0, 8));
    assert!(out.pixels.is_empty());
}

#[test]
fn vng4_zero_input_stays_finite() {
    let mosaic = Image::new(64, 64, ColorSpace::CameraNativeMosaic);
    let out = vng4(&mosaic, CfaPattern::Rggb);
    for p in &out.pixels {
        assert!(p.iter().all(|v| v.is_finite()), "{p:?}");
        assert!(p.iter().all(|v| v.abs() < 1e-6), "{p:?}");
    }
}

#[test]
fn vng4_is_deterministic_across_rayon_scheduling() {
    let cfa = CfaPattern::Rggb;
    let mosaic = mosaic_from(320, 300, cfa, |x, y, c| {
        0.1 + 0.3 * ((x as f32 * 0.21).sin() + (y as f32 * 0.17).cos()).abs() + 0.05 * c as f32
    });
    assert_eq!(vng4(&mosaic, cfa).pixels, vng4(&mosaic, cfa).pixels);
}

#[test]
fn vng4_has_no_band_seams_on_a_smooth_gradient() {
    // A band is 64 rows; a halo or offset bug shows up as a step in the
    // second difference across y ∈ {64, 128, 192}.
    let cfa = CfaPattern::Rggb;
    let out = vng4(&grey_ramp(200, 260, cfa), cfa);
    for seam in [64usize, 128, 192] {
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
fn vng4_cancel_before_start_leaves_the_buffer_untouched() {
    let cfa = CfaPattern::Rggb;
    let mosaic = grey_ramp(320, 300, cfa);
    let flag = AtomicBool::new(true);
    let out = vng4_cancellable(&mosaic, cfa, CancelToken::new(&flag));
    assert_eq!(out.pixels.len(), 320 * 300);
    assert!(out.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]));
}

#[test]
fn vng4_cancel_mid_run_returns_promptly_and_partially_filled() {
    let cfa = CfaPattern::Rggb;
    let mosaic = grey_ramp(1200, 900, cfa);
    let flag = AtomicBool::new(false);
    let out = std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(std::time::Duration::from_micros(200));
            flag.store(true, Ordering::Relaxed);
        });
        vng4_cancellable(&mosaic, cfa, CancelToken::new(&flag))
    });
    assert_eq!(out.pixels.len(), 1200 * 900);
    assert!(out.pixels.iter().all(|p| p.iter().all(|v| v.is_finite())));
}

#[test]
fn vng4_never_cancel_token_matches_the_plain_entry() {
    let cfa = CfaPattern::Gbrg;
    let mosaic = grey_ramp(200, 140, cfa);
    let a = vng4(&mosaic, cfa);
    let b = vng4_cancellable(&mosaic, cfa, CancelToken::never());
    assert_eq!(a.pixels, b.pixels);
}

#[test]
fn vng4_invents_less_false_colour_than_rcd_on_a_noisy_flat_field() {
    // The reason this kernel exists. A grey patch buried in noise has no
    // colour in it; whatever chroma comes out was manufactured by the
    // reconstruction, and averaging four directions manufactures less of it
    // than committing to the smoothest one.
    //
    // The margin is a few percent rather than a landslide, and that is the
    // honest size of the effect on a *pure noise* field: a large part of
    // the metric is the sensor's own sampling — a block's red is built from
    // a quarter as many native samples as its green, whichever kernel ran —
    // and no reconstruction can move that term. What the kernel controls is
    // the interpolated part, which
    // `vng4_interpolates_green_more_quietly_than_rcd` measures directly.
    let cfa = CfaPattern::Rggb;
    let mosaic = noisy_flat(256, 256, cfa, 0.20, 0.02);
    let vng_energy = false_colour_energy(&vng4(&mosaic, cfa), BORDER as u32 + 2);
    let rcd_energy = false_colour_energy(&rcd(&mosaic, cfa), BORDER as u32 + 2);
    assert!(
        vng_energy < rcd_energy * 0.97,
        "VNG4 false-colour energy {vng_energy:.6} is not under RCD's {rcd_energy:.6}"
    );
}

#[test]
fn vng4_interpolates_green_more_quietly_than_rcd() {
    // The mechanism, isolated: at the sites where green has to be invented,
    // averaging every direction the threshold accepts rejects more noise
    // than leaning on the smoothest one. Native green sites are excluded —
    // every kernel writes the sample straight back there, so including them
    // would add the same constant to both scores.
    let cfa = CfaPattern::Rggb;
    let mosaic = noisy_flat(256, 256, cfa, 0.20, 0.02);
    let ours = interpolated_green_rms(&vng4(&mosaic, cfa), cfa, 0.20, 16);
    let theirs = interpolated_green_rms(&rcd(&mosaic, cfa), cfa, 0.20, 16);
    assert!(
        ours < theirs * 0.97,
        "VNG4 interpolated-green RMS {ours:.6} is not under RCD's {theirs:.6}"
    );
}

#[test]
fn vng4_edges_stay_grey_relative_to_bilinear() {
    // Not a detail claim — VNG4 is the smooth kernel — but a hard edge must
    // not be *worse* than plain bilinear, which is the zipper floor.
    for vertical in [true, false] {
        let cfa = CfaPattern::Rggb;
        let mosaic = step_edge(96, 96, cfa, vertical, 48);
        let ours = edge_colour_error(&vng4(&mosaic, cfa), vertical, 48, 4);
        let theirs = edge_colour_error(&bilinear(&mosaic, cfa), vertical, 48, 4);
        assert!(
            ours <= theirs,
            "vertical={vertical}: VNG4 edge colour error {ours} exceeds bilinear's {theirs}"
        );
    }
}

/// Largest absolute colour difference (R−G and B−G) within `reach` of a
/// step edge on a grey scene, where the true value is zero everywhere.
fn edge_colour_error(img: &Image, vertical: bool, split: u32, reach: u32) -> f32 {
    let w = img.width;
    let (lo, hi) = (
        split.saturating_sub(reach),
        (split + reach).min(if vertical { w } else { img.height }),
    );
    let mut worst = 0.0f32;
    for y in BORDER as u32..img.height - BORDER as u32 {
        for x in BORDER as u32..w - BORDER as u32 {
            let across = if vertical { x } else { y };
            if across < lo || across >= hi {
                continue;
            }
            let p = img.pixels[(y * w + x) as usize];
            worst = worst.max((p[0] - p[1]).abs()).max((p[2] - p[1]).abs());
        }
    }
    worst
}
