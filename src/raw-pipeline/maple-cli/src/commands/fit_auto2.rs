//! `maple-cli fit-auto2` — Auto 2.0 milestone M0 (#1740): offline fit-quality
//! report comparing the Auto 1.0 free residual LUT against the structured
//! fit-acr solver's JPEG-pair front-end, on ONE RAW file's own embedded JPEG.
//!
//! This is a measurement-only tool. It does not change what ships: no
//! pipeline wiring, no profile switch. It develops the RAW through the exact
//! PINNED Auto Profile fit prefix (mirroring
//! `raw_core::pipeline::render::auto_fit::develop_display_for_auto_fit`,
//! which is private to `raw-core` — this command replicates it stage-for-
//! stage from the public API so the fit-quality comparison samples the SAME
//! buffer the real Auto 1.0 fit runs against), samples the display-space
//! `(maple, jpeg)` pairs `auto_profile::pairs::sample_display_pairs` already
//! builds for the free-LUT fit, then runs BOTH models against them.
//!
//! Auto 1.0 is `fit_curve_from_preview_display` (the #550 tone curve)
//! composed with `fit_lut_from_pairs` (the free residual LUT, same 49-node
//! grid the shipping fit uses — `auto_profile::lut_fit::LUT_SIZE`, private,
//! so mirrored here as [`AUTO1_LUT_SIZE`]) as `curve ∘ residual`, exactly the
//! CPU render path's `fit_auto_profile_artifacts` order. Auto 2.0 is
//! `solve_acr_model_from_display_pairs` (tonescale + hue/chroma field) on the
//! SAME pre-curve pairs.
//!
//! For each, it reports: mean/RMS ΔE00 of the model's prediction vs the
//! measured JPEG pairs; smoothness (max second-difference of the model's own
//! residual along the neutral grey diagonal, reusing the
//! `no_second_difference_spike_across_sparse_boundary` instrument's shape);
//! and correction magnitude at three fully-saturated sRGB primary probe
//! points (colors a real photo's JPEG correspondence set almost never
//! actually reaches, so both fits must extrapolate/default there).
//!
//! Feature gate: `test-support` (the fit-acr solver only compiles under it).

use std::path::Path;

#[cfg(not(feature = "test-support"))]
pub fn run(_raw: &Path, _report: &Path) -> Result<i32, Box<dyn std::error::Error>> {
    Err(
        "fit-auto2 requires the `test-support` cargo feature (cargo run --features test-support)"
            .into(),
    )
}

#[cfg(feature = "test-support")]
mod imp {
    use std::path::Path;

    use raw_core::decode::decode_bytes;
    use raw_core::image::ColorSpace;
    use raw_core::pipeline::{develop_scene_linear_from_raw_with_quality, RenderQuality};
    use raw_core::stages::{color_grade, grain};
    use raw_core::types::adjustment::AutoExposureMode;
    use raw_core::view::acr_fit::{apply_model, solve_acr_model_from_display_pairs, AcrModel};
    use raw_core::view::auto_profile::fit_display::fit_curve_from_preview_display;
    use raw_core::view::auto_profile::lut::{fit_lut_from_pairs, ColorLut};
    use raw_core::view::auto_profile::pairs::{sample_display_pairs, DisplayPair};
    use raw_core::view::auto_profile::preview;
    use raw_core::view::auto_profile::{apply_curve, ProfileCurve};
    use raw_core::view::{agx, encode};
    use raw_core::xmp::AdjustmentModel;

    /// Grid resolution of the fitted per-image residual LUT — mirrors
    /// `auto_profile::lut_fit::LUT_SIZE` (private to that module), the actual
    /// value the shipping Auto 1.0 fit uses.
    const AUTO1_LUT_SIZE: usize = 49;

    /// Mean/RMS ΔE00 of a model's prediction vs the measured pairs.
    pub struct PredictMetrics {
        pub mean_de: f32,
        pub rms_de: f32,
    }

    /// Correction magnitude (ΔE00 between the model's output and its input)
    /// at a single fully-saturated sRGB primary probe point.
    pub struct GamutProbe {
        pub label: &'static str,
        pub correction_de: f32,
    }

