//! Unit tests for [`super`].

use super::*;
use crate::ba::residual::{Block, FrameMeta, State};
use crate::math::{axis_angle_to_matrix, Mat3};

fn identity_state(n: usize, focal: f64) -> State {
    State {
        rotations: vec![Mat3::identity(); n],
        shared_focal: focal,
        focal_overrides: vec![None; n],
        k1: 0.0,
        k2: 0.0,
    }
}

fn frames_centered(n: usize, cx: f64, cy: f64) -> Vec<FrameMeta> {
    vec![FrameMeta { cx, cy }; n]
}

/// The packed-index function is consistent with the 6×6 upper-triangle
/// layout (21 elements, row-major).
#[test]
fn packed_idx_covers_all_21_slots_uniquely() {
    let mut seen = vec![false; 21];
    for i in 0..6 {
        for j in i..6 {
            let idx = packed_idx(i, j);
            assert!(idx < 21, "index {idx} out of range for ({i},{j})");
            assert!(!seen[idx], "duplicate index {idx} for ({i},{j})");
            seen[idx] = true;
        }
    }
    assert!(seen.iter().all(|&s| s), "some indices unused");
}

/// Solving a known 6×6 identity system returns the rhs unchanged.
#[test]
fn solve_6x6_identity_system() {
    let mut h = [0.0_f64; 21];
    for i in 0..6 {
        h[packed_idx(i, i)] = 1.0;
    }
    let rhs = [1.0, 2.0, -3.0, 0.5, -1.5, 7.0];
    let x = solve_6x6_sym(&h, &rhs).expect("identity system solves");
    for i in 0..6 {
        assert!(
            (x[i] - rhs[i]).abs() < 1e-12,
            "x[{i}] = {} ≠ {}",
            x[i],
            rhs[i]
        );
    }
}

/// `LocalCorrection::apply` at the image centre is a pure translation.
#[test]
fn apply_at_centre_is_pure_translation() {
    let corr = LocalCorrection {
        cx: 100.0,
        cy: 80.0,
        da: [[0.01, 0.0], [0.0, 0.01]],
        dt: [3.0, -2.0],
        rms_px: 0.0,
        max_correction_px: 0.0,
        fit_blocks: 0,
    };
    // At the centre (dx=0, dy=0) only dt contributes.
    let (cx, cy) = corr.apply(100.0, 80.0);
    assert!((cx - 103.0).abs() < 1e-12);
    assert!((cy - 78.0).abs() < 1e-12);
}

/// Identity correction does not shift any point.
#[test]
fn identity_correction_is_no_op() {
    let corr = LocalCorrection::identity(320.0, 240.0);
    for &(px, py) in &[(0.0, 0.0), (320.0, 240.0), (640.0, 480.0), (100.5, 200.7)] {
        let (qx, qy) = corr.apply(px, py);
        assert!((qx - px).abs() < 1e-14);
        assert!((qy - py).abs() < 1e-14);
    }
}

/// When every match perfectly lies on a rotation-model (zero residual),
/// the fitted correction is driven to near-zero by regularisation.
/// Spec requirement: max correction < 0.05 px on a pure-rotation set.
#[test]
fn pure_rotation_correction_near_identity() {
    // Build two cameras related by a clean 30° yaw — no parallax.
    let focal = crate::camera::focal_px_for_hfov(60.0, 960);
    let cam_a = crate::camera::Camera::new([0.0; 3], focal, 0.0, 0.0, 960, 720);
    let r_b = Mat3::rotation_y(30.0_f64.to_radians());
    let cam_b = crate::camera::Camera::new(
        crate::math::matrix_to_axis_angle(&r_b),
        focal,
        0.0,
        0.0,
        960,
        720,
    );

    // Generate noiseless correspondences.
    let mut rng = crate::prng::SplitMix64::new(42);
    let opts = crate::testkit::CorrespondenceOptions {
        count: 200,
        noise_sigma_px: 0.0,
        outlier_fraction: 0.0,
        ..Default::default()
    };
    let matches =
        crate::testkit::generate_pair_correspondences(&cam_a, &cam_b, &opts, &mut rng);
    assert!(!matches.is_empty());

    // Build two directed blocks (local indices: 0 = A, 1 = B).
    let blocks: Vec<Block> = matches
        .correspondences
        .iter()
        .flat_map(|c| {
            [
                Block { src: 0, dst: 1, p_src: c.pixel_a, p_dst: c.pixel_b },
                Block { src: 1, dst: 0, p_src: c.pixel_b, p_dst: c.pixel_a },
            ]
        })
        .collect();

    let state = State {
        rotations: vec![cam_a.rotation, cam_b.rotation],
        shared_focal: focal,
        focal_overrides: vec![None, None],
        k1: 0.0,
        k2: 0.0,
    };
    let frames = vec![
        FrameMeta { cx: 480.0, cy: 360.0 },
        FrameMeta { cx: 480.0, cy: 360.0 },
    ];

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2);
    for (i, c) in corrections.iter().enumerate() {
        assert!(
            c.max_correction_px < 0.05,
            "frame {i}: max correction {:.4} px exceeds 0.05 px (identity guarantee)",
            c.max_correction_px
        );
    }
}

