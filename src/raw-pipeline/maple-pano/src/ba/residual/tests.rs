    use super::*;
    use crate::math::axis_angle_to_matrix;

    fn test_setup(k1: f64, k2: f64, with_override: bool) -> (State, Vec<FrameMeta>, Block) {
        let state = State {
            rotations: vec![
                axis_angle_to_matrix([0.05, -0.3, 0.02]),
                axis_angle_to_matrix([-0.04, 0.25, -0.06]),
            ],
            shared_focal: 700.0,
            focal_overrides: vec![None, if with_override { Some(820.0) } else { None }],
            k1,
            k2,
        };
        let frames = vec![
            FrameMeta { cx: 512.0, cy: 384.0 },
            FrameMeta { cx: 512.0, cy: 384.0 },
        ];
        let block = Block {
            src: 0,
            dst: 1,
            p_src: (700.0, 250.0),
            p_dst: (300.0, 400.0),
        };
        (state, frames, block)
    }

    /// Central finite difference of the residual along one state
    /// perturbation.
    fn numeric_column(
        state: &State,
        frames: &[FrameMeta],
        block: &Block,
        eps: f64,
        perturb: impl Fn(&mut State, f64),
    ) -> [f64; 2] {
        let mut plus = state.clone();
        perturb(&mut plus, eps);
        let mut minus = state.clone();
        perturb(&mut minus, -eps);
        let rp = eval_residual(&plus, frames, block).expect("plus side valid");
        let rm = eval_residual(&minus, frames, block).expect("minus side valid");
        [(rp[0] - rm[0]) / (2.0 * eps), (rp[1] - rm[1]) / (2.0 * eps)]
    }

    fn assert_close(analytic: [f64; 2], numeric: [f64; 2], what: &str) {
        for k in 0..2 {
            let scale = analytic[k].abs().max(numeric[k].abs()).max(1.0);
            assert!(
                (analytic[k] - numeric[k]).abs() <= 1e-5 * scale,
                "{what} row {k}: analytic {} vs numeric {}",
                analytic[k],
                numeric[k]
            );
        }
    }

    #[test]
    fn jacobians_match_finite_differences() {
        // Covers: no distortion, barrel+k2, pincushion; shared focal and
        // a per-frame override on the destination side.
        for (k1, k2) in [(0.0, 0.0), (-0.08, 0.02), (0.05, 0.0)] {
            for with_override in [false, true] {
                let (state, frames, block) = test_setup(k1, k2, with_override);
                let (_, jac) =
                    eval_with_jacobian(&state, &frames, &block).expect("block valid");

                // Rotation increments, both frames, all 3 axes.
                for axis in 0..3 {
                    for (which, analytic) in [(0usize, jac.d_rot_src), (1, jac.d_rot_dst)] {
                        let numeric = numeric_column(&state, &frames, &block, 1e-7, |s, eps| {
                            let mut omega = [0.0; 3];
                            omega[axis] = eps;
                            let delta = axis_angle_to_matrix(omega);
                            s.rotations[which] = s.rotations[which].mul_mat(&delta);
                        });
                        assert_close(
                            [analytic[0][axis], analytic[1][axis]],
                            numeric,
                            &format!("d_rot[{which}] axis {axis} k=({k1},{k2})"),
                        );
                    }
                }

                // Shared focal: when the destination has an override, the
                // shared parameter only feeds the source path (and vice
                // versa the override only the destination path).
                let shared = numeric_column(&state, &frames, &block, 1e-3, |s, eps| {
                    s.shared_focal += eps;
                });
                let expected_shared = if with_override {
                    jac.d_f_src
                } else {
                    [
                        jac.d_f_src[0] + jac.d_f_dst[0],
                        jac.d_f_src[1] + jac.d_f_dst[1],
                    ]
                };
                assert_close(expected_shared, shared, "d_shared_focal");
                if with_override {
                    let over = numeric_column(&state, &frames, &block, 1e-3, |s, eps| {
                        *s.focal_overrides[1].as_mut().unwrap() += eps;
                    });
                    assert_close(jac.d_f_dst, over, "d_focal_override");
                }

                // Distortion coefficients.
                let num_k1 =
                    numeric_column(&state, &frames, &block, 1e-7, |s, eps| s.k1 += eps);
                assert_close(jac.d_k1, num_k1, "d_k1");
                let num_k2 =
                    numeric_column(&state, &frames, &block, 1e-7, |s, eps| s.k2 += eps);
                assert_close(jac.d_k2, num_k2, "d_k2");
            }
        }
    }

    #[test]
    fn residual_is_zero_for_exact_correspondences() {
        // Project a known world direction through both cameras and feed
        // the resulting pixel pair — the residual must vanish in both
        // directions.
        let (state, frames, _) = test_setup(-0.06, 0.015, false);
        let cam = |i: usize| {
            crate::camera::Camera::new(
                crate::math::matrix_to_axis_angle(&state.rotations[i]),
                state.focal(i),
                state.k1,
                state.k2,
                1024,
                768,
            )
        };
        let (cam0, cam1) = (cam(0), cam(1));
        let dir = cam0.pixel_to_world_dir(640.0, 300.0).unwrap();
        let (qx, qy) = cam1.world_dir_to_pixel(dir).unwrap();
        let fwd = Block {
            src: 0,
            dst: 1,
            p_src: (640.0, 300.0),
            p_dst: (qx, qy),
        };
        let bwd = Block {
            src: 1,
            dst: 0,
            p_src: (qx, qy),
            p_dst: (640.0, 300.0),
        };
        for block in [fwd, bwd] {
            let r = eval_residual(&state, &frames, &block).expect("valid");
            assert!(
                r[0].abs() < 1e-8 && r[1].abs() < 1e-8,
                "expected zero residual, got {r:?}"
            );
        }
    }

    #[test]
    fn behind_camera_blocks_are_invalid_and_penalized() {
        // Destination looking 180° away: the source ray lands behind it.
        let state = State {
            rotations: vec![
                Mat3::identity(),
                axis_angle_to_matrix([0.0, std::f64::consts::PI, 0.0]),
            ],
            shared_focal: 700.0,
            focal_overrides: vec![None, None],
            k1: 0.0,
            k2: 0.0,
        };
        let frames = vec![
            FrameMeta { cx: 512.0, cy: 384.0 },
            FrameMeta { cx: 512.0, cy: 384.0 },
        ];
        let block = Block {
            src: 0,
            dst: 1,
            p_src: (512.0, 384.0),
            p_dst: (512.0, 384.0),
        };
        assert!(eval_residual(&state, &frames, &block).is_none());
        let cost = total_cost(&[block], &frames, &state, 2.0);
        assert_eq!(cost, huber_cost(2.0, INVALID_BLOCK_RESIDUAL_PX));
    }

    #[test]
    fn assemble_matches_a_direct_dense_computation() {
        // Cross-check H, g, cost from `assemble` against an explicit
        // dense JᵀWJ / JᵀWr built column-by-column from the same
        // analytic Jacobians.
        let (state, frames, block) = test_setup(-0.05, 0.01, true);
        let blocks = vec![
            block,
            Block {
                src: 1,
                dst: 0,
                p_src: (350.0, 410.0),
                p_dst: (650.0, 280.0),
            },
        ];
        let layout = ParamLayout::full(2, 0, &[1]);
        let delta = 2.0;
        let eqs = assemble(&blocks, &frames, &state, &layout, delta);

        let n = layout.n_params;
        let mut h_ref = vec![vec![0.0; n]; n];
        let mut g_ref = vec![0.0; n];
        let mut cost_ref = 0.0;
        for b in &blocks {
            let (r, jac) = eval_with_jacobian(&state, &frames, b).unwrap();
            let s = (r[0] * r[0] + r[1] * r[1]).sqrt();
            cost_ref += huber_cost(delta, s);
            let w = huber_weight(delta, s);
            let mut full = vec![[0.0; 2]; n];
            if let Some(c0) = layout.rot_cols[b.src] {
                for k in 0..3 {
                    full[c0 + k][0] += jac.d_rot_src[0][k];
                    full[c0 + k][1] += jac.d_rot_src[1][k];
                }
            }
            if let Some(c0) = layout.rot_cols[b.dst] {
                for k in 0..3 {
                    full[c0 + k][0] += jac.d_rot_dst[0][k];
                    full[c0 + k][1] += jac.d_rot_dst[1][k];
                }
            }
            if let Some(c) = layout.focal_col(b.src) {
                full[c][0] += jac.d_f_src[0];
                full[c][1] += jac.d_f_src[1];
            }
            if let Some(c) = layout.focal_col(b.dst) {
                full[c][0] += jac.d_f_dst[0];
                full[c][1] += jac.d_f_dst[1];
            }
            if let Some(c) = layout.k1_col {
                full[c][0] += jac.d_k1[0];
                full[c][1] += jac.d_k1[1];
            }
            if let Some(c) = layout.k2_col {
                full[c][0] += jac.d_k2[0];
                full[c][1] += jac.d_k2[1];
            }
            for i in 0..n {
                g_ref[i] += w * (full[i][0] * r[0] + full[i][1] * r[1]);
                for j in 0..n {
                    h_ref[i][j] += w * (full[i][0] * full[j][0] + full[i][1] * full[j][1]);
                }
            }
        }

        assert!((eqs.cost - cost_ref).abs() < 1e-9);
        for i in 0..n {
            assert!(
                (eqs.g[i] - g_ref[i]).abs() < 1e-9,
                "g[{i}]: {} vs {}",
                eqs.g[i],
                g_ref[i]
            );
            for j in 0..n {
                assert!(
                    (eqs.h.get(i, j) - h_ref[i][j]).abs() < 1e-9,
                    "H[{i}][{j}]: {} vs {}",
                    eqs.h.get(i, j),
                    h_ref[i][j]
                );
            }
        }
    }

    #[test]
    fn huber_loss_and_weight_are_consistent() {
        let delta = 2.0;
        assert_eq!(huber_cost(delta, 0.0), 0.0);
        assert_eq!(huber_cost(delta, 2.0), 2.0);
        assert_eq!(huber_cost(delta, 10.0), 2.0 * 9.0);
        assert_eq!(huber_weight(delta, 1.0), 1.0);
        assert_eq!(huber_weight(delta, 8.0), 0.25);
        // ρ′(s) = w·s must hold across the breakpoint (the IRLS gradient
        // identity the module docs lean on).
        for s in [0.5, 1.999, 2.0, 2.001, 50.0] {
            let eps = 1e-7;
            let dnum = (huber_cost(delta, s + eps) - huber_cost(delta, s - eps)) / (2.0 * eps);
            assert!((dnum - huber_weight(delta, s) * s).abs() < 1e-5, "at s={s}");
        }
    }