    pub fn run(raw_path: &Path, report_path: &Path) -> Result<i32, Box<dyn std::error::Error>> {
        let bytes = std::fs::read(raw_path)
            .map_err(|e| format!("cannot read RAW {}: {e}", raw_path.display()))?;
        let ext = raw_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let raw = decode_bytes(&bytes, &ext).map_err(|e| format!("decode error: {e}"))?;

        // The embedded JPEG preview is the whole point of this tool — skip
        // cleanly (sentinel exit 3, matching `extract-preview`'s convention)
        // when there isn't one.
        let Some(extracted) = preview::extract_for_fit(raw_path) else {
            eprintln!(
                "[fit-auto2] {} has no extractable embedded JPEG preview — skipping",
                raw_path.display()
            );
            return Ok(3);
        };

        // ── Develop the PINNED Auto Profile fit prefix ──────────────────
        // Mirrors `pipeline::render::auto_fit::develop_display_for_auto_fit`
        // stage-for-stage (that fn is private to raw-core): default
        // AdjustmentModel with `auto_exposure: Off` pinned, the shared
        // scene-linear develop chain, then AgX / split-tone / grain /
        // gamut-matrix / gamma-encode — the render's display tail up to
        // (not including) the Auto Profile stage itself.
        let fit_model = AdjustmentModel {
            auto_exposure: AutoExposureMode::Off,
            ..AdjustmentModel::default()
        };
        let mut scene =
            develop_scene_linear_from_raw_with_quality(&raw, &fit_model, RenderQuality::Full)
                .map_err(|e| format!("develop error: {e}"))?;
        agx::apply(&mut scene, fit_model.contrast);
        color_grade::apply_model(&mut scene, &fit_model);
        grain::apply(
            &mut scene,
            fit_model.grain_amount,
            fit_model.grain_size,
            fit_model.grain_roughness,
        );
        encode::rec2020_to_srgb(&mut scene);
        encode::srgb_gamma_encode(&mut scene);
        scene.assert_space(ColorSpace::DisplayEncodedSrgb);

        let (w, h) = (scene.width as usize, scene.height as usize);
        let flat: Vec<f32> = scene
            .pixels
            .iter()
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect();

        // ── Sample the display-space (maple, jpeg) pairs — the shared front
        // door for both Auto 1.0's free LUT and Auto 2.0's structured solver.
        //
        // `sample_display_pairs` / `fit_curve_from_preview_display` each take
        // the preview by value AND rotate both it and their sensor-space RGB
        // buffer using the same `orientation` argument (see the "CRITICAL —
        // orientation alignment" comment on `fit_curve_from_preview_display`),
        // so `orientation` cannot be pre-applied to only one of the two
        // buffers without desyncing them (the test_0013 Rotate90 regression
        // this exact refactor hit once, before this fix). What CAN be
        // trimmed is clone count: only the first two calls need their own
        // owned copy of the preview, since the third and last use can take
        // `extracted.image` itself instead of cloning it again (Copilot
        // review, PR #1749).
        let pairs = sample_display_pairs(
            &flat,
            w,
            h,
            extracted.image.clone(),
            extracted.color_space,
            raw.orientation,
        );
        if pairs.len() < 256 {
            eprintln!(
                "[fit-auto2] {} yielded only {} display pairs (< 256) — skipping",
                raw_path.display(),
                pairs.len()
            );
            return Ok(3);
        }

        // ── Auto 1.0: curve ∘ residual-LUT, exactly `fit_auto_profile_artifacts`'s
        // order — fit the curve on the pre-curve buffer, apply it in place,
        // THEN fit the LUT on the now-curved buffer (its pairs are
        // `(curve(maple), jpeg)`, absorbing only the curve's residual).
        let curve = fit_curve_from_preview_display(
            extracted.image.clone(),
            extracted.color_space,
            &flat,
            w,
            h,
            raw.orientation,
        );
        let mut curved_flat = flat.clone();
        if let Some(c) = &curve {
            apply_curve(&mut curved_flat, c);
        }
        let curved_pairs = sample_display_pairs(
            &curved_flat,
            w,
            h,
            extracted.image,
            extracted.color_space,
            raw.orientation,
        );
        let residual_lut = fit_lut_from_pairs(&curved_pairs, AUTO1_LUT_SIZE, 1.0);

        // ── Auto 2.0: tonescale + hue/chroma field, from the SAME pairs.
        let model2_result = solve_acr_model_from_display_pairs(&pairs);

        // ── Metrics ──────────────────────────────────────────────────────
        let auto1_metrics = auto1_predict_metrics(&pairs, curve.as_ref(), &residual_lut);
        let auto1_smoothness = auto1_smoothness_second_diff(curve.as_ref(), &residual_lut);
        let auto1_gamut = auto1_gamut_probe(curve.as_ref(), &residual_lut);

        let fixture_name = raw_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");

        let report = match &model2_result {
            Ok(model2) => {
                let auto2_metrics = auto2_predict_metrics(&pairs, model2);
                let auto2_smoothness = auto2_smoothness_second_diff(model2);
                let auto2_gamut = auto2_gamut_probe(model2);
                format_report(
                    fixture_name,
                    pairs.len(),
                    &auto1_metrics,
                    auto1_smoothness,
                    &auto1_gamut,
                    Some(&auto2_metrics),
                    Some(auto2_smoothness),
                    Some(&auto2_gamut),
                    None,
                )
            }
            Err(e) => format_report(
                fixture_name,
                pairs.len(),
                &auto1_metrics,
                auto1_smoothness,
                &auto1_gamut,
                None,
                None,
                None,
                Some(e.clone()),
            ),
        };

        eprintln!("{report}");
        std::fs::write(report_path, &report)
            .map_err(|e| format!("cannot write report {}: {e}", report_path.display()))?;
        eprintln!("[fit-auto2] wrote report to {}", report_path.display());
        Ok(0)
    }

