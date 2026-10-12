//! Robust scene-linear photometry gates (#4517): affine pair fit,
//! log-gain solve, gated bias.

use super::fit::robust_affine_fit;
use super::solve::MAX_BIAS_FRACTION;
use super::tests::{frames_to_tmpdir, geometric_mean, ring_cameras};
use super::*;
use crate::ingest::ValidityMask;
use crate::math::Vec3;

/// High-contrast scene: overlaps span most of the signal range, so the
/// affine slope and offset are separately identifiable.
fn contrast_scene(d: Vec3) -> [f32; 3] {
    let s = (0.02 + 0.5 * (1.0 + (6.0 * d.x).sin() * (5.0 * d.y + 2.0 * d.z).cos())) as f32;
    [s, 0.8 * s + 0.05, 0.6 * s + 0.02]
}

fn planted(muls: &[f32], offsets: &[f32]) -> (Vec<Camera>, Vec<PlanarImage>) {
    let cams = ring_cameras(muls.len() as u32, 60.0, 0.45);
    let frames = cams
        .iter()
        .zip(muls.iter().zip(offsets))
        .map(|(cam, (&m, &o))| {
            let (w, h) = (cam.width, cam.height);
            let px: Vec<[f32; 3]> = (0..h)
                .flat_map(|y| (0..w).map(move |x| (x, y)))
                .map(|(x, y)| {
                    let d = cam
                        .pixel_to_world_dir(x as f64 + 0.5, y as f64 + 0.5)
                        .expect("invertible");
                    contrast_scene(d).map(|v| v * m + o)
                })
                .collect();
            PlanarImage::from_planes(
                w,
                h,
                px.iter().map(|p| p[0]).collect(),
                px.iter().map(|p| p[1]).collect(),
                px.iter().map(|p| p[2]).collect(),
                ValidityMask::new_filled(w, h, true),
            )
        })
        .collect();
    (cams, frames)
}

fn gains_of(p: &[FramePhotometry]) -> Vec<[f32; 3]> {
    p.iter().map(|f| f.gain).collect()
}

fn assert_relative_gains(p: &[FramePhotometry], muls: &[f32], tol: f64) {
    let gains = gains_of(p);
    let gm = geometric_mean(&gains, 0);
    let want_gm = (muls.iter().map(|m| -(*m as f64).ln()).sum::<f64>() / muls.len() as f64).exp();
    for (g, m) in gains.iter().zip(muls) {
        let got = g[0] as f64 / gm;
        let want = (1.0 / *m as f64) / want_gm;
        let rel = (got - want).abs() / want;
        assert!(
            rel < tol,
            "gain for x{m}: {got:.5} want {want:.5} ({:.3}% off)",
            rel * 100.0
        );
    }
}

fn spread(values: impl Iterator<Item = f64>) -> f64 {
    let v: Vec<f64> = values.collect();
    v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
}

#[test]
fn planted_gain_and_offset_recovered() {
    let muls = [1.6_f32, 1.0, 0.7];
    let offsets = [0.004_f32, -0.003, 0.0];
    let (cams, frames) = planted(&muls, &offsets);
    // Dense sampling saturates the edge weights, as real overlaps do;
    // sparse overlaps are deliberately shrunk harder toward zero bias.
    let dense = GainOptions {
        sample_stride: 1,
        ..GainOptions::default()
    };
    let p = solve_photometry(&frames, &cams, &dense).unwrap();
    assert_relative_gains(&p, &muls, 0.01);

    // Corrected value is g·m·S + (g·o + b); the offset term must agree
    // across frames once the bias is applied.
    let raw = spread(p.iter().zip(offsets).map(|(f, o)| (f.gain[0] * o) as f64));
    let corrected = spread(
        p.iter()
            .zip(offsets)
            .map(|(f, o)| (f.gain[0] * o + f.bias[0]) as f64),
    );
    println!("offset spread: raw {raw:.6}, with bias {corrected:.6}; {p:?}");
    assert!(
        corrected < 0.35 * raw,
        "bias failed to reconcile planted offsets: raw {raw:.6}, corrected {corrected:.6}"
    );
}

#[test]
fn pure_gain_set_keeps_bias_near_zero() {
    let muls = [2.0_f32, 1.0, 0.5];
    let (cams, frames) = planted(&muls, &[0.0; 3]);
    let p = solve_photometry(&frames, &cams, &GainOptions::default()).unwrap();
    assert_relative_gains(&p, &muls, 0.01);
    for f in &p {
        for c in 0..3 {
            assert!(f.bias[c].abs() < 2e-4, "spurious bias {:?}", f.bias);
        }
    }
}

