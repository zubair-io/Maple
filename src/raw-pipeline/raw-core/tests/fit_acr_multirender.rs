//! Multi-render pooled tonescale tests for `solve_acr_model_multi` (#1722).
//!
//! These tests exercise the EV-offset pooling introduced in slice 1 of
//! epic #1710.  They live in their own file to keep `fit_acr_solver.rs`
//! under the 600-line hard budget.

#[cfg(feature = "test-support")]
mod multirender_tests {
    use raw_core::color::matrices::M_REC2020_TO_SRGB;
    use raw_core::test_support::synth_sweep::{SyntheticSweepChart, COLS, GUARD, PATCH_SIZE, ROWS};
    use raw_core::view::acr_fit::model::tonescale_apply;
    use raw_core::view::acr_fit::{
        parse_spec_json, solve_acr_model, solve_acr_model_multi, AcrRender,
    };

    // ── Analytic fake renderer ─────────────────────────────────────────────────

    /// S-curve: T(l) = (l / (l + 0.5)) * 0.9.
    fn tone_curve(l: f32) -> f32 {
        (l / (l + 0.5)) * 0.9
    }

    fn srgb_gamma_enc(v: f32) -> f32 {
        let v = v.clamp(0.0, 1.0);
        if v <= 0.0031308 {
            v * 12.92
        } else {
            1.055 * v.powf(1.0 / 2.4) - 0.055
        }
    }

