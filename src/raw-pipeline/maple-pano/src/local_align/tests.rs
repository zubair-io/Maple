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

/// The bilinear weights are a partition of unity and the node indices are
/// in range, everywhere in (and beyond) the frame.
#[test]
fn cell_weights_partition_of_unity() {
    let corr = LocalCorrection::identity(960.0, 720.0);
    for &(px, py) in &[
        (0.0, 0.0),
        (960.0, 720.0),
        (959.99, 0.01),
        (480.0, 360.0),
        (137.2, 689.9),
        (-50.0, 800.0), // out of frame: clamps to border cells
    ] {
        let (idx, wts) = corr.cell(px, py);
        let sum: f64 = wts.iter().sum();
        assert!(
            (sum - 1.0).abs() < 1e-12,
            "weights at ({px},{py}) sum to {sum}"
        );
        for (&i, &w) in idx.iter().zip(&wts) {
            assert!(i < corr.nodes.len(), "node index {i} out of range");
            assert!(
                (-1e-12..=1.0 + 1e-12).contains(&w),
                "weight {w} outside [0,1]"
            );
        }
    }
}

/// At a grid node's own pixel position, the interpolated displacement is
/// exactly that node's displacement.
#[test]
fn displacement_exact_at_node_positions() {
    let mut corr = LocalCorrection::identity(960.0, 720.0);
    // Give every node a distinct displacement.
    for (k, node) in corr.nodes.iter_mut().enumerate() {
        *node = [k as f64, -(k as f64) * 0.5];
    }
    let (cols, rows) = (corr.cols, corr.rows);
    for row in 0..rows {
        for col in 0..cols {
            let px = corr.w * col as f64 / (cols - 1) as f64;
            let py = corr.h * row as f64 / (rows - 1) as f64;
            let k = row * cols + col;
            let (qx, qy) = corr.apply(px, py);
            assert!(
                (qx - px - corr.nodes[k][0]).abs() < 1e-9
                    && (qy - py - corr.nodes[k][1]).abs() < 1e-9,
                "node ({col},{row}): interpolation does not reproduce the node value"
            );
        }
    }
}

