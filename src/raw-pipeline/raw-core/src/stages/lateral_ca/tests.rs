//! Numerical gates for the profile-free lateral-CA stage (#3411).
//!
//! The gate the ticket asks for lives in
//! [`corner_edge_displacement_drops_below_a_third_of_a_pixel`]: a synthetic
//! mosaic is built with a KNOWN radial displacement baked into its red and
//! blue planes, the residual R−G / B−G displacement over a corner ROI is
//! measured before and after the stage with the stage's own Lucas–Kanade
//! estimator, and the after value must be both below 0.3 px and below the
//! before value. Everything else here is a no-op or robustness guard.

use super::*;
use crate::image::ColorSpace;

const W: usize = 512;
const H: usize = 384;

/// A smooth, band-limited test scene with gradient everywhere — the
/// registration estimate needs edges, and an analytic function can be
/// sampled at the exact sub-pixel positions the synthetic CA demands.
fn scene(fx: f32, fy: f32) -> f32 {
    0.5 + 0.15 * (fx * 0.41).sin() + 0.15 * (fy * 0.37).sin() - 0.12 * ((fx + fy) * 0.23).sin()
}

/// Build a Bayer RGGB mosaic whose red plane is displaced radially by
/// `k_red · r` pixels and whose blue plane by `k_blue · r`, with per-channel
/// gains so the estimator's per-block gain fit is exercised too.
fn synthetic_mosaic(k_red: f32, k_blue: f32) -> Image {
    let frame = RadialFrame::new(W, H);
    let pixels = (0..W * H)
        .map(|i| {
            let (x, y) = (i % W, i / W);
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let color = CfaPattern::Rggb.color_at(x as u32, y as u32);
            let (k, gain) = match color {
                0 => (k_red, 0.6),
                2 => (k_blue, 1.4),
                _ => (0.0, 1.0),
            };
            let (sx, sy) = match frame.at(fx, fy) {
                Some((ux, uy, _)) => {
                    let d = k * ((fx - W as f32 * 0.5).hypot(fy - H as f32 * 0.5));
                    (fx + d * ux, fy + d * uy)
                }
                None => (fx, fy),
            };
            let mut px = [0.0f32; 3];
            px[color as usize] = gain * scene(sx, sy);
            px
        })
        .collect();
    Image {
        width: W as u32,
        height: H as u32,
        pixels,
        space: ColorSpace::CameraNativeMosaic,
    }
}

/// Mean absolute residual displacement of `color` against green, measured
/// with the stage's own estimator over blocks in the outer half of the
/// frame — the corner ROI, where lateral CA is largest and where the
/// ticket's acceptance is stated.
fn corner_residual_px(mosaic: &Image, color: u8) -> f32 {
    let green = GreenPlane::build(mosaic, CfaPattern::Rggb);
    let channel = ChannelSampler::build(mosaic, CfaPattern::Rggb, color).expect("channel present");
    let frame = RadialFrame::new(W, H);
    let (cell_w, cell_h) = (W / GRID_X, H / GRID_Y);
    let size = BLOCK_PX.min(cell_w).min(cell_h);
    let mut total = 0.0f32;
    let mut n = 0usize;
    for gy in 0..GRID_Y {
        for gx in 0..GRID_X {
            let origin = (
                gx * cell_w + (cell_w - size) / 2,
                gy * cell_h + (cell_h - size) / 2,
            );
            let Some(s) =
                measure_block(&green, &channel, frame, RadialFit::default(), origin, size)
            else {
                continue;
            };
            if s.rho < 0.5 {
                continue; // inner half — not the corner ROI
            }
            total += s.d.abs();
            n += 1;
        }
    }
    assert!(
        n >= MIN_BLOCKS,
        "corner ROI produced only {n} usable blocks"
    );
    total / n as f32
}

#[test]
fn off_is_bit_identical() {
    let mut img = synthetic_mosaic(0.003, -0.002);
    let before = img.pixels.clone();
    let fits = apply(
        &mut img,
        CfaPattern::Rggb,
        AutoLateralCa::Off,
        CancelToken::never(),
    );
    assert_eq!(img.pixels, before);
    assert_eq!(fits, (RadialFit::default(), RadialFit::default()));
}

