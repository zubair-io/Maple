//! Tests for the `auto_profile` module.
//!
//! Each task lands its tests in its own submodule so parallel work doesn't
//! collide. Task T2 → `curve_tests`. Task T3 → `apply_tests`. Task T1 →
//! `preview_tests`. Task T4 → `fit_tests`.

#[cfg(test)]
mod preview_tests {
    use super::super::preview::{extract_preview, extract_preview_from_bytes};
    use std::path::{Path, PathBuf};

    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn test_0017_extracts_jpeg_preview() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0017.dng");
        let preview = extract_preview(&path).expect("test_0017 has an embedded JPEG");
        assert!(
            preview.width() >= 256,
            "preview too small: {}",
            preview.width()
        );
        assert!(
            preview.height() >= 256,
            "preview too small: {}",
            preview.height()
        );
    }

    #[test]
    fn missing_file_returns_none_not_panic() {
        let path = Path::new("/nonexistent/path.dng");
        assert!(extract_preview(path).is_none());
    }

    /// Regression for #927: rawler 0.7.2 implements `preview_image()` for NO
    /// format (the trait default returns `None`), so the embedded JPEG must be
    /// recovered via `full_image()` IN-PROCESS. This drives the BYTES path used
    /// by Web/WASM and iOS, which have no exiftool/subprocess fallback at all —
    /// so a green here proves Auto Profile no longer silently degrades to
    /// Neutral on those platforms. Before the `full_image()` fallback this
    /// returned `None` (the bytes path had no exiftool to lean on), and
    /// `--profile auto` was byte-identical to `--profile neutral` (ΔE 0.0) for
    /// CR2/DNG/ARW whenever exiftool was absent.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn cr2_preview_extracts_in_process_without_subprocess() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0003.CR2");
        let bytes = std::fs::read(&path).expect("read test_0003.CR2 fixture");
        let preview = extract_preview_from_bytes(&bytes, "cr2")
            .expect("CR2 embedded preview must extract in-process (no exiftool)");
        assert!(
            preview.width() >= 256 && preview.height() >= 256,
            "preview too small: {}x{}",
            preview.width(),
            preview.height()
        );
    }

    /// Regression for #930: previews that rawler's `full_image()` misses must
    /// still extract IN-PROCESS (bytes path — Web/iOS, no subprocess).
    ///  - test_0013 / test_0015: the reduced-res preview lives in the ROOT IFD
    ///    (`NewSubFileType==1`); `full_image` only checks SUB-IFDs, so it misses
    ///    it. Recovered via `thumbnail_image` (which targets `NewSubFileType==1`,
    ///    never the full-res RAW-as-JPEG beside it).
    ///  - test_0016: Sigma X3F — rawler has no full/preview/thumbnail and no IFD
    ///    tree; recovered via the embedded-JPEG byte scan.
    /// The 680×512 assertion on test_0015 is the non-circular CANARY: the file's
    /// CFA RAW is 4080×3072, so grabbing the RAW (or the wrong IFD) fails loudly.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn gap_formats_extract_preview_in_process_without_subprocess() {
        // (fixture, ext hint, exact preview dims to assert — None = just non-empty)
        let cases: &[(&str, &str, Option<(u32, u32)>)] = &[
            ("test_0015.dng", "dng", Some((680, 512))), // preview, NOT the 4080×3072 CFA RAW
            ("test_0013.DNG", "dng", None), // preview 4032×3024 (== RAW dims; ΔE-checked elsewhere)
            ("test_0016.X3F", "x3f", None), // Sigma X3F preview via byte scan
        ];
        for (name, ext, dims) in cases {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../test-fixtures/raws")
                .join(name);
            let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {name}: {e}"));
            let img = extract_preview_from_bytes(&bytes, ext)
                .unwrap_or_else(|| panic!("{name}: preview must extract in-process (no exiftool)"));
            assert!(
                img.width() >= 256 && img.height() >= 256,
                "{name}: preview too small {}x{}",
                img.width(),
                img.height()
            );
            if let Some((w, h)) = dims {
                assert_eq!(
                    (img.width(), img.height()),
                    (*w, *h),
                    "{name}: expected PREVIEW {w}x{h}, got {}x{} — grabbed the RAW?",
                    img.width(),
                    img.height()
                );
            }
        }
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
        // All values ≤ KNEE (0.95), so compress_input is identity.
        let mut rgb: Vec<f32> = vec![0.1, 0.4, 0.7, 0.2, 0.5, 0.8];
        let original = rgb.clone();
        apply_curve(&mut rgb, &ProfileCurve::identity());
        for (a, b) in rgb.iter().zip(original.iter()) {
            assert!((a - b).abs() < 1e-6, "a={a} b={b}");
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
            matrix: super::super::IDENTITY_MATRIX,
            chroma_boost: 1.0,
            chroma_offset: [0.0, 0.0],
            lightness_offset: 0.0,
            lightness_band_offsets: [0.0; 5],
            ab_band_offsets: [[0.0, 0.0]; 5],
        };

        let mut rgb: Vec<f32> = vec![0.1, 0.1, 0.1, 0.3, 0.3, 0.3];
        apply_curve(&mut rgb, &curve);
        for &v in &rgb {
            // compress_input(0.1) = 0.1 (below KNEE) -> curve maps 0.1 → 0.2
            // compress_input(0.3) = 0.3 (below KNEE) -> curve maps 0.3 → 0.6
            assert!((v - 0.2).abs() < 0.05 || (v - 0.6).abs() < 0.05, "got {v}");
        }
    }

    /// #1948: the chroma branch must operate in LINEAR light. The fit buffer
    /// is `DisplayEncodedSrgb` (sRGB primaries + gamma), so `apply_curve` must
    /// gamma-decode, run the sRGB-primaries Oklab correction, then re-encode.
    /// This pins that exact space handling: the expected value is computed by
    /// replicating the intended linear-space pipeline, so a regression back to
    /// `rec2020_to_oklab` on gamma-encoded values fails the test.
    #[test]
    fn chroma_boost_operates_in_linear_srgb_space() {
        use crate::color::oklab::{oklab_to_srgb_linear, srgb_linear_to_oklab};
        use crate::view::agx_inverse::srgb_gamma_inv;
        use crate::view::encode::srgb_gamma;

        // Identity channel curves + identity matrix, so only the chroma branch
        // moves the pixel. A saturated, non-neutral display pixel exposes the
        // primaries/gamma handling (a neutral gray is a fixed point of both).
        let mut curve = ProfileCurve::identity();
        curve.chroma_boost = 1.3;
        let input = [0.80_f32, 0.20, 0.30];

        // Expected: replicate the intended linear-sRGB Oklab round-trip. Channel
        // curves/matrix are identity and inputs are below KNEE, so the pre-chroma
        // RGB equals `input`.
        let lin = [
            srgb_gamma_inv(input[0]),
            srgb_gamma_inv(input[1]),
            srgb_gamma_inv(input[2]),
        ];
        let lab = srgb_linear_to_oklab(lin);
        let scaled = [lab[0], lab[1] * 1.3, lab[2] * 1.3];
        let back = oklab_to_srgb_linear(scaled);
        let expected = [srgb_gamma(back[0]), srgb_gamma(back[1]), srgb_gamma(back[2])];

        let mut rgb = input.to_vec();
        apply_curve(&mut rgb, &curve);
        for (got, want) in rgb.iter().zip(expected.iter()) {
            assert!((got - want).abs() < 1e-5, "got {got} want {want}");
        }
        // Sanity: a positive chroma boost must raise the pixel's actual Oklab
        // chroma magnitude (sqrt(a² + b²)) — the quantity the stage scales —
        // versus the untouched input, proving the branch fired and pushed the
        // color away from neutral rather than collapsing it. (A raw channel
        // difference is not a reliable saturation proxy: the boost redistributes
        // across channels, so it can shrink even when chroma grows.)
        let oklab_chroma = |p: [f32; 3]| -> f32 {
            let lab =
                srgb_linear_to_oklab([srgb_gamma_inv(p[0]), srgb_gamma_inv(p[1]), srgb_gamma_inv(p[2])]);
            (lab[1] * lab[1] + lab[2] * lab[2]).sqrt()
        };
        let chroma_in = oklab_chroma(input);
        let chroma_out = oklab_chroma([rgb[0], rgb[1], rgb[2]]);
        assert!(
            chroma_out > chroma_in,
            "chroma boost must increase Oklab chroma: {chroma_in} -> {chroma_out}"
        );
    }

    /// #1948: a neutral gray has zero Oklab chroma, so any `chroma_boost` must
    /// leave it exactly neutral (and, with no L offset, unchanged) — the branch
    /// must not tint or shift a gray.
    #[test]
    fn chroma_boost_preserves_neutral_gray() {
        let mut curve = ProfileCurve::identity();
        curve.chroma_boost = 2.0;
        let mut rgb: Vec<f32> = vec![0.5, 0.5, 0.5];
        apply_curve(&mut rgb, &curve);
        assert!((rgb[0] - 0.5).abs() < 1e-4, "r shifted: {}", rgb[0]);
        assert!((rgb[1] - 0.5).abs() < 1e-4, "g shifted: {}", rgb[1]);
        assert!((rgb[2] - 0.5).abs() < 1e-4, "b shifted: {}", rgb[2]);
    }

    #[test]
    fn out_of_range_inputs_are_clamped() {
        let mut rgb: Vec<f32> = vec![-0.5, 1.5, 0.5];
        apply_curve(&mut rgb, &ProfileCurve::identity());
        // For -0.5: compress_input clamps to 0.0; identity → 0.0.
        assert!(
            (rgb[0] - 0.0).abs() < 1e-6,
            "neg clamped to 0, got {}",
            rgb[0]
        );
        // For 1.5: above KNEE (0.95), soft compress to roughly
        //   0.95 + 0.05 * (over/(1+over)) where over = (1.5-0.95)/0.05 = 11
        //   = 0.95 + 0.05 * (11/12) = 0.95 + 0.0458 = 0.9958
        assert!(rgb[1] > 0.95 && rgb[1] < 1.0, "soft-knee, got {}", rgb[1]);
        // For 0.5: below KNEE, identity.
        assert!((rgb[2] - 0.5).abs() < 1e-6, "got {}", rgb[2]);
    }
}

