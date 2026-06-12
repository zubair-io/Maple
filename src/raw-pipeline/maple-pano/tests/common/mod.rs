//! Shared synthetic-BA helpers for the gate test binaries
//! (`ba_gates.rs`, `motion_gates.rs`) — split from `ba_gates.rs` for
//! the file-size budget. Cargo compiles `tests/common/` into each test
//! crate that declares `mod common;` (the standard integration-test
//! sharing pattern), so everything here is `pub`.

use maple_pano::ba::BaSolution;
use maple_pano::camera::Camera;
use maple_pano::graph::{
    build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage, MatchGraph,
};
use maple_pano::math::Mat3;
use maple_pano::prng::SplitMix64;
use maple_pano::render::{CameraSetOptions, Pattern};
use maple_pano::robust::RobustOptions;
use maple_pano::testkit::{generate_pair_correspondences, CorrespondenceOptions};

/// Matcher-realistic pixel noise: the real ALIKED+LightGlue stack
/// measured a 0.44 px median reprojection error on the synthetic smoke
/// pair (tests/ml_smoke.rs), so σ = 0.5 px is the honest synthetic
/// stand-in. (At σ = 1.0 the *noise floor* of the residual norm —
/// E|N₂(0, √2σ·I)| ≈ 1.77 px — already exceeds the spec's 1.5 px
/// per-frame mean budget, so that regime is gated by the robust
/// verifier upstream, not by BA.)
pub const REALISTIC_NOISE_PX: f64 = 0.5;
pub const REALISTIC_OUTLIERS: f64 = 0.3;

pub fn realistic_matches() -> CorrespondenceOptions {
    CorrespondenceOptions {
        count: 200,
        noise_sigma_px: REALISTIC_NOISE_PX,
        outlier_fraction: REALISTIC_OUTLIERS,
        ..Default::default()
    }
}

pub fn ring_options(count: u32) -> CameraSetOptions {
    CameraSetOptions {
        count,
        pattern: Pattern::Ring { full: true },
        fov_deg: 60.0,
        overlap: 0.3,
        pitch_deg: 0.0,
        jitter_deg: 3.0,
        k1: 0.0,
        k2: 0.0,
        width: 960,
        height: 720,
    }
}

/// Graph from the true cameras with the M1a providers and per-pair
/// deterministic synthetic matches (same recipe as the graph gates).
pub fn build_graph(
    images: &[GraphImage],
    cams: &[Camera],
    corr: &CorrespondenceOptions,
) -> MatchGraph {
    build_match_graph(
        images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| {
            let mut rng = SplitMix64::new(0x00C0_FFEE ^ ((a as u64) << 32) ^ b as u64);
            generate_pair_correspondences(&cams[a], &cams[b], corr, &mut rng).pixel_pairs()
        },
        &RobustOptions::default(),
    )
}

/// Seed images: true intrinsics as the focal seed, priors as requested.
pub fn seed_images(cams: &[Camera], with_priors: bool) -> Vec<GraphImage> {
    cams.iter()
        .map(|c| GraphImage {
            camera: c.clone(),
            prior_rotation: with_priors.then_some(c.rotation),
        })
        .collect()
}

/// Gauge-invariant relative set (`R_iᵀ·R_0` — see
/// [`worst_rel_rotation_err_deg`] for why not the world-frame form).
pub fn relative_set(solution: &BaSolution) -> Vec<Mat3> {
    let cams: Vec<&Camera> = solution
        .cameras
        .iter()
        .map(|c| c.as_ref().expect("frame solved"))
        .collect();
    cams.iter()
        .map(|c| c.rotation.transpose().mul_mat(&cams[0].rotation))
        .collect()
}
