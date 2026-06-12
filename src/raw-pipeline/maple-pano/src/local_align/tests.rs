//! Unit tests for [`super`].

use super::*;
use crate::ba::residual::{Block, FrameMeta, State};
use crate::math::Mat3;

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

/// The packed4_idx function is consistent with the 4×4 upper-triangle
/// layout (10 elements, row-major).
#[test]
fn packed4_idx_covers_all_10_slots_uniquely() {
    let mut seen = vec![false; 10];
    for i in 0..4 {
        for j in i..4 {
            let idx = packed4_idx(i, j);
            assert!(idx < 10, "index {idx} out of range for ({i},{j})");
            assert!(!seen[idx], "duplicate index {idx} for ({i},{j})");
            seen[idx] = true;
        }
    }
    assert!(seen.iter().all(|&s| s), "some indices unused");
}

/// Solving a known 4×4 identity system returns the rhs unchanged.
#[test]
fn solve_4x4_identity_system() {
    let mut h = [0.0_f64; 10];
    for i in 0..4 {
        h[packed4_idx(i, i)] = 1.0;
    }
    let rhs = [1.0, 2.0, -3.0, 0.5];
    let x = solve_4x4_sym(&h, &rhs).expect("identity system solves");
    for i in 0..4 {
        assert!(
            (x[i] - rhs[i]).abs() < 1e-12,
            "x[{i}] = {} ≠ {}",
            x[i],
            rhs[i]
        );
    }
}

/// `LocalCorrection::apply` at the image centre returns the centre unchanged
/// (since δt=0 and δA*(0,0)=0).
#[test]
fn apply_at_centre_is_no_op() {
    let corr = LocalCorrection {
        cx: 100.0,
        cy: 80.0,
        da: [[0.01, 0.0], [0.0, 0.01]],
        dt: [0.0, 0.0],
        rms_px: 0.0,
        max_correction_px: 0.0,
        fit_blocks: 0,
    };
    // At the centre (dx=0, dy=0): correction = δA*(0,0) + δt = 0.
    let (cx, cy) = corr.apply(100.0, 80.0);
    assert!((cx - 100.0).abs() < 1e-12);
    assert!((cy - 80.0).abs() < 1e-12);
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

/// Ring-pano parallax: frame 0 has blocks from TWO opposite-direction
/// edges placed at EXACTLY symmetric positions (±dx from centre).
/// Left-edge blocks have r_x = −3 px; right-edge blocks have r_x = +3 px.
///
/// The affine-only model absorbs both via the spatial gradient:
/// δa00 = 3 / dx_half, giving correction = ±3 at the block positions.
/// A translation-only model would see zero net r_x and do nothing.
#[test]
fn ring_pano_bilateral_parallax_absorbed_by_affine() {
    let focal = 500.0;
    let (cx, cy) = (480.0, 360.0);
    let state = identity_state(3, focal); // frames 0, 1, 2
    let frames = frames_centered(3, cx, cy);

    let mut blocks = Vec::new();

    // Place blocks at SYMMETRIC positions ±dx_half so the affine solution
    // is exact: δa00 = 3 / dx_half, correction = ±3 at each block.
    let dx_half = 200.0; // well within the image
    let n_pairs = 20usize;
    for i in 0..n_pairs {
        let dy = -100.0 + i as f64 * 10.0;

        // Right-side block (src=1→dst=0): p_dst has dx=+dx_half, r_x=+3.
        let p_dst_r = (cx + dx_half, cy + dy);
        let p_src_r = (p_dst_r.0 + 3.0, p_dst_r.1);
        blocks.push(Block { src: 1, dst: 0, p_src: p_src_r, p_dst: p_dst_r });
        blocks.push(Block { src: 0, dst: 1, p_src: p_dst_r, p_dst: p_src_r });

        // Left-side block (src=2→dst=0): p_dst has dx=-dx_half, r_x=-3.
        let p_dst_l = (cx - dx_half, cy + dy);
        let p_src_l = (p_dst_l.0 - 3.0, p_dst_l.1);
        blocks.push(Block { src: 2, dst: 0, p_src: p_src_l, p_dst: p_dst_l });
        blocks.push(Block { src: 0, dst: 2, p_src: p_dst_l, p_dst: p_src_l });
    }

    let corrections = fit_local_corrections(&blocks, &frames, &state, 3);
    let after = stats_after_local(&blocks, &frames, &state, &corrections, 3);

    // Frame 0's corrected mean should be near zero — the affine gradient
    // corrects both sides simultaneously.  With n=40 and λ=4 the
    // absorption is n/(n+λ) ≈ 90.9 %; corrected mean ≈ 0.27 px.
    assert!(
        after[0].mean_px < 0.5,
        "frame 0: bilateral parallax mean after correction {:.3} px should be < 0.5 px",
        after[0].mean_px
    );

    // The correction at the centre must be (near) zero — the affine-only
    // model is exactly zero at the principal point.
    let c0 = &corrections[0];
    let (cx_out, cy_out) = c0.apply(cx, cy);
    assert!(
        (cx_out - cx).abs() < 0.1,
        "correction at centre should be near zero: got ({:.3},{:.3})",
        cx_out - cx,
        cy_out - cy
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

/// `stats_after_local` on a one-sided parallax floor (frame has blocks
/// only from one edge — spatially offset from center) shows improved
/// mean vs. before.
#[test]
fn stats_after_better_than_before_on_strong_signal() {
    let state = identity_state(2, 500.0);
    let frames = frames_centered(2, 480.0, 360.0);

    // 40 blocks in frame 1 (destination), offset from the centre so the
    // affine component has leverage.  Residual is (+2.0, +1.5) uniformly.
    let blocks: Vec<Block> = (0..40)
        .flat_map(|i| {
            // Place blocks in the right-center region so dx > 0 for most.
            let px = 550.0 + i as f64 * 5.0;
            let py = 200.0 + i as f64 * 4.0;
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
    // The affine fit should reduce it substantially.
    let before_mean_f1 = (2.0_f64.powi(2) + 1.5_f64.powi(2)).sqrt();
    assert!(
        after[1].mean_px < before_mean_f1 * 0.9,
        "mean after correction ({:.3}) should be less than before ({:.3} * 0.9)",
        after[1].mean_px,
        before_mean_f1
    );
}