/// Identity correction does not shift any point.
#[test]
fn identity_correction_is_no_op() {
    let corr = LocalCorrection::identity(640.0, 480.0);
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
    let matches = crate::testkit::generate_pair_correspondences(&cam_a, &cam_b, &opts, &mut rng);
    assert!(!matches.is_empty());

    // Build two directed blocks (local indices: 0 = A, 1 = B).
    let blocks: Vec<Block> = matches
        .correspondences
        .iter()
        .flat_map(|c| {
            [
                Block {
                    src: 0,
                    dst: 1,
                    p_src: c.pixel_a,
                    p_dst: c.pixel_b,
                },
                Block {
                    src: 1,
                    dst: 0,
                    p_src: c.pixel_b,
                    p_dst: c.pixel_a,
                },
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
        FrameMeta {
            cx: 480.0,
            cy: 360.0,
        },
        FrameMeta {
            cx: 480.0,
            cy: 360.0,
        },
    ];

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2, 6.0);
    for (i, c) in corrections.iter().enumerate() {
        assert!(
            c.max_correction_px < 0.05,
            "frame {i}: max correction {:.4} px exceeds 0.05 px (identity guarantee)",
            c.max_correction_px
        );
    }
}

/// Ring-pano parallax: frame 0 has blocks from TWO opposite-direction
/// edges placed at symmetric positions (±dx from centre). Left-edge
/// blocks have r_x = −2.5 px; right-edge blocks have r_x = +2.5 px (the
/// measured pano_01 parallax floor is 1.6–2.2 px — this sits beyond it
/// yet inside the rescue envelope).
///
/// A global translation would see zero net r_x and do nothing; the mesh
/// absorbs both sides through locality — left-overlap nodes pull left,
/// right-overlap nodes pull right — and interpolates near-zero between.
#[test]
fn ring_pano_bilateral_parallax_absorbed_by_mesh() {
    let focal = 500.0;
    let (cx, cy) = (480.0, 360.0);
    let state = identity_state(3, focal); // frames 0, 1, 2
    let frames = frames_centered(3, cx, cy);

    let mut blocks = Vec::new();

    // Production-like density: real overlap stripes carry hundreds of
    // matches (300–1500 per frame), so the per-cell data weight decisively
    // outvotes the smoothness/ridge priors. 60 per side ≈ that regime at
    // this synthetic frame's cell count.
    let dx_half = 200.0; // well within the image
    let n_pairs = 60usize;
    for i in 0..n_pairs {
        let dy = -150.0 + i as f64 * 5.0;

        // Right-side block (src=1→dst=0): p_dst has dx=+dx_half, r_x=+2.5.
        let p_dst_r = (cx + dx_half, cy + dy);
        let p_src_r = (p_dst_r.0 + 2.5, p_dst_r.1);
        blocks.push(Block {
            src: 1,
            dst: 0,
            p_src: p_src_r,
            p_dst: p_dst_r,
        });
        blocks.push(Block {
            src: 0,
            dst: 1,
            p_src: p_dst_r,
            p_dst: p_src_r,
        });

        // Left-side block (src=2→dst=0): p_dst has dx=-dx_half, r_x=-2.5.
        let p_dst_l = (cx - dx_half, cy + dy);
        let p_src_l = (p_dst_l.0 - 2.5, p_dst_l.1);
        blocks.push(Block {
            src: 2,
            dst: 0,
            p_src: p_src_l,
            p_dst: p_dst_l,
        });
        blocks.push(Block {
            src: 0,
            dst: 2,
            p_src: p_dst_l,
            p_dst: p_src_l,
        });
    }

    let corrections = fit_local_corrections(&blocks, &frames, &state, 3, 6.0);
    let after = stats_after_local(&blocks, &frames, &state, &corrections, 3);

    // Frame 0's corrected mean must be well under the ±2.5 px input.
    assert!(
        after[0].mean_px < 0.75,
        "frame 0: bilateral parallax mean after correction {:.3} px should be < 0.75 px",
        after[0].mean_px
    );

    // The correction at the centre must be small — the centre interpolates
    // between the opposite-signed sides.
    let c0 = &corrections[0];
    let (cx_out, cy_out) = c0.apply(cx, cy);
    assert!(
        (cx_out - cx).abs() < 0.5,
        "correction at centre should be small: got ({:.3},{:.3})",
        cx_out - cx,
        cy_out - cy
    );
}

/// Depth-band parallax — the measured v1 failure mode as a unit test.
/// A horizontal foreground band through the frame carries +2.5 px
/// residuals (inside the per-node trust ceiling — beyond it the band
/// would be deliberately seam-routed instead) while the rest of the
/// frame carries −1 px: piecewise depth structure that no global linear
/// (affine) field can represent. The mesh must absorb the band without
/// disturbing the background.
#[test]
fn depth_band_absorbed_by_mesh() {
    let (cx, cy) = (480.0, 360.0);
    let state = identity_state(2, 500.0);
    let frames = frames_centered(2, cx, cy);

    let mut blocks = Vec::new();
    let mut push = |px: f64, py: f64, rx: f64| {
        // Residual measured in frame 1 at (px, py) is (rx, 0):
        // r = p_src − p_dst under the identity state.
        let p_dst = (px, py);
        let p_src = (px + rx, py);
        blocks.push(Block {
            src: 0,
            dst: 1,
            p_src,
            p_dst,
        });
        blocks.push(Block {
            src: 1,
            dst: 0,
            p_src: p_dst,
            p_dst: p_src,
        });
    };
    // Production-like density (see the ring test). Background rows
    // (sky / far field): r_x = −1 px, 100 matches per row.
    for i in 0..200 {
        let px = 40.0 + (i % 100) as f64 * 8.8;
        let py = if i < 100 { 100.0 } else { 620.0 };
        push(px, py, -1.0);
    }
    // Foreground band through the middle: r_x = +2.5 px, 100 matches.
    for i in 0..100 {
        let px = 40.0 + i as f64 * 8.8;
        push(px, 360.0, 2.5);
    }

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2, 6.0);
    let after = stats_after_local(&blocks, &frames, &state, &corrections, 2);

    // Frame 1 (destination of the band blocks) must end well under the
    // band magnitude. For contrast: the best GLOBAL fit of this field
    // (+2.5 on 1/3 of the matches, −1 on 2/3) is a near-uniform ≈ +0.17,
    // leaving a ~1.5 px mean — a linear model cannot do meaningfully
    // better because the structure is piecewise, not a gradient. The
    // mesh must beat that floor decisively.
    assert!(
        after[1].mean_px < 0.75,
        "frame 1: depth-band mean after correction {:.3} px should be < 0.75 px",
        after[1].mean_px
    );
}