    // ── Auto 1.0 (curve ∘ residual) helpers ─────────────────────────────

    /// Apply the Auto 1.0 curve+LUT tail to one display-space RGB triplet.
    fn auto1_apply(rgb: [f32; 3], curve: Option<&ProfileCurve>, lut: &ColorLut) -> [f32; 3] {
        let mut buf = rgb;
        if let Some(c) = curve {
            apply_curve(&mut buf, c);
        }
        lut.sample(buf)
    }

    fn auto1_predict_metrics(
        pairs: &[DisplayPair],
        curve: Option<&ProfileCurve>,
        lut: &ColorLut,
    ) -> PredictMetrics {
        let mut sum_de = 0.0f64;
        let mut sum_sq = 0.0f64;
        for p in pairs {
            let pred = auto1_apply(p.maple, curve, lut);
            let de = de00_srgb_gamma(pred, p.jpeg);
            sum_de += de as f64;
            sum_sq += (de as f64) * (de as f64);
        }
        let n = pairs.len();
        PredictMetrics {
            mean_de: (sum_de / n as f64) as f32,
            rms_de: (sum_sq / n as f64).sqrt() as f32,
        }
    }

    /// Max |second difference| of the Auto 1.0 tail's residual (`predict(v,v,v) - v`
    /// on the red lane) along the neutral grey diagonal — reusing the exact
    /// shape of `auto_profile::lut_tests::max_second_diff_on_diagonal`, just
    /// walking the composed curve+LUT tail instead of the LUT alone.
    fn auto1_smoothness_second_diff(curve: Option<&ProfileCurve>, lut: &ColorLut) -> f32 {
        const STEPS: usize = 256;
        let residual = |i: usize| -> f32 {
            let v = i as f32 / (STEPS - 1) as f32;
            let out = auto1_apply([v, v, v], curve, lut);
            out[0] - v
        };
        (1..STEPS - 1)
            .map(|i| (residual(i + 1) - 2.0 * residual(i) + residual(i - 1)).abs())
            .fold(0.0f32, f32::max)
    }

    fn auto1_gamut_probe(curve: Option<&ProfileCurve>, lut: &ColorLut) -> Vec<GamutProbe> {
        gamut_probe_points()
            .iter()
            .map(|&(label, rgb)| {
                let out = auto1_apply(rgb, curve, lut);
                GamutProbe {
                    label,
                    correction_de: de00_srgb_gamma(out, rgb),
                }
            })
            .collect()
    }

    // ── Auto 2.0 (tonescale + field) helpers ────────────────────────────

