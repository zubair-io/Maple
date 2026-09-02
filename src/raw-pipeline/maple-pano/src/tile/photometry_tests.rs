//! Unit tests for the photometric solve (#350): shared-ramp recovery,
//! genuine-exposure recovery, and residual-field absorption.
//! Kept in a separate file for the file-size budget.

use super::frame_cache::TileFrameCache;
use super::photometry::{solve_photometry, FramePhotometry, PhotometryOptions};
use super::placement::{TileCanvasSpec, TilePose};
use crate::ingest::{PlanarImage, ValidityMask};
use crate::similarity::Similarity2d;

/// #3090: `solve_photometry` now takes an on-demand decode cache + dims
/// instead of a full frame slice. `TileFrameCache::from_frames` (test-only)
/// seeds the cache with these synthetic frames, keyed by their position in
/// `frames` — the same index `translation_pose` below always uses for
/// `frame_idx`, so it lines up with `full_dims` directly.
fn cache_and_dims(frames: Vec<PlanarImage>) -> (TileFrameCache<'static>, Vec<(u32, u32)>) {
    let full_dims = frames.iter().map(|f| (f.width(), f.height())).collect();
    (TileFrameCache::from_frames(frames), full_dims)
}

fn translation_pose(frame_idx: usize, tx: f64, ty: f64) -> TilePose {
    TilePose {
        frame_idx,
        sim: Similarity2d {
            scale: 1.0,
            theta: 0.0,
            tx,
            ty,
        },
    }
}

fn test_opts() -> PhotometryOptions {
    PhotometryOptions {
        stride: 2,
        min_pair_samples: 32,
        per_channel: false,
        ramp: true,
        field: true,
        field_cell_px: 16,
        field_lambda: 1.0,
        field_cg_iters: 300,
    }
}

/// Frame recording a uniform scene through the model
/// `v = L · exp(a + slope·(ξ−½)) · exp(bump)`, with an optional Gaussian
/// log-bump centered in the frame.
fn model_frame(
    w: u32,
    h: u32,
    l: f32,
    a: f64,
    slope_x: f64,
    bump: Option<(f64, f64)>, // (amplitude, sigma_px)
) -> PlanarImage {
    let n = (w * h) as usize;
    let mut r = vec![0.0_f32; n];
    for y in 0..h {
        for x in 0..w {
            let xi = (x as f64 + 0.5) / w as f64 - 0.5;
            let mut log_v = a + slope_x * xi;
            if let Some((amp, sigma)) = bump {
                let dx = x as f64 + 0.5 - w as f64 / 2.0;
                let dy = y as f64 + 0.5 - h as f64 / 2.0;
                log_v += amp * (-(dx * dx + dy * dy) / (2.0 * sigma * sigma)).exp();
            }
            r[(y * w + x) as usize] = l * (log_v.exp() as f32);
        }
    }
    let g = r.clone();
    let b = r.clone();
    PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
}

/// A constant within-frame slope must be recovered as the SHARED ramp,
/// not aliased into a cross-strip gain ramp — the pano_03 failure mode
/// (#350): scalar-only gains integrate the per-pair bias over the chain
/// into a huge monotonic gain drift.
#[test]
fn shared_slope_absorbed_not_aliased_into_gain_ramp() {
    let (w, h) = (64u32, 48u32);
    let slope = 0.3_f64;
    let k = 6usize;
    let step = 24.0_f64; // 40 px overlap at i+1, 16 px at i+2
    let frames: Vec<PlanarImage> = (0..k)
        .map(|_| model_frame(w, h, 0.5, 0.0, slope, None))
        .collect();
    let poses: Vec<TilePose> = (0..k)
        .map(|i| translation_pose(i, i as f64 * step, 0.0))
        .collect();
    let canvas = TileCanvasSpec {
        width: w + (k as u32 - 1) * step as u32,
        height: h,
        offset_x: 0.0,
        offset_y: 0.0,
    };

    let (cache, full_dims) = cache_and_dims(frames);
    let (phot, summary) =
        solve_photometry(&cache, &full_dims, &poses, &canvas, &test_opts()).unwrap();

    assert!(
        (f64::from(summary.slope_x) - slope).abs() < 0.05,
        "shared slope not recovered: got {}, want {slope}",
        summary.slope_x
    );
    // Gains must stay flat: no monotonic chain drift.
    let gains: Vec<f32> = phot.iter().map(|p| p.gain[0]).collect();
    let max = gains.iter().cloned().fold(f32::MIN, f32::max);
    let min = gains.iter().cloned().fold(f32::MAX, f32::min);
    assert!(
        max / min < 1.05,
        "gain chain drifted under a pure within-frame slope: {gains:?}"
    );
}