/// Known uniform parallax offset: a 3 px translation across the whole image.
/// After fitting the correction should absorb most of that shift.
#[test]
fn uniform_parallax_absorbed_by_translation() {
    // Build a set of blocks with a known 3 px x-offset residual.
    // Frame 0 (destination): all blocks land with r = (+3, 0).
    // Two frames, simple identity rotations, focal = 500.
    let focal = 500.0;
    let (cx, cy) = (480.0, 360.0);

    // Construct blocks where the "predicted" lands 3 px right of observed.
    // We simulate this by using camera positions that produce a known
    // residual — simplest: build blocks where p_src projects exactly to
    // p_dst + (3, 0) under the state, so r = (3, 0).
    //
    // Direct approach: build the state with identity rotations, and choose
    // p_src such that the chain produces residual (3, 0) in frame 1.
    // With identity rotations: v = Rd^T * Rs * h = h, projection gives
    // (mx, my) = h / h.z normalised, then q = f*e + c.
    // For a block with src=0, dst=1:
    //   h = undistort((p_src − c) / f) ≈ (p_src − c) / f   (no distortion)
    //   q = f * (h.x, h.y) + c = p_src   (identity rotation)
    //   r = q − p_dst = p_src − p_dst
    // So we want r = (3, 0): set p_dst = p_src − (3, 0).
    let state = identity_state(2, focal);
    let frames = frames_centered(2, cx, cy);

    // Many blocks spread across the image, all with residual (+3, 0).
    let mut blocks = Vec::new();
    let offsets = [
        (100.0, 100.0),
        (200.0, 150.0),
        (300.0, 200.0),
        (400.0, 300.0),
        (500.0, 400.0),
        (600.0, 450.0),
        (700.0, 500.0),
        (800.0, 550.0),
        (150.0, 600.0),
        (350.0, 650.0),
        (550.0, 680.0),
    ];
    for &(px_src, py_src) in &offsets {
        // src=0, dst=1: residual in frame 1 = p_src - p_dst = (3, 0)
        // so p_dst = p_src - (3, 0).
        let p_dst = (px_src - 3.0, py_src);
        blocks.push(Block {
            src: 0,
            dst: 1,
            p_src: (px_src, py_src),
            p_dst,
        });
        // Reverse block: residual in frame 0 = p_dst - p_src = (-3, 0)
        blocks.push(Block {
            src: 1,
            dst: 0,
            p_src: p_dst,
            p_dst: (px_src, py_src),
        });
    }

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2);

    // Frame 1 should absorb ~3 px x-translation (modulo regularisation).
    // With 11 blocks and λ=4, the translation estimate is:
    // t_x ≈ 3 * n / (n + λ) ≈ 3 * 11 / 15 ≈ 2.2 px.
    let c1 = &corrections[1];
    let (cx_out, cy_out) = c1.apply(cx, cy); // at centre: pure translation
    let tx = cx_out - cx;
    assert!(
        tx > 1.5,
        "frame 1 x-translation should absorb the residual: tx={tx:.3}"
    );
    assert!(
        (cy_out - cy).abs() < 0.5,
        "y-translation should remain small: ty={:.3}",
        cy_out - cy
    );

    // Frame 0 absorbs the reverse shift.
    let c0 = &corrections[0];
    let (cx_out0, _) = c0.apply(cx, cy);
    let tx0 = cx_out0 - cx;
    assert!(
        tx0 < -1.0,
        "frame 0 should absorb negative shift: tx0={tx0:.3}"
    );

    // After correction, stats should show reduced residuals for frame 1.
    let after = stats_after_local(&blocks, &frames, &state, &corrections, 2);
    let before = {
        use crate::ba::residual::INVALID_BLOCK_RESIDUAL_PX;
        let mut per: Vec<Vec<f64>> = vec![Vec::new(); 2];
        for b in &blocks {
            if let Some(r) = eval_residual(&state, &frames, b) {
                let s = (r[0] * r[0] + r[1] * r[1]).sqrt();
                per[b.dst].push(s);
            } else {
                per[b.dst].push(INVALID_BLOCK_RESIDUAL_PX);
            }
        }
        per.into_iter()
            .map(|v| {
                if v.is_empty() {
                    return 0.0;
                }
                v.iter().sum::<f64>() / v.len() as f64
            })
            .collect::<Vec<_>>()
    };
    assert!(
        after[1].mean_px < before[1],
        "frame 1: mean after ({:.3}) must be less than before ({:.3})",
        after[1].mean_px,
        before[1]
    );
}