    fn auto2_predict_metrics(pairs: &[DisplayPair], model: &AcrModel) -> PredictMetrics {
        use raw_core::color::matrices::M_REC2020_TO_SRGB;
        use raw_core::view::agx_inverse::srgb_gamma_inv;
        let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
            .inverse()
            .expect("M_REC2020_TO_SRGB invertible");
        let mut sum_de = 0.0f64;
        let mut sum_sq = 0.0f64;
        for p in pairs {
            let maple_lin_srgb = [
                srgb_gamma_inv(p.maple[0]),
                srgb_gamma_inv(p.maple[1]),
                srgb_gamma_inv(p.maple[2]),
            ];
            let maple_rec2020 = m_srgb_to_rec2020.mul_vec(maple_lin_srgb);
            let pred_rec2020 = apply_model(model, maple_rec2020);
            let pred_srgb_lin = M_REC2020_TO_SRGB.mul_vec(pred_rec2020);
            let pred_srgb_gamma = [
                encode_gamma(pred_srgb_lin[0].clamp(0.0, 1.0)),
                encode_gamma(pred_srgb_lin[1].clamp(0.0, 1.0)),
                encode_gamma(pred_srgb_lin[2].clamp(0.0, 1.0)),
            ];
            let de = de00_srgb_gamma(pred_srgb_gamma, p.jpeg);
            sum_de += de as f64;
            sum_sq += (de as f64) * (de as f64);
        }
        let n = pairs.len();
        PredictMetrics {
            mean_de: (sum_de / n as f64) as f32,
            rms_de: (sum_sq / n as f64).sqrt() as f32,
        }
    }

    fn auto2_smoothness_second_diff(model: &AcrModel) -> f32 {
        use raw_core::color::matrices::M_REC2020_TO_SRGB;
        use raw_core::view::agx_inverse::srgb_gamma_inv;
        let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
            .inverse()
            .expect("M_REC2020_TO_SRGB invertible");
        const STEPS: usize = 256;
        let residual = |i: usize| -> f32 {
            let v = i as f32 / (STEPS - 1) as f32;
            let maple_lin_srgb = [srgb_gamma_inv(v), srgb_gamma_inv(v), srgb_gamma_inv(v)];
            let maple_rec2020 = m_srgb_to_rec2020.mul_vec(maple_lin_srgb);
            let pred_rec2020 = apply_model(model, maple_rec2020);
            let pred_srgb_lin = M_REC2020_TO_SRGB.mul_vec(pred_rec2020);
            let pred_r_gamma = encode_gamma(pred_srgb_lin[0].clamp(0.0, 1.0));
            pred_r_gamma - v
        };
        (1..STEPS - 1)
            .map(|i| (residual(i + 1) - 2.0 * residual(i) + residual(i - 1)).abs())
            .fold(0.0f32, f32::max)
    }

    fn auto2_gamut_probe(model: &AcrModel) -> Vec<GamutProbe> {
        use raw_core::color::matrices::M_REC2020_TO_SRGB;
        use raw_core::view::agx_inverse::srgb_gamma_inv;
        let m_srgb_to_rec2020 = M_REC2020_TO_SRGB
            .inverse()
            .expect("M_REC2020_TO_SRGB invertible");
        gamut_probe_points()
            .iter()
            .map(|&(label, rgb)| {
                let maple_lin_srgb = [
                    srgb_gamma_inv(rgb[0]),
                    srgb_gamma_inv(rgb[1]),
                    srgb_gamma_inv(rgb[2]),
                ];
                let maple_rec2020 = m_srgb_to_rec2020.mul_vec(maple_lin_srgb);
                let pred_rec2020 = apply_model(model, maple_rec2020);
                let pred_srgb_lin = M_REC2020_TO_SRGB.mul_vec(pred_rec2020);
                let pred_srgb_gamma = [
                    encode_gamma(pred_srgb_lin[0].clamp(0.0, 1.0)),
                    encode_gamma(pred_srgb_lin[1].clamp(0.0, 1.0)),
                    encode_gamma(pred_srgb_lin[2].clamp(0.0, 1.0)),
                ];
                GamutProbe {
                    label,
                    correction_de: de00_srgb_gamma(pred_srgb_gamma, rgb),
                }
            })
            .collect()
    }

    // ── Shared helpers ───────────────────────────────────────────────────