/// Genuine per-frame exposure differences (flat frames, no slope) must
/// be recovered as gains with no invented slope. The layout is
/// deliberately NON-uniform: exposure steps are non-monotonic (AE-like
/// toggling) and spacings differ, so the data itself separates gains
/// from the shared slope (see the degeneracy note in `photometry.rs` —
/// on a perfectly uniform strip a linear gain ramp and the slope are
/// collinear, and the zero-trend prior resolves that direction toward
/// the slope by design).
#[test]
fn true_exposure_steps_recovered_as_gains() {
    let (w, h) = (64u32, 48u32);
    // Non-uniform gaps (16, 28, 12, 24) keep hop-2 pairs overlapping too,
    // so the system is over-determined and slope/gain separate.
    let a_true = [0.0, 0.15, -0.05, 0.2, 0.0];
    let tx = [0.0, 16.0, 44.0, 56.0, 80.0];
    let frames: Vec<PlanarImage> = a_true
        .iter()
        .map(|&a| model_frame(w, h, 0.5, a, 0.0, None))
        .collect();
    let poses: Vec<TilePose> = tx
        .iter()
        .enumerate()
        .map(|(i, &t)| translation_pose(i, t, 0.0))
        .collect();
    let canvas = TileCanvasSpec {
        width: w + 80,
        height: h,
        offset_x: 0.0,
        offset_y: 0.0,
    };

    let (cache, full_dims) = cache_and_dims(frames);
    let (phot, summary) =
        solve_photometry(&cache, &full_dims, &poses, &canvas, &test_opts()).unwrap();

    assert!(
        f64::from(summary.slope_x).abs() < 0.05,
        "slope invented for slope-free frames: {}",
        summary.slope_x
    );
    // Pairwise gain log-ratios should track the true exposure offsets
    // (brighter frame gets the smaller gain).
    for i in 0..a_true.len() - 1 {
        let got = f64::from(phot[i].gain[0] / phot[i + 1].gain[0]).ln();
        let want = a_true[i + 1] - a_true[i];
        assert!(
            (got - want).abs() < 0.05,
            "gain ratio {i}->{}: ln={got:.4} want {want:.4}",
            i + 1
        );
    }
}

/// A smooth localized mismatch (cloud-shadow-like log-bump on one frame)
/// is not expressible by gain+ramp; the layer-B field must absorb most
/// of the pairwise residual.
#[test]
fn residual_blob_absorbed_by_field() {
    // Large frames + a σ=2-cell bump: the bump's overlap MEAN is small
    // (so the gain doesn't legitimately soak it) and the structure is
    // above the field's screened-Poisson transfer length — this isolates
    // the layer-B contract.
    let (w, h) = (256u32, 256u32);
    let amp = 0.5_f64;
    let frames = vec![
        model_frame(w, h, 0.5, 0.0, 0.0, None),
        model_frame(w, h, 0.5, 0.0, 0.0, Some((amp, 32.0))),
    ];
    let poses = vec![
        translation_pose(0, 0.0, 0.0),
        translation_pose(1, 32.0, 0.0),
    ];
    let canvas = TileCanvasSpec {
        width: w + 32,
        height: h,
        offset_x: 0.0,
        offset_y: 0.0,
    };

    let opts = test_opts();
    // Cloned before the cache takes ownership — the RMS check below reads
    // raw pixels back out directly, alongside the cache-mediated solve.
    let frames_for_check = frames.clone();
    let (cache, full_dims) = cache_and_dims(frames);
    let (phot, summary) = solve_photometry(&cache, &full_dims, &poses, &canvas, &opts).unwrap();
    assert!(
        summary.field_max_abs_ev > 0.15,
        "field did not engage: max {} EV",
        summary.field_max_abs_ev
    );

    // RMS pairwise log residual over the overlap, before vs after the
    // full correction (gain + slope + field).
    let log_model = |p: &FramePhotometry, fx: f64, fy: f64, cx: f64, cy: f64| -> f64 {
        -(f64::from(p.gain[0]).ln())
            + f64::from(p.slope_x) * (fx / w as f64 - 0.5)
            + f64::from(p.slope_y) * (fy / h as f64 - 0.5)
            + p.field.as_ref().map_or(0.0, |f| f64::from(f.eval(cx, cy)))
    };
    let (mut rms_before, mut rms_after, mut count) = (0.0_f64, 0.0_f64, 0usize);
    for y in (4..h as usize - 4).step_by(4) {
        for cx_i in (36..w as usize - 4).step_by(4) {
            // canvas x where both frames are interior
            let (cx, cy) = (cx_i as f64 + 0.5, y as f64 + 0.5);
            let (f0x, f0y) = (cx, cy);
            let (f1x, f1y) = (cx - 32.0, cy);
            let i0 = (f0y as usize).min(h as usize - 1) * w as usize + (f0x as usize);
            let i1 = (f1y as usize).min(h as usize - 1) * w as usize + (f1x as usize);
            let v0 = f64::from(frames_for_check[0].r[i0]);
            let v1 = f64::from(frames_for_check[1].r[i1]);
            if v0 <= 0.0 || v1 <= 0.0 {
                continue;
            }
            let before = v1.ln() - v0.ln();
            let after = before
                - (log_model(&phot[1], f1x, f1y, cx, cy) - log_model(&phot[0], f0x, f0y, cx, cy));
            rms_before += before * before;
            rms_after += after * after;
            count += 1;
        }
    }
    let rms_before = (rms_before / count as f64).sqrt();
    let rms_after = (rms_after / count as f64).sqrt();
    assert!(
        rms_after < 0.5 * rms_before,
        "field absorbed too little: before {rms_before:.4}, after {rms_after:.4}"
    );
}

