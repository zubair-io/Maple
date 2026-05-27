//! Tests for the `auto_profile` module.
//!
//! Each task lands its tests in its own submodule so parallel work doesn't
//! collide. Task T2 → `curve_tests`. Task T3 → `apply_tests`. Task T1 →
//! `preview_tests`. Task T4 → `fit_tests`.

#[cfg(test)]
mod preview_tests {
    use super::super::preview::extract_preview;
    use std::path::{Path, PathBuf};

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn test_0017_extracts_jpeg_preview() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0017.dng");
        let preview = extract_preview(&path).expect("test_0017 has an embedded JPEG");
        assert!(preview.width() >= 256, "preview too small: {}", preview.width());
        assert!(preview.height() >= 256, "preview too small: {}", preview.height());
    }

    #[test]
    fn missing_file_returns_none_not_panic() {
        let path = Path::new("/nonexistent/path.dng");
        assert!(extract_preview(path).is_none());
    }
}

#[cfg(test)]
mod curve_tests {
    use super::super::curve::{build_cdf, eval_channel, fit_channel_curve, ChannelCurve};

    #[test]
    fn identity_curve_evaluates_to_input() {
        let c = ChannelCurve::identity();
        for v in [0.0_f32, 0.25, 0.5, 0.75, 1.0] {
            let out = eval_channel(&c, v);
            assert!((out - v).abs() < 1e-6, "v={v} out={out}");
        }
    }

    #[test]
    fn cdf_of_uniform_is_linear() {
        // 1000 evenly-spaced values in [0,1]
        let samples: Vec<f32> = (0..1000).map(|i| i as f32 / 999.0).collect();
        let cdf = build_cdf(&samples, 256);
        // For uniform input, CDF should be approximately linear:
        // cdf[i] approx = i / 255
        for i in 0..256 {
            let expected = i as f32 / 255.0;
            assert!(
                (cdf[i] - expected).abs() < 0.02,
                "i={i} cdf={} expected={}",
                cdf[i],
                expected
            );
        }
    }

    #[test]
    fn fit_identity_when_source_equals_target() {
        // Same distribution → curve should be ~identity.
        let samples: Vec<f32> = (0..1000).map(|i| i as f32 / 999.0).collect();
        let curve = fit_channel_curve(&samples, &samples);
        for v in [0.1_f32, 0.3, 0.5, 0.7, 0.9] {
            let out = eval_channel(&curve, v);
            assert!(
                (out - v).abs() < 0.03,
                "v={v} out={out} (expected identity)"
            );
        }
    }

    #[test]
    fn fit_recovers_known_gamma_curve() {
        // Source = uniform [0,1]; target = source^2 (gamma=2.0).
        let n = 10_000;
        let source: Vec<f32> = (0..n).map(|i| i as f32 / (n - 1) as f32).collect();
        let target: Vec<f32> = source.iter().map(|v| v * v).collect();
        let curve = fit_channel_curve(&source, &target);
        // eval_channel(curve, x) should be approximately x^2.
        for x in [0.1_f32, 0.3, 0.5, 0.7, 0.9] {
            let predicted = eval_channel(&curve, x);
            let actual = x * x;
            assert!(
                (predicted - actual).abs() < 0.02,
                "x={x} predicted={predicted} actual={actual}"
            );
        }
    }

    #[test]
    fn monotonicity_preserved() {
        let n = 10_000;
        let source: Vec<f32> = (0..n).map(|i| i as f32 / (n - 1) as f32).collect();
        let target: Vec<f32> = source.iter().map(|v| (v * 2.0).min(1.0)).collect();
        let curve = fit_channel_curve(&source, &target);
        let mut prev = -1.0;
        for i in 0..100 {
            let x = i as f32 / 99.0;
            let y = eval_channel(&curve, x);
            assert!(y >= prev - 1e-4, "non-monotone at x={x}: y={y} prev={prev}");
            prev = y;
        }
    }
}

#[cfg(test)]
mod apply_tests {
    use super::super::{apply_curve, ChannelCurve, ProfileCurve};

    #[test]
    fn identity_curve_leaves_buffer_unchanged() {
        let mut rgb: Vec<f32> = vec![0.1, 0.4, 0.7, 0.2, 0.5, 0.8];
        let original = rgb.clone();
        apply_curve(&mut rgb, &ProfileCurve::identity());
        for (a, b) in rgb.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn double_brightness_curve_doubles_each_channel() {
        // Build a curve that maps x → min(2x, 1.0)
        let mut anchors = [(0.0_f32, 0.0_f32); 32];
        for i in 0..32 {
            let in_v = i as f32 / 31.0;
            anchors[i] = (in_v, (in_v * 2.0).min(1.0));
        }
        let cc = ChannelCurve { anchors };
        let curve = ProfileCurve {
            r: cc.clone(),
            g: cc.clone(),
            b: cc,
        };

        let mut rgb: Vec<f32> = vec![0.1, 0.1, 0.1, 0.3, 0.3, 0.3];
        apply_curve(&mut rgb, &curve);
        for &v in &rgb {
            assert!((v - 0.2).abs() < 0.05 || (v - 0.6).abs() < 0.05, "got {v}");
        }
    }

    #[test]
    fn out_of_range_inputs_are_clamped() {
        let mut rgb: Vec<f32> = vec![-0.5, 1.5, 0.5];
        apply_curve(&mut rgb, &ProfileCurve::identity());
        assert!((rgb[0] - 0.0).abs() < 1e-6, "neg clamped to 0, got {}", rgb[0]);
        assert!((rgb[1] - 1.0).abs() < 1e-6, "over clamped to 1, got {}", rgb[1]);
    }
}

#[cfg(test)]
mod fit_tests {
    use super::super::fit_curve_from_raw;
    use std::path::{Path, PathBuf};

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn fit_curve_against_test_0017_jpeg_is_not_identity() {
        // Manifest-relative path; matches the convention used by every
        // other fixture-loading test in raw-core (decode.rs, api.rs,
        // pipeline/{develop,render,tile}/*, color/dcp.rs, …).
        let raw_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0017.dng");
        let w = 256_usize;
        let h = 256_usize;
        // Synthetic uniform ramp as source — fit should produce a non-identity
        // curve because the JPEG's distribution will differ.
        let source: Vec<f32> = (0..w * h * 3).map(|i| (i % 256) as f32 / 255.0).collect();
        let curve = fit_curve_from_raw(&raw_path, &source, w, h)
            .expect("test_0017 has a usable JPEG preview");
        let mut differs = false;
        for (in_v, out_v) in &curve.r.anchors {
            if (in_v - out_v).abs() > 0.01 {
                differs = true;
                break;
            }
        }
        assert!(differs, "fit produced identity — extraction probably failed silently");
    }

    #[test]
    fn missing_raw_returns_none() {
        let path = Path::new("/nonexistent/path.dng");
        let dummy = vec![0.5_f32; 3];
        let result = fit_curve_from_raw(path, &dummy, 1, 1);
        assert!(result.is_none());
    }
}
