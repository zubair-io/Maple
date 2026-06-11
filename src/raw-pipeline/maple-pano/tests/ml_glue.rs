//! #1154 deliverable 7 — ML → geometry glue, end to end: ALIKED +
//! LightGlue matches adapted through [`maple_pano::glue`] and driven
//! through robust verification into the match graph, on a rendered
//! synthetic pair with exactly known ground truth.
//!
//! Environment-gated exactly like `ml_smoke`: SKIP-PASSes when
//! `MAPLE_PANO_MODELS` / the model files / the onnxruntime dylib are
//! absent (CI has none of these). Real run:
//!
//! ```text
//! MAPLE_PANO_MODELS=~/.cache/maple-pano/models \
//! ORT_DYLIB_PATH=~/.cache/maple-pano/ort/onnxruntime-osx-arm64-1.23.2/lib/libonnxruntime.dylib \
//! cargo test -p maple-pano --features ml --test ml_glue -- --nocapture
//! ```

#![cfg(feature = "ml")]

use maple_pano::camera::Camera;
use maple_pano::features::{AlikedDetector, DetectorOptions, KeypointFilter, LinearRgbFrame};
use maple_pano::glue::{ml_matches_to_correspondences, DEFAULT_MIN_SCORE};
use maple_pano::graph::{build_match_graph, CaptureOrderProvider, GraphImage};
use maple_pano::matching::{LightGlueMatcher, MatcherOptions};
use maple_pano::models::ModelDir;
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::robust::RobustOptions;
use maple_pano::source::EquirectSource;
use maple_pano::twoview::{relative_rotation_ground_truth, rotation_angle_between};

fn skip(reason: impl std::fmt::Display) {
    eprintln!("ml_glue: SKIP-PASS — {reason}");
}

/// Compact copy of `ml_smoke`'s aperiodic multi-octave value noise (the
/// crate's checker scene is adversarially periodic for descriptors —
/// see the rationale there).
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
            for (octave, cell) in [(0_u64, 40_usize), (1, 10), (2, 3)] {
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
fn ml_matches_drive_a_verified_graph_edge() {
    let models = match ModelDir::resolve(None) {
        Ok(m) => m,
        Err(e) if e.is_environment_missing() => return skip(e),
        Err(e) => panic!("model verification failed (not an absence): {e}"),
    };
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

    let source = noise_source(4096, 2048);
    let opts = CameraSetOptions {
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
    };
    let gt = build_camera_set(&opts, &mut SplitMix64::new(21)).expect("camera set");
    let cams: Vec<Camera> = gt.iter().map(|c| c.to_camera()).collect();
    let mut frames = Vec::with_capacity(2);
    for cam in &cams {
        let data = render_frame(&source, cam, 2).expect("render");
        frames.push(LinearRgbFrame::from_u16_rgb(cam.width, cam.height, &data).expect("frame"));
    }

    let fs0 = detector.detect(&frames[0]).expect("detect 0");
    let fs1 = detector.detect(&frames[1]).expect("detect 1");
    let ml = matcher.match_features(&fs0, &fs1).expect("match");
    let correspondences = ml_matches_to_correspondences(&ml, DEFAULT_MIN_SCORE);
    eprintln!(
        "ml_glue: {} raw matches -> {} correspondences after the {DEFAULT_MIN_SCORE} score gate",
        ml.len(),
        correspondences.len()
    );
    assert!(
        correspondences.len() >= 60,
        "need a healthy correspondence set, got {}",
        correspondences.len()
    );

    // Through the real graph path: nomination (capture order), robust
    // verification (MAGSAC), edge construction.
    let images: Vec<GraphImage> = cams
        .iter()
        .map(|c| GraphImage {
            camera: c.clone(),
            prior_rotation: None,
        })
        .collect();
    let graph = build_match_graph(
        &images,
        &[&CaptureOrderProvider],
        |a, b| {
            assert_eq!((a, b), (0, 1), "only one pair to nominate");
            correspondences.clone()
        },
        &RobustOptions::default(),
    );

    assert!(graph.orphans.is_empty(), "both frames must verify");
    assert_eq!(graph.edges.len(), 1);
    let edge = &graph.edges[0];
    assert!(
        edge.inlier_count >= 30,
        "spec pair-acceptance floor, got {} inliers",
        edge.inlier_count
    );
    let gt_rel = relative_rotation_ground_truth(&cams[0], &cams[1]);
    let err_deg = rotation_angle_between(&edge.rotation, &gt_rel).to_degrees();
    eprintln!(
        "ml_glue: verified edge — {} inliers, R_rel error {err_deg:.3}° vs ground truth",
        edge.inlier_count
    );
    assert!(err_deg < 0.5, "edge rotation error {err_deg}°");
}