#[test]
fn corner_edge_displacement_drops_below_a_third_of_a_pixel() {
    let mut img = synthetic_mosaic(0.003, -0.002);
    let red_before = corner_residual_px(&img, 0);
    let blue_before = corner_residual_px(&img, 2);
    let (fit_r, fit_b) = apply(
        &mut img,
        CfaPattern::Rggb,
        AutoLateralCa::On,
        CancelToken::never(),
    );
    let red_after = corner_residual_px(&img, 0);
    let blue_after = corner_residual_px(&img, 2);
    // The synthetic corner displacement is k · corner_radius.
    let corner = (W as f32 * 0.5).hypot(H as f32 * 0.5);
    eprintln!(
        "lateral_ca corner residual px — red {red_before:.4} -> {red_after:.4} \
         (truth {:.4}, fit {:.4}); blue {blue_before:.4} -> {blue_after:.4} \
         (truth {:.4}, fit {:.4})",
        0.003 * corner,
        fit_r.eval(1.0),
        (-0.002f32 * corner).abs(),
        fit_b.eval(1.0),
    );
    assert!(
        red_after < 0.3,
        "red corner residual {red_after} px is not below 0.3"
    );
    assert!(
        blue_after < 0.3,
        "blue corner residual {blue_after} px is not below 0.3"
    );
    assert!(
        red_after < red_before,
        "red residual did not improve: {red_before} -> {red_after}"
    );
    assert!(
        blue_after < blue_before,
        "blue residual did not improve: {blue_before} -> {blue_after}"
    );
}

#[test]
fn the_fitted_polynomial_recovers_the_synthetic_magnification() {
    let mut img = synthetic_mosaic(0.003, -0.002);
    let (fit_r, fit_b) = apply(
        &mut img,
        CfaPattern::Rggb,
        AutoLateralCa::On,
        CancelToken::never(),
    );
    let corner = (W as f32 * 0.5).hypot(H as f32 * 0.5);
    // `apply` corrects by sampling at `p − d·u`, so a plane synthesised at
    // `p + k·r·u` is recovered by a POSITIVE fitted `d` of `k · corner`.
    assert!(
        (fit_r.eval(1.0) - 0.003 * corner).abs() < 0.25,
        "red fit {} vs truth {}",
        fit_r.eval(1.0),
        0.003 * corner
    );
    assert!(
        (fit_b.eval(1.0) + 0.002 * corner).abs() < 0.25,
        "blue fit {} vs truth {}",
        fit_b.eval(1.0),
        -0.002 * corner
    );
}

#[test]
fn a_ca_free_mosaic_is_left_alone() {
    let mut img = synthetic_mosaic(0.0, 0.0);
    let before = img.pixels.clone();
    let (fit_r, fit_b) = apply(
        &mut img,
        CfaPattern::Rggb,
        AutoLateralCa::On,
        CancelToken::never(),
    );
    assert_eq!(
        (fit_r, fit_b),
        (RadialFit::default(), RadialFit::default()),
        "a clean frame must fall under the useful-shift floor"
    );
    assert_eq!(img.pixels, before);
}

#[test]
fn a_flat_field_yields_no_fit() {
    let mut img = Image {
        width: W as u32,
        height: H as u32,
        pixels: vec![[0.4, 0.4, 0.4]; W * H],
        space: ColorSpace::CameraNativeMosaic,
    };
    let before = img.pixels.clone();
    apply(
        &mut img,
        CfaPattern::Rggb,
        AutoLateralCa::On,
        CancelToken::never(),
    );
    assert_eq!(img.pixels, before, "no edges means no estimate, so no edit");
}

#[test]
fn an_image_too_small_for_the_block_grid_is_skipped() {
    let mut img = Image {
        width: 64,
        height: 64,
        pixels: vec![[0.2, 0.3, 0.4]; 64 * 64],
        space: ColorSpace::CameraNativeMosaic,
    };
    let before = img.pixels.clone();
    apply(
        &mut img,
        CfaPattern::Rggb,
        AutoLateralCa::On,
        CancelToken::never(),
    );
    assert_eq!(img.pixels, before);
}