#[cfg(test)]
mod fit_tests {
    use super::super::fit_curve_from_raw_display as fit_curve_from_raw;
    use crate::image::ExifOrientation;
    use std::path::Path;
    use std::path::PathBuf;
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn fit_curve_accepts_orientation_arg_and_returns_non_identity() {
        // Smoke test: `fit_curve_from_raw` accepts an `ExifOrientation`
        // argument and uses it (#550). Both the source buffer and the
        // embedded JPEG are sensor-frame at the fit stage; the fit rotates
        // BOTH into display orientation so they pair spatially the same way
        // the gate pairs the final display-oriented render against the
        // display-oriented preview. This test confirms the call accepts the
        // orientation and that a non-identity curve falls out.
        let raw_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0003.CR2");
        let w = 256_usize;
        let h = 256_usize;
        let source: Vec<f32> = (0..w * h * 3).map(|i| (i % 256) as f32 / 255.0).collect();
        let curve = fit_curve_from_raw(&raw_path, &source, w, h, ExifOrientation::Rotate90)
            .expect("preview should produce a curve");
        let mut differs = false;
        for (in_v, out_v) in &curve.r.anchors {
            if (in_v - out_v).abs() > 0.01 {
                differs = true;
                break;
            }
        }
        assert!(
            differs,
            "fit produced identity — extraction probably failed silently"
        );
    }

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
        let curve = fit_curve_from_raw(&raw_path, &source, w, h, ExifOrientation::Normal)
            .expect("test_0017 has a usable JPEG preview");
        let mut differs = false;
        for (in_v, out_v) in &curve.r.anchors {
            if (in_v - out_v).abs() > 0.01 {
                differs = true;
                break;
            }
        }
        assert!(
            differs,
            "fit produced identity — extraction probably failed silently"
        );
    }

    #[test]
    fn missing_raw_returns_none() {
        let path = Path::new("/nonexistent/path.dng");
        let dummy = vec![0.5_f32; 3];
        let result = fit_curve_from_raw(path, &dummy, 1, 1, ExifOrientation::Normal);
        assert!(result.is_none());
    }

    /// PR-B (#555) parity: the bytes-based fit path used by `raw-wasm` must
    /// produce the same `ProfileCurve` as the path-based fit on the same
    /// RAW + identical source pixels. Confirms the helper factoring in
    /// `preview.rs` and `fit_display.rs` didn't introduce a behavioural delta.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn fit_bytes_matches_fit_path() {
        use super::super::fit_curve_from_bytes_display as fit_curve_from_bytes;
        let raw_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0017.dng");
        let raw_bytes = std::fs::read(&raw_path).expect("read raw bytes");
        let w = 256_usize;
        let h = 256_usize;
        let source: Vec<f32> = (0..w * h * 3).map(|i| (i % 256) as f32 / 255.0).collect();
        let from_path = fit_curve_from_raw(&raw_path, &source, w, h, ExifOrientation::Normal)
            .expect("path fit");
        let from_bytes =
            fit_curve_from_bytes(&raw_bytes, "dng", &source, w, h, ExifOrientation::Normal)
                .expect("bytes fit");
        assert_eq!(from_path, from_bytes);
    }
}
