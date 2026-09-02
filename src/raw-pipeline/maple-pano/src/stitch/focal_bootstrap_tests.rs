//! Unit tests for `stitch/focal_bootstrap.rs`, split out to respect the
//! file-size budget (CONTRIBUTING.md § File-size budget).
//!
//! [`no_exif_bootstrap_recovers_focal_and_reconnects_the_strip`] is
//! ticket #1214's acceptance gate ("an EXIF-less stitch ... completes
//! end-to-end with zero drops") exercised at the geometry layer — the
//! same bootstrap → verify → homography-refine → rebuild sequence
//! `stitch()` runs, minus the ONNX-backed feature/match stages, which
//! this crate's other synthetic gates (`ml_smoke.rs`) already document
//! as untestable without live models.

use super::*;
use crate::ingest::{FramePriors, GimbalPrior, PlanarImage, ValidityMask};
use crate::prng::SplitMix64;
use crate::testkit::{generate_pair_correspondences, CorrespondenceOptions};
use std::collections::HashMap;

fn dummy_meta(full_width: u32, full_height: u32, focal_px: Option<f64>) -> FrameMeta {
    dummy_meta_with_gimbal(full_width, full_height, focal_px, None)
}

fn dummy_meta_with_gimbal(
    full_width: u32,
    full_height: u32,
    focal_px: Option<f64>,
    gimbal: Option<GimbalPrior>,
) -> FrameMeta {
    FrameMeta {
        // The proxy's pixel content is never read by anything under
        // test here — only `.priors`/`.full_width`/`.full_height` are —
        // so a 1×1 placeholder is enough.
        proxy: PlanarImage::from_planes(
            1,
            1,
            vec![0.0],
            vec![0.0],
            vec![0.0],
            ValidityMask::new_filled(1, 1, true),
        ),
        proxy_scale_x: full_width as f64,
        proxy_scale_y: full_height as f64,
        full_width,
        full_height,
        priors: FramePriors {
            focal_mm: None,
            focal_35mm_equiv: None,
            focal_px,
            gimbal,
        },
        camera_make: "Test".to_string(),
        camera_model: "Synthetic".to_string(),
        applied_opcodes: Vec::new(),
    }
}

#[test]
fn seed_from_priors_uses_own_exif_focal_and_median_for_missing() {
    let metas = vec![
        dummy_meta(1600, 1200, Some(1000.0)),
        dummy_meta(1600, 1200, None),
        dummy_meta(1600, 1200, Some(1200.0)),
    ];
    let seed = seed_from_priors(&metas);
    assert_eq!(seed.source, FocalSeedSource::Exif);
    assert_eq!(seed.full_px, vec![1000.0, 1100.0, 1200.0]);
}

#[test]
fn seed_from_priors_bootstraps_from_assumed_fov_when_no_exif_anywhere() {
    let metas = vec![dummy_meta(1600, 1200, None), dummy_meta(2000, 1500, None)];
    let seed = seed_from_priors(&metas);
    assert_eq!(seed.source, FocalSeedSource::HomographyFallback);
    assert_eq!(seed.full_px.len(), 2);
    assert_eq!(
        seed.full_px[0],
        crate::camera::focal_px_for_hfov(BOOTSTRAP_ASSUMED_HFOV_DEG, 1600)
    );
    assert_eq!(
        seed.full_px[1],
        crate::camera::focal_px_for_hfov(BOOTSTRAP_ASSUMED_HFOV_DEG, 2000)
    );
    // Different frame widths at the same assumed FOV must not collapse
    // to a single shared value.
    assert_ne!(seed.full_px[0], seed.full_px[1]);
}

#[test]
fn build_graph_images_full_and_proxy_focal_are_consistent() {
    let metas = vec![
        dummy_meta(1600, 1200, Some(2000.0)),
        dummy_meta(1600, 1200, Some(2000.0)),
    ];
    let full_focal_px = vec![2000.0, 1950.0];
    let proxy_dims = vec![(400u32, 300u32), (400u32, 300u32)];
    // proxy_scale = full/proxy = 4.0 in both axes.
    let proxy_scale = vec![(4.0, 4.0), (4.0, 4.0)];

    let (full_images, proxy_images) =
        build_graph_images(&metas, &full_focal_px, &proxy_dims, &proxy_scale);

    for (i, &f) in full_focal_px.iter().enumerate() {
        assert_eq!(full_images[i].camera.focal_px, f);
        assert_eq!(full_images[i].camera.width, 1600);
        assert_eq!(full_images[i].camera.height, 1200);
        assert_eq!(proxy_images[i].camera.focal_px, f / 4.0);
        assert_eq!(proxy_images[i].camera.width, 400);
        assert_eq!(proxy_images[i].camera.height, 300);
    }
}

