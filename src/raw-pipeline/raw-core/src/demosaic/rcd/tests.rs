use super::{rcd, rcd_cancellable, BORDER};
use crate::cancel::CancelToken;
use crate::demosaic::bilinear::bilinear;
use crate::image::{CfaPattern, ColorSpace, Image};
use std::sync::atomic::{AtomicBool, Ordering};

const PATTERNS: [CfaPattern; 4] = [
    CfaPattern::Rggb,
    CfaPattern::Bggr,
    CfaPattern::Grbg,
    CfaPattern::Gbrg,
];

/// Build a Bayer mosaic whose scene value at `(x, y)` for channel `c` is
/// `scene(x, y, c)`; only the CFA-selected channel is populated, matching
/// the `sensor_linearize` contract.
fn mosaic_from<F>(w: u32, h: u32, cfa: CfaPattern, scene: F) -> Image
where
    F: Fn(u32, u32, usize) -> f32,
{
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            img.pixels[(y * w + x) as usize][c] = scene(x, y, c);
        }
    }
    img
}

fn uniform(w: u32, h: u32, cfa: CfaPattern, rgb: [f32; 3]) -> Image {
    mosaic_from(w, h, cfa, |_, _, c| rgb[c])
}

/// Grey ramp: every channel carries the same linear function of `x` and
/// `y`, so a correct reconstruction is exact everywhere.
fn grey_ramp(w: u32, h: u32, cfa: CfaPattern) -> Image {
    mosaic_from(w, h, cfa, |x, y, _| {
        0.05 + 0.004 * x as f32 + 0.003 * y as f32
    })
}

/// A hard step edge. `vertical` puts the edge at column `split` (so the
/// scene varies along x); otherwise it is at row `split`.
fn step_edge(w: u32, h: u32, cfa: CfaPattern, vertical: bool, split: u32) -> Image {
    mosaic_from(w, h, cfa, |x, y, _| {
        let across = if vertical { x } else { y };
        if across < split {
            0.15
        } else {
            0.85
        }
    })
}

/// Largest absolute colour difference (R−G and B−G) over the pixels within
/// `reach` columns/rows of a step edge. On a grey scene the true value is
/// zero everywhere, so this is exactly the zipper / colour-fringe metric.
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

