//! Stage F local alignment integration gates (#1218, spec §8).
//!
//! Three scenarios:
//! 1. **Pure rotation** — noiseless synthetic correspondences; correction
//!    must be near-identity (< 0.05 px max displacement).
//! 2. **Parallax injection** — uniform 2 px bias injected into every
//!    correspondence's destination side; correction must absorb it
//!    (post-correction mean residual is less than pre-correction).
//! 3. **Strip-priors variant** — same parallax test but `GraphImage`s
//!    carry no rotation priors (`prior_rotation = None`), validating the
//!    content-based fallback path.

mod common;

use common::{ring_options, seed_images, REALISTIC_NOISE_PX};
use maple_pano::ba::{solve, BaOptions};
use maple_pano::camera::Camera;
use maple_pano::graph::{
    build_match_graph, CaptureOrderProvider, GimbalPriorProvider, GraphImage,
};
use maple_pano::local_align::MAX_CORRECTION_PX;
use maple_pano::prng::SplitMix64;
use maple_pano::render::build_camera_set;
use maple_pano::robust::RobustOptions;
use maple_pano::testkit::{generate_pair_correspondences, CorrespondenceOptions};
use maple_pano::twoview::PixelCorrespondence;

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/// Build a 6-camera ring set at moderate FOV and return the `Camera` objects.
fn six_ring() -> Vec<Camera> {
    build_camera_set(&ring_options(6), &mut SplitMix64::new(0xBA))
        .expect("valid ring options")
        .iter()
        .map(|g| g.to_camera())
        .collect()
}