    /// Build a fake 8-bit sRGB PNG array for the given chart at a given ACR EV
    /// offset.  Each patch is rendered by applying the tone curve to
    /// `scene_L * 2^ev`, then converting back to display sRGB (luminance-
    /// preserving).  An optional `distort_fn(scene_L_shifted, display_L)` can
    /// inject highlight-dependent distortion for the overlap-consistency test.
    fn build_fake_render_ev(
        chart: &SyntheticSweepChart,
        ev: f32,
        distort_fn: Option<&dyn Fn(f32, f32) -> f32>,
    ) -> (Vec<u8>, usize) {
        let specs = chart.specs();
        let stride = (PATCH_SIZE + GUARD) as usize;
        let w = (COLS * (PATCH_SIZE + GUARD)) as usize;
        let h = (ROWS * (PATCH_SIZE + GUARD)) as usize;
        let mut png = vec![0u8; w * h * 3];
        let ev_scale = ev.exp2();

        for spec in specs {
            let scene_rec2020 = spec.target_rec2020;
            let l_scene =
                0.2627 * scene_rec2020[0] + 0.6780 * scene_rec2020[1] + 0.0593 * scene_rec2020[2];
            let l_scene_shifted = l_scene * ev_scale;

            // Skip if scene lum is effectively zero.
            if l_scene <= 0.0 {
                continue;
            }

            let l_display_base = tone_curve(l_scene_shifted);
            let l_display = if let Some(df) = distort_fn {
                df(l_scene_shifted, l_display_base)
            } else {
                l_display_base
            };

            // Map scene RGB by luminance-preserving scale.
            let ts_scale = (l_display / l_scene).min(4.0);
            let rec_display = [
                scene_rec2020[0] * ts_scale,
                scene_rec2020[1] * ts_scale,
                scene_rec2020[2] * ts_scale,
            ];

            // Rec.2020 -> linear sRGB -> gamma-encoded sRGB.
            let lin_srgb = M_REC2020_TO_SRGB.mul_vec(rec_display);
            let srgb8 = [
                (srgb_gamma_enc(lin_srgb[0]) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8,
                (srgb_gamma_enc(lin_srgb[1]) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8,
                (srgb_gamma_enc(lin_srgb[2]) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8,
            ];

            let inner = 24usize;
            let skip = (PATCH_SIZE as usize - inner) / 2;
            let x0 = spec.col as usize * stride + skip;
            let y0 = spec.row as usize * stride + skip;
            for dy in 0..inner {
                for dx in 0..inner {
                    let px = ((y0 + dy) * w + (x0 + dx)) * 3;
                    if px + 2 < png.len() {
                        png[px] = srgb8[0];
                        png[px + 1] = srgb8[1];
                        png[px + 2] = srgb8[2];
                    }
                }
            }
        }
        (png, w)
    }

    // ── Tests ──────────────────────────────────────────────────────────────────

    /// Pooling an ev=0 and ev=+2 render extends the tonescale's observable range
    /// above the baseline clip point (x ≈ 1.0 scene luminance).  At x=2.0 the
    /// ev=0-only fit is flat (no data there), while the pooled fit should be
    /// accurate to within 10%.
    #[test]
    fn two_render_pooled_fit_extends_tonescale_range() {
        let chart = SyntheticSweepChart::new();
        let spec_json = chart.spec_to_json();
        let specs = parse_spec_json(&spec_json).expect("parse");

        // Build fake renders at ev=0 and ev=+2.
        let (png_ev0, w_ev0) = build_fake_render_ev(&chart, 0.0, None);
        let (png_ev2, w_ev2) = build_fake_render_ev(&chart, 2.0, None);

        // --- Pooled fit (two renders) ---
        let renders = [
            AcrRender {
                png_rgb: &png_ev0,
                png_w: w_ev0,
                ev: 0.0,
            },
            AcrRender {
                png_rgb: &png_ev2,
                png_w: w_ev2,
                ev: 2.0,
            },
        ];
        let pooled_model = solve_acr_model_multi(&specs, &renders).expect("pooled solver");

        // --- Single-render baseline fit (ev=0 only) ---
        let single_model = solve_acr_model(&specs, &png_ev0, w_ev0).expect("single solver");

        // At x=2.0 (above the baseline DNG clip at x≈1.0):
        // - The single-render fit has no data here; it extrapolates from its last
        //   knot and will drift significantly from the true curve.
        // - The pooled fit has dense neutral samples from the +2EV render at
        //   x = spec_L * 4 (e.g. spec_L=0.5 → x=2.0), so it should recover well.
        let analytic = tone_curve(2.0);
        let x_test = 2.0f32;

        let pooled_at_x2 = tonescale_apply(&pooled_model.tonescale, x_test);
        let single_at_x2 = tonescale_apply(&single_model.tonescale, x_test);

        let pooled_err_pct = ((pooled_at_x2 - analytic) / analytic).abs() * 100.0;
        let single_err_pct = ((single_at_x2 - analytic) / analytic).abs() * 100.0;

        assert!(
            pooled_err_pct < 10.0,
            "pooled tonescale error {pooled_err_pct:.2}% > 10% at L=2 \
             (analytic={analytic:.4}, pooled={pooled_at_x2:.4})"
        );
        assert!(
            single_err_pct > pooled_err_pct,
            "single-render fit (err={single_err_pct:.2}%) should be LESS accurate \
             than pooled (err={pooled_err_pct:.2}%) at x=2.0"
        );
    }

    /// Overlap consistency: consistent renders produce a low `overlap_rms_rel`;
    /// injecting a 10% highlight boost in the secondary render triggers the >5%
    /// warning.
    ///
    /// We use ev=0 and ev=-1 (dark render) rather than a bright-shifted render
    /// because the overlap region x∈[0.5, 1.0] is covered by *bright* neutral
    /// patches in both renders (good 8-bit SNR):
    ///   ev=0   → spec_L=0.5..1.0 → display_L ≈ 0.45..0.60 → ~170/255
    ///   ev=-1  → spec_L=1.0..2.0 → l_shifted=0.5..1.0 → same display range
    /// A bright-EV render would cover the overlap with dark patches
    /// (high quantisation error), inflating the metric artificially.
    #[test]
    fn overlap_consistency_metric() {
        let chart = SyntheticSweepChart::new();
        let spec_json = chart.spec_to_json();
        let specs = parse_spec_json(&spec_json).expect("parse");

        let (png_ev0, w_ev0) = build_fake_render_ev(&chart, 0.0, None);

        // ── Consistent ev=-1 render (same analytic curve, darkened 1 stop) ───
        let (png_evm1_clean, w_evm1_clean) = build_fake_render_ev(&chart, -1.0, None);

        let renders_clean = [
            AcrRender {
                png_rgb: &png_ev0,
                png_w: w_ev0,
                ev: 0.0,
            },
            AcrRender {
                png_rgb: &png_evm1_clean,
                png_w: w_evm1_clean,
                ev: -1.0,
            },
        ];
        let model_clean = solve_acr_model_multi(&specs, &renders_clean).expect("clean solve");
        let rms_clean = model_clean
            .stats
            .overlap_rms_rel
            .expect("overlap_rms_rel must be present for 2-render fit");

        // 8-bit quantisation and per-bin scatter from `fit_tonescale` impose a
        // small floor.  The production warning fires at 5%; the test budget of
        // 10% absorbs the discrete-bin approximation error.
        assert!(
            rms_clean < 0.10,
            "consistent renders: overlap_rms_rel={rms_clean:.4} should be < 10% \
             (floor from 8-bit quantisation + binning)"
        );

        // ── Distorted ev=-1 render (10% highlight boost above l_shifted=0.3) ─
        // This injects a disagreement in the overlap region that violates the
        // Exposure2012-linearity assumption.
        let distort = |l_shifted: f32, display_base: f32| -> f32 {
            if l_shifted > 0.3 {
                let excess = (l_shifted - 0.3) / 0.5;
                display_base * (1.0 + 0.10 * excess.min(1.0))
            } else {
                display_base
            }
        };
        let (png_evm1_dist, w_evm1_dist) = build_fake_render_ev(&chart, -1.0, Some(&distort));

        let renders_dist = [
            AcrRender {
                png_rgb: &png_ev0,
                png_w: w_ev0,
                ev: 0.0,
            },
            AcrRender {
                png_rgb: &png_evm1_dist,
                png_w: w_evm1_dist,
                ev: -1.0,
            },
        ];
        let model_dist = solve_acr_model_multi(&specs, &renders_dist).expect("distorted solve");
        let rms_dist = model_dist
            .stats
            .overlap_rms_rel
            .expect("overlap_rms_rel must be present for 2-render fit");

        assert!(
            rms_dist > 0.05,
            "distorted renders: overlap_rms_rel={rms_dist:.4} should be > 5% \
             to trigger the linearity-assumption warning"
        );
    }

    /// `solve_acr_model_multi` must error when:
    ///   - no render has ev=0 (zero baseline renders)
    ///   - two renders have ev=0 (ambiguous baseline)
    /// And must succeed with exactly one ev=0 render.
    #[test]
    fn exactly_one_ev0_validation() {
        let chart = SyntheticSweepChart::new();
        let spec_json = chart.spec_to_json();
        let specs = parse_spec_json(&spec_json).expect("parse");

        let (png, w) = build_fake_render_ev(&chart, 0.0, None);
        let (png2, w2) = build_fake_render_ev(&chart, 1.0, None);

        // Zero ev=0 renders → error.
        let err_zero = solve_acr_model_multi(
            &specs,
            &[AcrRender {
                png_rgb: &png2,
                png_w: w2,
                ev: 1.0,
            }],
        );
        assert!(
            err_zero.is_err(),
            "expected error with zero ev=0 renders, got ok"
        );

        // Two ev=0 renders → error.
        let err_two = solve_acr_model_multi(
            &specs,
            &[
                AcrRender {
                    png_rgb: &png,
                    png_w: w,
                    ev: 0.0,
                },
                AcrRender {
                    png_rgb: &png,
                    png_w: w,
                    ev: 0.0,
                },
            ],
        );
        assert!(
            err_two.is_err(),
            "expected error with two ev=0 renders, got ok"
        );

        // Exactly one ev=0 → ok.
        let ok = solve_acr_model_multi(
            &specs,
            &[
                AcrRender {
                    png_rgb: &png,
                    png_w: w,
                    ev: 0.0,
                },
                AcrRender {
                    png_rgb: &png2,
                    png_w: w2,
                    ev: 1.0,
                },
            ],
        );
        assert!(ok.is_ok(), "expected ok with exactly one ev=0 render");
    }
}