/// A wildly large residual input never produces a correction at all:
/// every node lands beyond the trust ceiling and is zeroed (and the
/// field is therefore bounded at every pixel by bilinear convexity).
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
                Block {
                    src: 0,
                    dst: 1,
                    p_src: (px, py),
                    p_dst,
                },
                Block {
                    src: 1,
                    dst: 0,
                    p_src: p_dst,
                    p_dst: (px, py),
                },
            ]
        })
        .collect();

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2, 6.0);
    for (i, c) in corrections.iter().enumerate() {
        assert!(
            c.max_correction_px <= MAX_CORRECTION_PX + 1e-9,
            "frame {i}: correction {:.3} px exceeds MAX_CORRECTION_PX={MAX_CORRECTION_PX}",
            c.max_correction_px
        );
        let node_max = c
            .nodes
            .iter()
            .map(|n| (n[0] * n[0] + n[1] * n[1]).sqrt())
            .fold(0.0, f64::max);
        assert!(
            node_max <= MAX_CORRECTION_PX + 1e-9,
            "frame {i}: node displacement {node_max:.3} px exceeds the cap"
        );
    }
}

/// `stats_after_local` on a one-sided parallax floor (frame has blocks
/// only in one region) shows improved mean vs. before — the mesh can
/// correct locally even when the field has a nonzero regional mean.
#[test]
fn stats_after_better_than_before_on_strong_signal() {
    let state = identity_state(2, 500.0);
    let frames = frames_centered(2, 480.0, 360.0);

    // 40 blocks in frame 1 (destination), clustered right-of-centre.
    // Residual is (+2.0, +1.5) uniformly.
    let blocks: Vec<Block> = (0..40)
        .flat_map(|i| {
            let px = 550.0 + i as f64 * 5.0;
            let py = 200.0 + i as f64 * 4.0;
            let p_dst = (px - 2.0, py - 1.5);
            [
                Block {
                    src: 0,
                    dst: 1,
                    p_src: (px, py),
                    p_dst,
                },
                Block {
                    src: 1,
                    dst: 0,
                    p_src: p_dst,
                    p_dst: (px, py),
                },
            ]
        })
        .collect();

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2, 6.0);
    let after = stats_after_local(&blocks, &frames, &state, &corrections, 2);
    // The before-correction mean for frame 1 is sqrt(2² + 1.5²) ≈ 2.5 px.
    let before_mean_f1 = (2.0_f64.powi(2) + 1.5_f64.powi(2)).sqrt();
    assert!(
        after[1].mean_px < before_mean_f1 * 0.9,
        "mean after correction ({:.3}) should be less than before ({:.3} * 0.9)",
        after[1].mean_px,
        before_mean_f1
    );
}