#[test]
fn a_cancelled_token_leaves_the_mosaic_untouched() {
    let flag = std::sync::atomic::AtomicBool::new(true);
    let mut img = synthetic_mosaic(0.003, -0.002);
    let before = img.pixels.clone();
    let fits = apply(
        &mut img,
        CfaPattern::Rggb,
        AutoLateralCa::On,
        CancelToken::new(&flag),
    );
    assert_eq!(img.pixels, before);
    assert_eq!(fits, (RadialFit::default(), RadialFit::default()));
}

#[test]
fn the_fit_is_clamped_and_odd() {
    let fit = RadialFit {
        a1: 1000.0,
        a3: 0.0,
    };
    assert_eq!(fit.eval(1.0), MAX_FITTED_SHIFT_PX);
    assert_eq!(fit.eval(-1.0), -MAX_FITTED_SHIFT_PX);
    assert_eq!(RadialFit::default().eval(1.0), 0.0);
    assert!(!RadialFit::default().is_useful());
}

#[test]
fn xtrans_sites_round_trip_through_the_sparse_sampler() {
    // The X-Trans sampler is a normalised convolution, so it cannot be
    // exact at a site — but a zero displacement must still be an exact
    // no-op, because the correction is applied as a DIFFERENCE.
    // The canonical Fuji 6×6 tile, row-major, R=0 G=1 B=2.
    #[rustfmt::skip]
    let pattern: [u8; 36] = [
        1, 2, 1, 1, 0, 1,
        0, 1, 0, 2, 1, 2,
        1, 2, 1, 1, 0, 1,
        1, 0, 1, 1, 2, 1,
        2, 1, 2, 0, 1, 0,
        1, 0, 1, 1, 2, 1,
    ];
    let cfa = CfaPattern::XTrans(pattern);
    let pixels = (0..W * H)
        .map(|i| {
            let (x, y) = (i % W, i / W);
            let c = cfa.color_at(x as u32, y as u32) as usize;
            let mut px = [0.0f32; 3];
            px[c] = scene(x as f32 + 0.5, y as f32 + 0.5);
            px
        })
        .collect();
    let mut img = Image {
        width: W as u32,
        height: H as u32,
        pixels,
        space: ColorSpace::CameraNativeMosaic,
    };
    let before = img.pixels.clone();
    let channel = ChannelSampler::build(&img, cfa, 0).expect("x-trans red plane");
    assert!(matches!(channel, ChannelSampler::Sparse { .. }));
    let (fit_r, fit_b) = apply(&mut img, cfa, AutoLateralCa::On, CancelToken::never());
    assert_eq!(
        (fit_r, fit_b),
        (RadialFit::default(), RadialFit::default()),
        "an aberration-free X-Trans frame must fall under the useful floor"
    );
    assert_eq!(img.pixels, before);
}

/// ORDERING GATE: the stage is raw-domain and must run BEFORE demosaic.
///
/// `color_at` only means anything while one channel lives at each site, so
/// a post-demosaic call would rewrite a third of the pixels against a
/// lattice that no longer exists — wrong pixels, no crash. The guard in
/// `apply` is a HARD assert rather than the usual debug-only
/// `assert_space` precisely so that stays true in release, and this pins
/// it: if someone moves the develop chain's call after `demosaic`, or
/// drops the guard, this test fails.
#[test]
#[should_panic(expected = "must run BEFORE demosaic")]
fn applying_after_demosaic_is_rejected_rather_than_silently_wrong() {
    let mut demosaiced = Image {
        width: W as u32,
        height: H as u32,
        pixels: vec![[0.3, 0.4, 0.5]; W * H],
        space: ColorSpace::CameraNativeLinearRgb,
    };
    apply(
        &mut demosaiced,
        CfaPattern::Rggb,
        AutoLateralCa::On,
        CancelToken::never(),
    );
}

/// The guard must not fire for the one case that legitimately skips work:
/// `Off` returns before touching the buffer at all, so it never asserts.
#[test]
fn the_off_default_skips_before_the_space_guard() {
    let mut demosaiced = Image {
        width: W as u32,
        height: H as u32,
        pixels: vec![[0.3, 0.4, 0.5]; W * H],
        space: ColorSpace::CameraNativeLinearRgb,
    };
    let before = demosaiced.pixels.clone();
    apply(
        &mut demosaiced,
        CfaPattern::Rggb,
        AutoLateralCa::Off,
        CancelToken::never(),
    );
    assert_eq!(demosaiced.pixels, before);
}