/// Per-channel gains must be normalized by each channel's OWN sample
/// count. Samples where a channel is below `MIN_LUM` never enter
/// `s_lnr_ch`, so dividing by the luminance count `n` biased the mean
/// toward 0 and flattened real colour-gain ratios (#350 review).
///
/// Layout mirrors `true_exposure_steps_recovered_as_gains`: 4 frames at
/// non-uniform spacing so gains and the shared slope are separable (a
/// single pair is degenerate by construction — see the module note).
#[test]
fn per_channel_gains_ignore_dark_channel_samples() {
    let (w, h) = (64u32, 48u32);
    // BLUE carries non-monotonic per-frame exposure offsets AND is below
    // MIN_LUM inside a CENTERED band (half the width, so it is symmetric
    // about the frame center and induces no linear ramp for the shared
    // slope to absorb). Blue therefore has both a real ratio to recover
    // and roughly half the sample count — the combination the bug
    // flattened. Red and green are flat and fully sampled, as the
    // control. A contiguous band (not a checkerboard) keeps the bicubic
    // taps clean away from the two band edges.
    let blue_log = [0.0_f64, 0.25, -0.1, 0.15];
    let tx = [0.0_f64, 16.0, 44.0, 56.0];
    let build = |a_blue: f64| {
        let n = (w * h) as usize;
        let mut r = vec![0.0_f32; n];
        let mut g = vec![0.0_f32; n];
        let mut b = vec![0.0_f32; n];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) as usize;
                r[i] = 0.4;
                g[i] = 0.4;
                b[i] = if x < w / 4 || x >= 3 * w / 4 {
                    0.4 * (a_blue.exp() as f32)
                } else {
                    0.0
                };
            }
        }
        PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
    };
    let frames: Vec<PlanarImage> = blue_log.iter().map(|&a| build(a)).collect();
    let poses: Vec<TilePose> = tx
        .iter()
        .enumerate()
        .map(|(i, &t)| translation_pose(i, t, 0.0))
        .collect();
    let canvas = TileCanvasSpec {
        width: w + 56,
        height: h,
        offset_x: 0.0,
        offset_y: 0.0,
    };
    let opts = PhotometryOptions {
        per_channel: true,
        ..test_opts()
    };

    let (cache, full_dims) = cache_and_dims(frames);
    let (phot, _) = solve_photometry(&cache, &full_dims, &poses, &canvas, &opts).unwrap();

    // Blue gain ratios track the true blue offsets despite only half the
    // pixels contributing. Dividing by the luminance count `n` instead of
    // blue's own count halves these and fails here.
    for i in 0..blue_log.len() - 1 {
        let got = f64::from(phot[i].gain[2] / phot[i + 1].gain[2]).ln();
        let want = blue_log[i + 1] - blue_log[i];
        assert!(
            (got - want).abs() < 0.06,
            "blue gain ratio {i}->{}: ln={got:.4} want {want:.4}",
            i + 1
        );
    }
    // Red and green are equal across frames and fully sampled: ratios ~1.
    for ch in [0usize, 1] {
        for i in 0..blue_log.len() - 1 {
            let ratio = f64::from(phot[i].gain[ch] / phot[i + 1].gain[ch]).ln();
            assert!(
                ratio.abs() < 0.06,
                "channel {ch} ratio {i}->{}: ln={ratio:.4} want 0",
                i + 1
            );
        }
    }
}