/// The per-node trust ceiling refuses oversized fields: a coherent
/// residual field well beyond `NODE_TRUST_MAX_PX` everywhere (here: a
/// uniform 5 px shift, the signature of misregistration rather than
/// drift) loses every node — identity, no gating rescue, no warp.
#[test]
fn oversized_correction_refused_by_envelope() {
    let state = identity_state(2, 500.0);
    let frames = frames_centered(2, 480.0, 360.0);

    let blocks: Vec<Block> = (0..120)
        .flat_map(|i| {
            let px = 80.0 + (i % 60) as f64 * 14.0;
            let py = 150.0 + (i / 60) as f64 * 400.0;
            // Residual in frame 1 = (5, 0) uniformly — over the envelope.
            let p_dst = (px - 5.0, py);
            [
                Block {
                    src: 0,
                    dst: 1,
                    p_src: (px, py),
                    p_dst,
                },
                Block {
                    src: 1,
                    dst: 0,
                    p_src: p_dst,
                    p_dst: (px, py),
                },
            ]
        })
        .collect();

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2, 6.0);
    let c1 = &corrections[1];
    assert!(
        c1.nodes.iter().all(|n| n[0] == 0.0 && n[1] == 0.0),
        "oversized field must be refused, got rms {:.3} px",
        c1.rms_px
    );
    assert!(
        c1.fit_blocks > 0,
        "refusal must still record the fit attempt"
    );

    // And the corrected stats equal the raw stats (no rescue).
    let after = stats_after_local(&blocks, &frames, &state, &corrections, 2);
    assert!(
        (after[1].mean_px - 5.0).abs() < 1e-9,
        "refused frame must gate on raw residuals, got mean {:.3} px",
        after[1].mean_px
    );
}

/// The rigid-subset rule: over-budget matches (motion / blunder
/// candidates) must not steer the fit. A water-dominated frame — 60% of
/// matches wildly shifted, 40% carrying a coherent 2 px parallax field —
/// gets a correction fit to the parallax only, inside the rescue
/// envelope, leaving the static core certifiable.
#[test]
fn over_budget_matches_excluded_from_fit() {
    let state = identity_state(2, 500.0);
    let frames = frames_centered(2, 480.0, 360.0);

    let mut blocks = Vec::new();
    // 120 wild matches (12 px — moving water).
    for i in 0..120 {
        let px = 80.0 + (i % 60) as f64 * 14.0;
        let py = 120.0 + (i / 60) as f64 * 200.0;
        let p_dst = (px - 12.0, py);
        blocks.push(Block {
            src: 0,
            dst: 1,
            p_src: (px, py),
            p_dst,
        });
        blocks.push(Block {
            src: 1,
            dst: 0,
            p_src: p_dst,
            p_dst: (px, py),
        });
    }
    // 80 static matches with a coherent 2 px parallax field.
    for i in 0..80 {
        let px = 80.0 + (i % 40) as f64 * 21.0;
        let py = 480.0 + (i / 40) as f64 * 180.0;
        let p_dst = (px - 2.0, py);
        blocks.push(Block {
            src: 0,
            dst: 1,
            p_src: (px, py),
            p_dst,
        });
        blocks.push(Block {
            src: 1,
            dst: 0,
            p_src: p_dst,
            p_dst: (px, py),
        });
    }

    let corrections = fit_local_corrections(&blocks, &frames, &state, 2, 6.0);
    let c1 = &corrections[1];
    assert!(
        c1.rms_px > 0.0 && c1.rms_px <= NODE_TRUST_MAX_PX,
        "fit must follow the 2 px static field, not the 12 px water: rms {:.3}",
        c1.rms_px
    );
    // The static rows must be corrected to near +2 px.
    let (qx, _) = c1.apply(500.0, 560.0);
    assert!(
        (qx - 500.0 - 2.0).abs() < 1.0,
        "static-region correction should approach +2 px, got {:+.3}",
        qx - 500.0
    );
    // The water rows' cells must be UNTRUSTED — zero correction there
    // (the warp never chases motion): per-node ceiling, not frame-level
    // refusal, so the static field above survives simultaneously.
    let water_mag = c1.displacement_at(500.0, 160.0);
    assert!(
        water_mag < 1.0,
        "water-region correction must be zeroed/small, got {water_mag:.3} px"
    );
}