#[test]
fn bias_is_clamped() {
    let muls = [1.0_f32, 1.0, 1.0];
    let (cams, frames) = planted(&muls, &[0.15, 0.0, -0.05]);
    let white = frames
        .iter()
        .map(|f| SignalWindow::measure(f, 4).white)
        .fold(0.0_f32, f32::max);
    let p = solve_photometry(&frames, &cams, &GainOptions::default()).unwrap();
    for f in &p {
        assert!(
            f.bias[0].abs() <= (MAX_BIAS_FRACTION as f32) * white * 1.01,
            "bias {:?} exceeds the clamp (white {white})",
            f.bias
        );
    }
}

#[test]
fn clipped_highlights_do_not_bias_the_gains() {
    let muls = [2.0_f32, 1.0, 0.5];
    let (cams, mut frames) = planted(&muls, &[0.0; 3]);
    let plateau = 1.6_f32;
    let clipped = frames[0].r.iter().filter(|v| **v > plateau).count();
    assert!(
        clipped * 50 > frames[0].pixel_count(),
        "fixture must clip a real share of frame 0 ({clipped} px)"
    );
    let f0 = &mut frames[0];
    for plane in [&mut f0.r, &mut f0.g, &mut f0.b] {
        plane.iter_mut().for_each(|v| *v = v.min(plateau));
    }
    let p = solve_photometry(&frames, &cams, &GainOptions::default()).unwrap();
    assert_relative_gains(&p, &muls, 0.01);
}

#[test]
fn outlier_content_does_not_bias_the_gains() {
    let muls = [1.6_f32, 1.0, 0.7];
    let (cams, mut frames) = planted(&muls, &[0.0; 3]);
    let w = frames[1].width() as usize;
    let band = (30 * w)..(38 * w);
    let f1 = &mut frames[1];
    for plane in [&mut f1.r, &mut f1.g, &mut f1.b] {
        plane[band.clone()].iter_mut().for_each(|v| *v *= 3.0);
    }
    let p = solve_photometry(&frames, &cams, &GainOptions::default()).unwrap();
    assert_relative_gains(&p, &muls, 0.01);
}

#[test]
fn affine_fit_rejects_outliers_and_recovers_slope_and_offset() {
    let points: Vec<(f64, f64)> = (0..400)
        .map(|k| {
            let x = 0.05 + 0.6 * (k as f64 / 400.0);
            let y = 1.7 * x + 0.004;
            let outlier = k % 7 == 0;
            (x, if outlier { y * 2.5 + 0.1 } else { y })
        })
        .collect();
    let fit = robust_affine_fit(&points).expect("fit");
    assert!((fit.slope - 1.7).abs() < 0.01, "{fit:?}");
    assert!((fit.offset - 0.004).abs() < 0.002, "{fit:?}");
}

#[test]
fn narrow_range_overlap_falls_back_to_pure_gain() {
    let points: Vec<(f64, f64)> = (0..200)
        .map(|k| {
            let x = 0.5 + 0.01 * ((k * 37 % 200) as f64 / 200.0);
            let noise = 0.0005 * (((k * 7919) % 13) as f64 - 6.0) / 6.0;
            (x, 0.8 * x + noise)
        })
        .collect();
    let fit = robust_affine_fit(&points).expect("fit");
    assert_eq!(fit.offset, 0.0);
    assert!((fit.slope - 0.8).abs() < 0.002, "{fit:?}");
}

#[test]
fn too_few_samples_give_no_edge() {
    let points: Vec<(f64, f64)> = (0..10).map(|k| (k as f64, k as f64)).collect();
    assert!(robust_affine_fit(&points).is_none());
}

#[test]
fn streaming_pure_gain_set_keeps_bias_near_zero() {
    let muls = [1.6_f32, 1.0, 0.7];
    let (cams, frames) = planted(&muls, &[0.0; 3]);
    let (_dir, paths) = frames_to_tmpdir(&frames, &cams);
    let p = solve_photometry_streaming(
        &paths,
        &cams,
        &LensGroups::ingest_corrected(paths.len()),
        &GainOptions::default(),
    )
    .unwrap()
    .frames;
    let gains = gains_of(&p);
    assert!(
        gains[0][0] < gains[1][0] && gains[1][0] < gains[2][0],
        "{gains:?}"
    );
    for f in &p {
        for c in 0..3 {
            assert!(
                f.bias[c].abs() < 1e-3,
                "spurious streaming bias {:?}",
                f.bias
            );
        }
    }
}

#[test]
fn overlap_set_pairs_are_ordered_and_sampled() {
    let (cams, frames) = planted(&[1.0; 3], &[0.0; 3]);
    let set = collect_overlap_set(&frames, &cams, &GainOptions::default()).unwrap();
    assert!(!set.pairs.is_empty());
    for pair in &set.pairs {
        assert!(pair.i < pair.j);
        assert!(pair.samples.len() >= GainOptions::default().min_overlap_samples);
    }
}
