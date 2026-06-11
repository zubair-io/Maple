//! End-to-end ML smoke test (#1139): ALIKED + LightGlue on a synthetic
//! overlapping pair rendered by this crate's own ground-truth renderer.
//!
//! House pattern: the test **skip-passes with an explicit message** when
//! the environment can't run it — `MAPLE_PANO_MODELS` unset, model files
//! absent, or the onnxruntime dylib unavailable (CI has none of these).
//! Anything else — digest mismatch, interface drift, inference failure,
//! geometric garbage — fails loudly.
//!
//! Because the pair comes from `render::build_camera_set` +
//! `render::render_frame`, the cameras are *exactly* known, so the gate
//! is real geometry, not vibes: every match is reprojected from frame 0
//! into frame 1 through the ground-truth rotations and must mostly agree
//! with LightGlue's correspondence.
//!
//! Run locally:
//! ```text
//! MAPLE_PANO_MODELS=~/.cache/maple-pano/models \
//! ORT_DYLIB_PATH=.../onnxruntime-osx-arm64-1.23.2/lib/libonnxruntime.1.23.2.dylib \
//! cargo test -p maple-pano --features ml --test ml_smoke -- --nocapture
//! ```
//!
//! Use ONNX Runtime **1.23+**: 1.22.0 satisfies the API floor and inference
//! works, but its dylib aborts in its own static teardown at process exit
//! on macOS ("mutex lock failed") — reproduced with a minimal standalone
//! `ort` binary, nothing this crate controls — which would fail the test
//! run after every assertion has already passed.

#![cfg(feature = "ml")]

use maple_pano::features::{AlikedDetector, DetectorOptions, KeypointFilter, LinearRgbFrame};
use maple_pano::matching::{LightGlueMatcher, MatcherOptions, MlMatch};
use maple_pano::models::ModelDir;
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::source::EquirectSource;
use maple_pano::Camera;

/// Skip-pass marker — keep the message format stable; it is the signal a
/// CI log greps for to distinguish "skipped" from "silently green".
fn skip(reason: impl std::fmt::Display) {
    eprintln!("ml_smoke: SKIP-PASS — {reason}");
}

/// Frame geometry for the pair: two cameras 32.5° apart in yaw (50%
/// overlap at 65° HFOV), no distortion, no jitter — every parameter
/// recoverable from the returned `CameraGt`s bit-for-bit.
fn pair_options() -> CameraSetOptions {
    CameraSetOptions {
        count: 2,
        pattern: Pattern::Ring { full: false },
        fov_deg: 65.0,
        overlap: 0.5,
        pitch_deg: 0.0,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: 1280,
        height: 960,
    }
}

/// Deterministic multi-octave value noise on the equirect grid — locally
/// distinctive texture everywhere on the sphere.
///
/// The crate's default procedural scene (`EquirectSource::synthetic`) is
/// built for gain/RMSE metrics and is dominated by a *periodic* 15°
/// checkerboard; descriptors of distinct cell corners are near-identical,
/// and LightGlue confidently locks whole regions onto a one-or-two-cell
/// shifted alignment (observed: median reprojection error ≈ 586 px ≈ 2 ×
/// the 295 px cell pitch). Real photographs are not periodic at frame
/// scale, so the matcher smoke uses aperiodic noise; the periodic-texture
/// failure mode belongs to #1138's MAGSAC++ verification stage, not the
/// raw matcher contract under test here.
fn noise_source(width: u32, height: u32) -> EquirectSource {
    fn hash(x: u64, y: u64, octave: u64) -> f32 {
        let mut h = x
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .wrapping_add(y.wrapping_mul(0xC2B2_AE3D_27D4_EB4F))
            .wrapping_add(octave.wrapping_mul(0x1656_67B1_9E37_79F9));
        h ^= h >> 33;
        h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
        h ^= h >> 33;
        (h & 0xFFFF) as f32 / 65535.0
    }
    let mut pixels = Vec::with_capacity(width as usize * height as usize);
    for y in 0..height as usize {
        for x in 0..width as usize {
            let mut v = 0.0_f32;
            let mut amp = 0.5_f32;
            // Octave cells in source texels; at this test's ~3.4× source→
            // frame magnification they appear at ≈ 270/68/17 frame px.
            for (octave, cell) in [(0_u64, 80_usize), (1, 20), (2, 5)] {
                let (gx, gy) = ((x / cell) as u64, (y / cell) as u64);
                let fx = (x % cell) as f32 / cell as f32;
                let fy = (y % cell) as f32 / cell as f32;
                let top = hash(gx, gy, octave) * (1.0 - fx) + hash(gx + 1, gy, octave) * fx;
                let bot = hash(gx, gy + 1, octave) * (1.0 - fx) + hash(gx + 1, gy + 1, octave) * fx;
                v += amp * (top * (1.0 - fy) + bot * fy);
                amp *= 0.5;
            }
            pixels.push([v; 3]);
        }
    }
    EquirectSource {
        width,
        height,
        pixels,
    }
}