#[test]
fn rcd_flat_field_reproduces_every_channel_for_every_cfa_phase() {
    for cfa in PATTERNS {
        let out = rcd(&uniform(48, 48, cfa, [0.4, 0.5, 0.6]), cfa);
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
fn rcd_linear_gradient_reproduces_within_tolerance() {
    // Ratio transport is exact on a grey ramp, and the colour-difference
    // chroma steps are exact when C − G is zero everywhere; only the
    // bilinear border ring (whose mirrored reads fold the ramp back) is
    // approximate, so the interior is checked to f32 precision.
    for cfa in PATTERNS {
        let mosaic = grey_ramp(200, 96, cfa);
        let out = rcd(&mosaic, cfa);
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
fn rcd_vertical_edge_zippers_less_than_bilinear() {
    let cfa = CfaPattern::Rggb;
    let mosaic = step_edge(96, 96, cfa, true, 48);
    let rcd_err = edge_colour_error(&rcd(&mosaic, cfa), true, 48, 4);
    let bilinear_err = edge_colour_error(&bilinear(&mosaic, cfa), true, 48, 4);
    assert!(
        rcd_err < bilinear_err * 0.5,
        "RCD max colour error {rcd_err} is not clearly under bilinear's {bilinear_err}"
    );
}

#[test]
fn rcd_horizontal_edge_zippers_less_than_bilinear() {
    let cfa = CfaPattern::Rggb;
    let mosaic = step_edge(96, 96, cfa, false, 48);
    let rcd_err = edge_colour_error(&rcd(&mosaic, cfa), false, 48, 4);
    let bilinear_err = edge_colour_error(&bilinear(&mosaic, cfa), false, 48, 4);
    assert!(
        rcd_err < bilinear_err * 0.5,
        "RCD max colour error {rcd_err} is not clearly under bilinear's {bilinear_err}"
    );
}

#[test]
fn rcd_dimensions_and_space_match_bilinear() {
    for cfa in PATTERNS {
        let mosaic = grey_ramp(133, 71, cfa);
        let a = rcd(&mosaic, cfa);
        let b = bilinear(&mosaic, cfa);
        assert_eq!((a.width, a.height), (b.width, b.height));
        assert_eq!(a.pixels.len(), b.pixels.len());
        assert_eq!(a.space, b.space);
    }
}

#[test]
fn rcd_border_ring_is_the_bilinear_reconstruction() {
    // The ring is bilinear by design; this pins that it is *exactly* so,
    // which is what makes the kernel's fallback story checkable.
    let cfa = CfaPattern::Grbg;
    let mosaic = grey_ramp(80, 60, cfa);
    let a = rcd(&mosaic, cfa);
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
fn rcd_below_stencil_size_falls_back_to_bilinear() {
    // 12 px is one short of `MIN_DIM`; every pixel must equal bilinear's.
    let cfa = CfaPattern::Bggr;
    let mosaic = grey_ramp(12, 12, cfa);
    let a = rcd(&mosaic, cfa);
    let b = bilinear(&mosaic, cfa);
    assert_eq!(a.pixels, b.pixels);
}

#[test]
fn rcd_zero_dimension_returns_empty_without_panicking() {
    let mosaic = Image::new(0, 8, ColorSpace::CameraNativeMosaic);
    let out = rcd(&mosaic, CfaPattern::Rggb);
    assert_eq!((out.width, out.height), (0, 8));
    assert!(out.pixels.is_empty());
}

#[test]
fn rcd_zero_input_stays_finite() {
    // All-zero data drives every ratio and weight denominator to its floor;
    // nothing may come back NaN or inf.
    let mosaic = Image::new(64, 64, ColorSpace::CameraNativeMosaic);
    let out = rcd(&mosaic, CfaPattern::Rggb);
    for p in &out.pixels {
        assert!(
            p[0].is_finite() && p[1].is_finite() && p[2].is_finite(),
            "{p:?}"
        );
        assert!(
            p[0].abs() < 1e-6 && p[1].abs() < 1e-6 && p[2].abs() < 1e-6,
            "{p:?}"
        );
    }
}

#[test]
fn rcd_is_deterministic_across_rayon_scheduling() {
    // Multi-band, multi-thread: bands own disjoint rows and read only the
    // shared input, so two runs must agree bit for bit.
    let cfa = CfaPattern::Rggb;
    let mosaic = mosaic_from(320, 300, cfa, |x, y, c| {
        0.1 + 0.3 * ((x as f32 * 0.21).sin() + (y as f32 * 0.17).cos()).abs() + 0.05 * c as f32
    });
    let a = rcd(&mosaic, cfa);
    let b = rcd(&mosaic, cfa);
    assert_eq!(a.pixels, b.pixels);
}

#[test]
fn rcd_has_no_band_seams_on_a_smooth_gradient() {
    // A band is 64 rows; a halo or offset bug shows up as a step in the
    // second difference across y ∈ {64, 128, 192}.
    let cfa = CfaPattern::Rggb;
    let mosaic = grey_ramp(200, 260, cfa);
    let out = rcd(&mosaic, cfa);
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
fn rcd_cancel_before_start_leaves_the_buffer_untouched() {
    let cfa = CfaPattern::Rggb;
    let mosaic = grey_ramp(320, 300, cfa);
    let flag = AtomicBool::new(true);
    let out = rcd_cancellable(&mosaic, cfa, CancelToken::new(&flag));
    // Every band closure bails at its cancel check, so the whole buffer is
    // still at its zero init — the develop chain discards it right after.
    assert_eq!(out.pixels.len(), 320 * 300);
    assert!(out.pixels.iter().all(|p| *p == [0.0, 0.0, 0.0]));
}

#[test]
fn rcd_cancel_mid_run_returns_promptly_and_partially_filled() {
    // Flip the flag from another thread once the kernel is under way: the
    // call must return (no hang, no panic) and the result must be
    // recognisably incomplete rather than a full render.
    let cfa = CfaPattern::Rggb;
    let mosaic = grey_ramp(1200, 900, cfa);
    let flag = AtomicBool::new(false);
    let out = std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(std::time::Duration::from_micros(200));
            flag.store(true, Ordering::Relaxed);
        });
        rcd_cancellable(&mosaic, cfa, CancelToken::new(&flag))
    });
    assert_eq!(out.pixels.len(), 1200 * 900);
    assert!(out.pixels.iter().all(|p| p.iter().all(|v| v.is_finite())));
}

#[test]
fn rcd_never_cancel_token_matches_the_plain_entry() {
    let cfa = CfaPattern::Gbrg;
    let mosaic = grey_ramp(200, 140, cfa);
    let a = rcd(&mosaic, cfa);
    let b = rcd_cancellable(&mosaic, cfa, CancelToken::never());
    assert_eq!(a.pixels, b.pixels);
}

#[test]
fn rcd_on_an_even_aligned_crop_matches_the_same_region_of_the_full_frame() {
    // The tile path demosaics a padded crop and trims the pad away, so a
    // crop's interior must reconstruct exactly like the same region of the
    // full frame. The kernel is a local stencil on an even-aligned origin,
    // so this holds everywhere outside the crop's own bilinear ring.
    let cfa = CfaPattern::Rggb;
    let scene = |x: u32, y: u32, c: usize| {
        0.1 + 0.35 * ((x as f32 * 0.19).sin() + (y as f32 * 0.23).cos()).abs() + 0.06 * c as f32
    };
    let full = mosaic_from(320, 288, cfa, scene);
    let (ox, oy, cw, ch) = (48usize, 48usize, 160usize, 144usize);
    let crop = mosaic_from(cw as u32, ch as u32, cfa, |x, y, c| {
        scene(x + ox as u32, y + oy as u32, c)
    });
    let a = rcd(&full, cfa);
    let b = rcd(&crop, cfa);
    let mut worst = 0.0f32;
    for y in BORDER..ch - BORDER {
        for x in BORDER..cw - BORDER {
            let pa = a.pixels[(y + oy) * 320 + (x + ox)];
            let pb = b.pixels[y * cw + x];
            for c in 0..3 {
                worst = worst.max((pa[c] - pb[c]).abs());
            }
        }
    }
    assert!(worst < 1e-6, "crop diverged from the full frame by {worst}");
}

#[test]
fn rcd_saturated_patch_edges_do_not_overshoot_negative() {
    // The colour-difference chroma steps interpolate `C − G` and add it to
    // the site's green, which extrapolates wildly across a hard edge into a
    // patch whose green is near zero. Before the `no_new_extrema` bound this
    // reached −0.21 on non-negative input, and the develop chain's pre-DCP
    // stages clipped it to a flat zero — which is how it first showed up, as
    // a 100× blow-out of the tile-vs-live parity ceiling.
    //
    // Saturated patches on a dark guard, the shape of the synthetic colour
    // chart: each 24-px patch lights one channel and zeroes the others.
    let cfa = CfaPattern::Rggb;
    let mosaic = mosaic_from(192, 192, cfa, |x, y, c| {
        let guard = x % 32 >= 24 || y % 32 >= 24;
        if guard {
            return 0.02;
        }
        let lit = ((x / 32) + (y / 32)) as usize % 3;
        if c == lit {
            0.9
        } else {
            0.0
        }
    });
    let out = rcd(&mosaic, cfa);
    let worst = out
        .pixels
        .iter()
        .flatten()
        .copied()
        .fold(f32::INFINITY, f32::min);
    assert!(
        worst >= 0.0,
        "RCD undershot non-negative input to {worst} — chroma overshoot is back"
    );
}