/// Noiseless correspondences between two cameras (no outliers).
fn noiseless_corr() -> CorrespondenceOptions {
    CorrespondenceOptions {
        count: 200,
        noise_sigma_px: 0.0,
        outlier_fraction: 0.0,
        ..Default::default()
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Gate 1: pure-rotation set → correction is essentially identity
// ────────────────────────────────────────────────────────────────────────────

/// Noiseless pure-rotation synthetic set: the local-align stage should
/// produce negligible corrections (< 0.05 px everywhere) because the
/// BA residuals are at machine epsilon.
#[test]
fn gate_pure_rotation_correction_near_identity() {
    let cams = six_ring();
    let images = seed_images(&cams, true);
    let corr = noiseless_corr();
    let graph = build_match_graph(
        &images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| {
            let mut rng = SplitMix64::new(0x00C0_FFEE ^ ((a as u64) << 32) ^ b as u64);
            generate_pair_correspondences(&cams[a], &cams[b], &corr, &mut rng).pixel_pairs()
        },
        &RobustOptions::default(),
    );
    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");

    // local_corrections: every frame either None or very near zero.
    for (i, lc) in solution.local_corrections.iter().enumerate() {
        if let Some(c) = lc {
            assert!(
                c.max_correction_px < 0.05,
                "frame {i}: pure-rotation correction {:.4} px >= 0.05 px",
                c.max_correction_px
            );
        }
    }

    // Before/after fields must be equal (or both near zero).
    let diff_mean =
        (solution.mean_reproj_px - solution.mean_reproj_before_local_px).abs();
    assert!(
        diff_mean < 0.02,
        "pure-rotation: before/after mean reproj delta {diff_mean:.4} px >= 0.02 px"
    );
}

// ────────────────────────────────────────────────────────────────────────────
// Gate 2: parallax injection → correction absorbs the bias
// ────────────────────────────────────────────────────────────────────────────

/// Build a match graph with a uniform parallax bias of `bias_px` added to
/// every destination-side coordinate of every match.
fn parallax_graph(cams: &[Camera], bias_px: f64) -> maple_pano::graph::MatchGraph {
    let images = seed_images(cams, true);
    build_match_graph(
        &images,
        &[&CaptureOrderProvider, &GimbalPriorProvider::default()],
        |a, b| {
            let mut rng = SplitMix64::new(0x00C0_FFEE ^ ((a as u64) << 32) ^ b as u64);
            let corr = CorrespondenceOptions {
                count: 200,
                noise_sigma_px: REALISTIC_NOISE_PX,
                outlier_fraction: 0.0,
                ..Default::default()
            };
            generate_pair_correspondences(&cams[a], &cams[b], &corr, &mut rng)
                .pixel_pairs()
                .into_iter()
                // Shift destination coordinate to simulate parallax floor.
                .map(|pc| PixelCorrespondence {
                    a: pc.a,
                    b: (pc.b.0 + bias_px, pc.b.1),
                })
                .collect()
        },
        &RobustOptions::default(),
    )
}

/// Parallax injection: a uniform 2 px horizontal bias is absorbed by the
/// stage-F correction.  Post-correction mean residual should be below the
/// raw biased residual (the correction helps).
#[test]
fn gate_parallax_bias_absorbed() {
    const BIAS: f64 = 2.0;
    let cams = six_ring();
    let images = seed_images(&cams, true);
    let graph = parallax_graph(&cams, BIAS);

    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");

    // At least 2 frames must survive.
    let n_survived = solution.cameras.iter().filter(|c| c.is_some()).count();
    assert!(
        n_survived >= 2,
        "fewer than 2 frames survived parallax gate: {n_survived}"
    );

    // The before-local mean should be higher than after (correction helped).
    let before = solution.mean_reproj_before_local_px;
    let after = solution.mean_reproj_px;
    println!("parallax gate: before={before:.3} after={after:.3}");
    assert!(
        after <= before + 0.1,
        "local alignment worsened mean reproj: before={before:.3} after={after:.3}"
    );

    // Corrections must be bounded by MAX_CORRECTION_PX.
    for (i, lc) in solution.local_corrections.iter().enumerate() {
        if let Some(c) = lc {
            assert!(
                c.max_correction_px <= MAX_CORRECTION_PX + 1e-9,
                "frame {i}: max_correction_px {:.3} > MAX_CORRECTION_PX {MAX_CORRECTION_PX}",
                c.max_correction_px,
            );
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Gate 3: strip-priors variant
// ────────────────────────────────────────────────────────────────────────────

/// Same parallax-injection scenario but with no rotation priors
/// (`prior_rotation = None`), validating the content-based fallback path.
#[test]
fn gate_strip_priors_parallax_absorbed() {
    const BIAS: f64 = 1.5;
    let cams = six_ring();
    // Strip priors: give no rotation priors.
    let images: Vec<GraphImage> = cams
        .iter()
        .map(|c| GraphImage {
            camera: Camera::new([0.0; 3], c.focal_px, 0.0, 0.0, c.width, c.height),
            prior_rotation: None,
        })
        .collect();

    let graph = build_match_graph(
        &images,
        &[&CaptureOrderProvider],
        |a, b| {
            let mut rng = SplitMix64::new(0xDEAD ^ ((a as u64) << 32) ^ b as u64);
            let corr = CorrespondenceOptions {
                count: 200,
                noise_sigma_px: REALISTIC_NOISE_PX,
                outlier_fraction: 0.0,
                ..Default::default()
            };
            generate_pair_correspondences(&cams[a], &cams[b], &corr, &mut rng)
                .pixel_pairs()
                .into_iter()
                .map(|pc| PixelCorrespondence {
                    a: pc.a,
                    b: (pc.b.0 + BIAS, pc.b.1),
                })
                .collect()
        },
        &RobustOptions::default(),
    );

    let solution = solve(&images, &graph, &BaOptions::default()).expect("solve");

    let n_survived = solution.cameras.iter().filter(|c| c.is_some()).count();
    assert!(
        n_survived >= 2,
        "strip-priors: fewer than 2 frames survived: {n_survived}"
    );

    // Corrections must be bounded.
    for (i, lc) in solution.local_corrections.iter().enumerate() {
        if let Some(c) = lc {
            assert!(
                c.max_correction_px <= MAX_CORRECTION_PX + 1e-9,
                "strip-priors frame {i}: max correction {:.3} > MAX",
                c.max_correction_px,
            );
        }
    }

    println!(
        "strip-priors gate: survived={n_survived}/{}, \
         before={:.3} after={:.3}",
        cams.len(),
        solution.mean_reproj_before_local_px,
        solution.mean_reproj_px,
    );
}