#[test]
fn aliked_lightglue_end_to_end_on_synthetic_pair() {
    // ---- Environment gates (skip-pass class) ---------------------------
    let models = match ModelDir::resolve(None) {
        Ok(m) => m,
        Err(e) if e.is_environment_missing() => return skip(e),
        Err(e) => panic!("model verification failed (not an absence — investigate): {e}"),
    };
    // Reference-faithful flow for the top-k export: keep all graph
    // keypoints (the reference runtime applies no detector-score
    // threshold in top-k mode — junk-tail keypoints are culled by the
    // 0.2 *match*-confidence filter instead). The production default
    // (`score_threshold: Some(0.2)`) would also work on real photos, but
    // the deliberately bland synthetic scene scores most structure below
    // 0.2 and would starve the matcher.
    let detector_options = DetectorOptions {
        filter: KeypointFilter {
            score_threshold: None,
            nms_radius: None,
            max_keypoints: None,
        },
        intra_threads: None,
    };
    let mut detector = match AlikedDetector::load(&models, detector_options) {
        Ok(d) => d,
        Err(e) if e.is_environment_missing() => return skip(e),
        Err(e) => panic!("ALIKED load failed: {e}"),
    };
    let mut matcher = match LightGlueMatcher::load(&models, MatcherOptions::default()) {
        Ok(m) => m,
        Err(e) if e.is_environment_missing() => return skip(e),
        Err(e) => panic!("LightGlue load failed: {e}"),
    };

    // ---- Render the pair (in-process, deterministic) --------------------
    let source = noise_source(4096, 2048);
    let opts = pair_options();
    // Same jitter-stream derivation as `render::run` for reproducibility
    // of the numbers quoted in the PR (seed 7).
    let mut cam_rng = SplitMix64::new(7 ^ 0xA076_1D64_78BD_642F);
    let cams_gt = build_camera_set(&opts, &mut cam_rng).expect("camera set");
    assert_eq!(cams_gt.len(), 2);
    let cams: Vec<Camera> = cams_gt.iter().map(|c| c.to_camera()).collect();

    let mut frames = Vec::with_capacity(2);
    for cam in &cams {
        let data = render_frame(&source, cam, 2).expect("render");
        frames.push(LinearRgbFrame::from_u16_rgb(cam.width, cam.height, &data).expect("frame"));
    }

    // ---- Detect + match -------------------------------------------------
    let fs0 = detector.detect(&frames[0]).expect("detect frame 0");
    let fs1 = detector.detect(&frames[1]).expect("detect frame 1");
    eprintln!(
        "ml_smoke: keypoints frame0={} frame1={} (descriptor_dim={})",
        fs0.len(),
        fs1.len(),
        fs0.descriptor_dim
    );
    assert!(
        fs0.len() >= 500 && fs1.len() >= 500,
        "top-k export must yield a healthy keypoint population, got {} / {}",
        fs0.len(),
        fs1.len()
    );
    // Score ordering is part of the FeatureSet contract.
    for fs in [&fs0, &fs1] {
        assert!(
            fs.keypoints.windows(2).all(|w| w[0].score >= w[1].score),
            "keypoints must be in descending score order"
        );
        assert_eq!(fs.descriptors.len(), fs.len() * fs.descriptor_dim);
    }

    // Reference run (M4 Max, ONNX Runtime 1.23.2 CPU EP, 2026-06-11):
    // 184 matches, median reprojection error 0.442 px, p90 1.594 px,
    // 94.6% of matches within 3 px. Gates sit well inside that with
    // headroom for runtime/platform numeric drift.
    let matches = matcher.match_features(&fs0, &fs1).expect("match");
    eprintln!("ml_smoke: raw match count = {}", matches.len());
    assert!(
        matches.len() >= 80,
        "expected a substantial match set on a 50%-overlap pair, got {}",
        matches.len()
    );

    // ---- Geometric gate against the exact GT cameras --------------------
    // Pure rotation + scene at infinity → a true correspondence (x0, y0)
    // in frame 0 lands at exactly cam1(world_dir(cam0, x0, y0)) in frame
    // 1, up to detector localization error. Reproject every match and
    // require consensus.
    let mut errs: Vec<f64> = matches
        .iter()
        .map(|m| reprojection_error_px(m, &cams[0], &cams[1]))
        .collect();
    errs.sort_by(|a, b| a.partial_cmp(b).expect("finite or inf"));
    let median = errs[errs.len() / 2];
    let p90 = errs[(errs.len() * 9) / 10];
    let within_3px = errs.iter().filter(|&&e| e <= 3.0).count() as f64 / errs.len() as f64;
    eprintln!(
        "ml_smoke: reprojection error px — median={median:.3} p90={p90:.3} \
         inliers(≤3px)={:.1}%",
        within_3px * 100.0
    );

    assert!(
        median <= 2.0,
        "median reprojection error {median:.3}px exceeds 2px — matches are not \
         geometrically consistent with the ground-truth rotation"
    );
    assert!(
        within_3px >= 0.75,
        "only {:.1}% of matches within 3px of the ground-truth mapping (need ≥75%)",
        within_3px * 100.0
    );
}

/// Distance in frame-1 pixels between LightGlue's correspondence and the
/// ground-truth reprojection of the frame-0 point. Unmappable points
/// (behind the camera — impossible here short of a broken match) count
/// as +∞ so they land in the outlier tail instead of vanishing.
fn reprojection_error_px(m: &MlMatch, cam0: &Camera, cam1: &Camera) -> f64 {
    let Some(dir) = cam0.pixel_to_world_dir(m.x0 as f64, m.y0 as f64) else {
        return f64::INFINITY;
    };
    let Some((px, py)) = cam1.world_dir_to_pixel(dir) else {
        return f64::INFINITY;
    };
    let (dx, dy) = (px - m.x1 as f64, py - m.y1 as f64);
    (dx * dx + dy * dy).sqrt()
}