/// The cap is enforced: a wildly large residual input never produces a
/// correction exceeding `MAX_CORRECTION_PX`.
#[test]
fn correction_capped_at_max() {
    // Build blocks with a very large residual (50 px).
    let state = identity_state(2, 500.0);
    let frames = frames_centered(2, 480.0, 360.0);

    let blocks: Vec<Block> = (0..60)
        .flat_map(|i| {
            let px = 100.0 + i as f64 * 6.0;
            let py = 100.0 + i as f64 * 4.0;
            // residual in frame 1 = p_src - p_dst = (50, 30)
            let p_dst = (px - 50.0, py - 30.0);
            [
                Block { src: 0, dst: 1, p_src: (px, py), p_dst },
                Block { src: 1, dst: 0, p_src: p_dst, p_dst: (px, py) },
            ]
        })
        .collect();

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2);
    for (i, c) in corrections.iter().enumerate() {
        assert!(
            c.max_correction_px <= MAX_CORRECTION_PX + 1e-9,
            "frame {i}: correction {:.3} px exceeds MAX_CORRECTION_PX={MAX_CORRECTION_PX}",
            c.max_correction_px
        );
    }
}

/// `stats_after_local` on a perfect fit (large uniform residual, many
/// blocks) shows smaller mean than before.
#[test]
fn stats_after_better_than_before_on_strong_signal() {
    let state = identity_state(2, 500.0);
    let frames = frames_centered(2, 480.0, 360.0);

    // 40 blocks all with residual (2.0, 1.5) in frame 1.
    let blocks: Vec<Block> = (0..40)
        .flat_map(|i| {
            let px = 150.0 + i as f64 * 8.0;
            let py = 150.0 + i as f64 * 5.0;
            let p_dst = (px - 2.0, py - 1.5);
            [
                Block { src: 0, dst: 1, p_src: (px, py), p_dst },
                Block { src: 1, dst: 0, p_src: p_dst, p_dst: (px, py) },
            ]
        })
        .collect();

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2);
    let after = stats_after_local(&blocks, &frames, &state, &corrections, 2);
    // The before-correction mean for frame 1 is sqrt(2² + 1.5²) ≈ 2.5 px.
    // The fit should drive it well below that.
    let before_mean_f1 = (2.0_f64.powi(2) + 1.5_f64.powi(2)).sqrt();
    assert!(
        after[1].mean_px < before_mean_f1 * 0.5,
        "mean after correction ({:.3}) should be much less than before ({:.3})",
        after[1].mean_px,
        before_mean_f1
    );
}