/// Ticket #1214's acceptance gate, at the geometry layer: a 5-frame
/// no-EXIF strip (no camera priors at all — the film-scan / generic-
/// DSLR-burst scenario the ticket motivates with) bootstraps from the
/// assumed FOV, verifies, self-calibrates a real focal within 5% of
/// ground truth, and reconnects into one fully-linked graph (zero
/// orphans) once rebuilt at the refined focal.
#[test]
fn no_exif_bootstrap_recovers_focal_and_reconnects_the_strip() {
    let true_focal = crate::camera::focal_px_for_hfov(70.0, 1600);
    let yaws: [f64; 5] = [-24.0, -12.0, 0.0, 12.0, 24.0];
    let dims = (1600u32, 1200u32);

    // Ground-truth cameras used only to synthesize correspondences —
    // the code under test never sees `true_focal` or `yaws` directly.
    let true_cams: Vec<Camera> = yaws
        .iter()
        .map(|&yaw_deg| {
            let r = crate::math::Mat3::rotation_y(yaw_deg.to_radians());
            Camera::new(
                crate::math::matrix_to_axis_angle(&r),
                true_focal,
                0.0,
                0.0,
                dims.0,
                dims.1,
            )
        })
        .collect();

    let metas: Vec<FrameMeta> = (0..true_cams.len())
        .map(|_| dummy_meta(dims.0, dims.1, None))
        .collect();
    let proxy_dims: Vec<(u32, u32)> = metas.iter().map(|_| dims).collect();
    let proxy_scale: Vec<(f64, f64)> = metas.iter().map(|_| (1.0, 1.0)).collect();

    // Every consecutive pair's correspondences, generated once and kept
    // as the "ONNX cache" both graph builds draw from — mirrors
    // `stitch()`'s `raw_matches_cache`.
    let mut rng = SplitMix64::new(0x1214_5EED);
    let mut cache: HashMap<(usize, usize), Vec<crate::twoview::PixelCorrespondence>> =
        HashMap::new();
    for i in 0..true_cams.len() - 1 {
        let synth = generate_pair_correspondences(
            &true_cams[i],
            &true_cams[i + 1],
            &CorrespondenceOptions {
                count: 200,
                noise_sigma_px: 0.2,
                outlier_fraction: 0.0,
                ..CorrespondenceOptions::default()
            },
            &mut rng,
        );
        cache.insert((i, i + 1), synth.pixel_pairs());
    }

    // ── bootstrap pass ──────────────────────────────────────────────
    let seed = seed_from_priors(&metas);
    assert_eq!(seed.source, FocalSeedSource::HomographyFallback);
    let (_, bootstrap_proxy_images) =
        build_graph_images(&metas, &seed.full_px, &proxy_dims, &proxy_scale);
    let bootstrap_graph =
        rebuild_graph_with_focal(&bootstrap_proxy_images, &cache, |_, _| Vec::new());
    assert!(
        !bootstrap_graph.edges.is_empty(),
        "assumed-FOV bootstrap must verify at least one pair to refine from"
    );

    // ── homography refinement ───────────────────────────────────────
    let refined_full_px = refine_from_homography(&bootstrap_graph, &proxy_dims, &proxy_scale)
        .expect("bootstrap graph has verified pairs to self-calibrate from");
    for &f in &refined_full_px {
        let rel_err = (f - true_focal).abs() / true_focal;
        assert!(
            rel_err < 0.05,
            "refined focal {f} vs true {true_focal} — {:.2}% off",
            rel_err * 100.0
        );
    }

    // ── rebuild at the refined focal ────────────────────────────────
    let (_, refined_proxy_images) =
        build_graph_images(&metas, &refined_full_px, &proxy_dims, &proxy_scale);
    let refined_graph = rebuild_graph_with_focal(&refined_proxy_images, &cache, |_, _| Vec::new());
    assert!(
        refined_graph.is_connected(),
        "refined graph must reconnect every frame, orphans: {:?}",
        refined_graph.orphans
    );
    assert_eq!(refined_graph.components[0].len(), true_cams.len());
}

#[test]
fn rebuild_graph_with_focal_falls_back_to_fetch_for_an_uncached_pair() {
    let images: Vec<GraphImage> = (0..3)
        .map(|_| GraphImage {
            camera: Camera::new([0.0; 3], 1500.0, 0.0, 0.0, 800, 600),
            prior_rotation: None,
        })
        .collect();
    let cache: HashMap<(usize, usize), Vec<crate::twoview::PixelCorrespondence>> = HashMap::new();
    let mut fetched = Vec::new();
    let graph = rebuild_graph_with_focal(&images, &cache, |a, b| {
        fetched.push((a, b));
        Vec::new()
    });
    // CaptureOrderProvider requests (0,1) and (1,2); neither is cached,
    // so both must fall through to `fetch`.
    assert_eq!(fetched, vec![(0, 1), (1, 2)]);
    assert!(graph.edges.is_empty());
}