    /// Three fully-saturated sRGB primaries, sitting exactly on the sRGB
    /// gamut boundary: colors a real photo's JPEG correspondence set almost
    /// never actually reaches (a busy scene rarely has a pixel that is
    /// PURELY red, green, or blue with zero of the other channels), so both
    /// fits have to extrapolate/default rather than interpolate here. Auto
    /// 1.0's free LUT is expected to still carry a large stale correction
    /// (extrapolated/clamped, not decayed); Auto 2.0's field defaults
    /// unsupported cells to identity by construction.
    fn gamut_probe_points() -> [(&'static str, [f32; 3]); 3] {
        [
            ("saturated_red", [1.0, 0.0, 0.0]),
            ("saturated_green", [0.0, 1.0, 0.0]),
            ("saturated_blue", [0.0, 0.0, 1.0]),
        ]
    }

    fn encode_gamma(x: f32) -> f32 {
        raw_core::view::encode::srgb_gamma(x)
    }

    /// CIEDE2000 between two sRGB-GAMMA-encoded (`DisplayEncodedSrgb`)
    /// triplets: decode both to linear, then to CIE Lab, then diff. Uses the
    /// same `srgb_linear_to_lab` / `ciede2000` the fit-acr solver's own
    /// self-check (`compute_fit_rms_de`) uses, re-derived here since those
    /// two functions are private to `raw_core::view::acr_fit::model`.
    fn de00_srgb_gamma(a_gamma: [f32; 3], b_gamma: [f32; 3]) -> f32 {
        use raw_core::view::agx_inverse::srgb_gamma_inv;
        let a_lin = [
            srgb_gamma_inv(a_gamma[0]),
            srgb_gamma_inv(a_gamma[1]),
            srgb_gamma_inv(a_gamma[2]),
        ];
        let b_lin = [
            srgb_gamma_inv(b_gamma[0]),
            srgb_gamma_inv(b_gamma[1]),
            srgb_gamma_inv(b_gamma[2]),
        ];
        let lab_a = srgb_linear_to_lab(a_lin);
        let lab_b = srgb_linear_to_lab(b_lin);
        ciede2000(lab_a, lab_b)
    }

    /// sRGB-linear → CIE L*a*b* (D65). Verbatim port of
    /// `raw_core::view::acr_fit::model::srgb_linear_to_lab` (private to that
    /// module) — kept identical so this tool's ΔE00 numbers match the
    /// solver's own `fit_rms_de` self-check exactly.
    fn srgb_linear_to_lab(rgb: [f32; 3]) -> [f32; 3] {
        let x = 0.4124564 * rgb[0] + 0.3575761 * rgb[1] + 0.1804375 * rgb[2];
        let y = 0.2126729 * rgb[0] + 0.7151522 * rgb[1] + 0.0721750 * rgb[2];
        let z = 0.0193339 * rgb[0] + 0.1191920 * rgb[1] + 0.9503041 * rgb[2];
        let xn = x / 0.95047;
        let yn = y / 1.00000;
        let zn = z / 1.08883;
        let f = |t: f32| {
            if t > 0.008856 {
                t.cbrt()
            } else {
                7.787 * t + 16.0 / 116.0
            }
        };
        let l = 116.0 * f(yn) - 16.0;
        let a = 500.0 * (f(xn) - f(yn));
        let b = 200.0 * (f(yn) - f(zn));
        [l, a, b]
    }

    /// CIEDE2000 colour difference. Verbatim port of
    /// `raw_core::view::acr_fit::model::ciede2000` (private to that module).
    fn ciede2000(lab1: [f32; 3], lab2: [f32; 3]) -> f32 {
        let (l1, a1, b1) = (lab1[0], lab1[1], lab1[2]);
        let (l2, a2, b2) = (lab2[0], lab2[1], lab2[2]);

        let c1 = (a1 * a1 + b1 * b1).sqrt();
        let c2 = (a2 * a2 + b2 * b2).sqrt();
        let avg_c = (c1 + c2) / 2.0;
        let c7 = avg_c.powi(7);
        let g = 0.5 * (1.0 - (c7 / (c7 + 25.0f32.powi(7))).sqrt());
        let a1p = a1 * (1.0 + g);
        let a2p = a2 * (1.0 + g);
        let c1p = (a1p * a1p + b1 * b1).sqrt();
        let c2p = (a2p * a2p + b2 * b2).sqrt();

        let h1p = if b1 == 0.0 && a1p == 0.0 {
            0.0
        } else {
            b1.atan2(a1p)
                .rem_euclid(2.0 * std::f32::consts::PI)
                .to_degrees()
        };
        let h2p = if b2 == 0.0 && a2p == 0.0 {
            0.0
        } else {
            b2.atan2(a2p)
                .rem_euclid(2.0 * std::f32::consts::PI)
                .to_degrees()
        };

        let dl = l2 - l1;
        let dc = c2p - c1p;
        let dh_p = if c1p * c2p == 0.0 {
            0.0
        } else if (h2p - h1p).abs() <= 180.0 {
            h2p - h1p
        } else if h2p - h1p > 180.0 {
            h2p - h1p - 360.0
        } else {
            h2p - h1p + 360.0
        };
        let dh = 2.0 * (c1p * c2p).sqrt() * (dh_p / 2.0).to_radians().sin();

        let avg_lp = (l1 + l2) / 2.0;
        let avg_cp = (c1p + c2p) / 2.0;
        let avg_hp = if c1p * c2p == 0.0 {
            h1p + h2p
        } else if (h1p - h2p).abs() <= 180.0 {
            (h1p + h2p) / 2.0
        } else if h1p + h2p < 360.0 {
            (h1p + h2p + 360.0) / 2.0
        } else {
            (h1p + h2p - 360.0) / 2.0
        };

        let t = 1.0 - 0.17 * ((avg_hp - 30.0).to_radians()).cos()
            + 0.24 * (2.0 * avg_hp.to_radians()).cos()
            + 0.32 * (3.0 * avg_hp.to_radians() + 6.0f32.to_radians()).cos()
            - 0.20 * (4.0 * avg_hp.to_radians() - 63.0f32.to_radians()).cos();

        let sl = 1.0 + 0.015 * (avg_lp - 50.0).powi(2) / (20.0 + (avg_lp - 50.0).powi(2)).sqrt();
        let sc = 1.0 + 0.045 * avg_cp;
        let sh = 1.0 + 0.015 * avg_cp * t;
        let cp7 = avg_cp.powi(7);
        let rc = 2.0 * (cp7 / (cp7 + 25.0f32.powi(7))).sqrt();
        let d_theta = 30.0 * (-((avg_hp - 275.0) / 25.0).powi(2)).exp();
        let rt = -(rc * (2.0 * d_theta.to_radians()).sin());

        let lterm = dl / sl;
        let cterm = dc / sc;
        let hterm = dh / sh;
        (lterm * lterm + cterm * cterm + hterm * hterm + rt * cterm * hterm).sqrt()
    }

    #[allow(clippy::too_many_arguments)]
    fn format_report(
        fixture_name: &str,
        pair_count: usize,
        auto1_metrics: &PredictMetrics,
        auto1_smoothness: f32,
        auto1_gamut: &[GamutProbe],
        auto2_metrics: Option<&PredictMetrics>,
        auto2_smoothness: Option<f32>,
        auto2_gamut: Option<&[GamutProbe]>,
        auto2_error: Option<String>,
    ) -> String {
        let mut s = String::new();
        s.push_str(&format!("fixture: {fixture_name}\n"));
        s.push_str(&format!("pairs: {pair_count}\n"));
        s.push_str(&format!(
            "auto1_mean_de00: {:.4}\nauto1_rms_de00: {:.4}\nauto1_smoothness_max_second_diff: {:.5}\n",
            auto1_metrics.mean_de, auto1_metrics.rms_de, auto1_smoothness
        ));
        for g in auto1_gamut {
            s.push_str(&format!(
                "auto1_gamut_probe[{}]: {:.4}\n",
                g.label, g.correction_de
            ));
        }
        match (auto2_metrics, auto2_smoothness, auto2_gamut) {
            (Some(m), Some(sm), Some(gamut)) => {
                s.push_str(&format!(
                    "auto2_mean_de00: {:.4}\nauto2_rms_de00: {:.4}\nauto2_smoothness_max_second_diff: {:.5}\n",
                    m.mean_de, m.rms_de, sm
                ));
                for g in gamut {
                    s.push_str(&format!(
                        "auto2_gamut_probe[{}]: {:.4}\n",
                        g.label, g.correction_de
                    ));
                }
            }
            _ => {
                s.push_str(&format!(
                    "auto2_fit_error: {}\n",
                    auto2_error.unwrap_or_else(|| "unknown".to_string())
                ));
            }
        }
        s
    }
}

#[cfg(feature = "test-support")]
pub fn run(raw: &Path, report: &Path) -> Result<i32, Box<dyn std::error::Error>> {
    imp::run(raw, report)
}
