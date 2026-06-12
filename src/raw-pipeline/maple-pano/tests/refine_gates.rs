//! #1210 synthetic acceptance gate for coarse-to-fine refinement.
//!
//! Renders a full-res overlapping pair through the crate's own
//! ground-truth renderer (exactly known cameras), downscales each frame
//! to a proxy via the production [`proxy_to_long_edge`] path, builds
//! ground-truth correspondences by reprojection, perturbs them with the
//! proxy-scale quantization noise the real matcher exhibits, and runs
//! [`refine_correspondences`]. Gates (ticket #1210):
//!
//! - median error vs ground truth ≤ 1/3 of the unrefined median (the
//!   "≥ 3× error cut" acceptance), and
//! - ≤ 0.5 full-res px absolute on textured patches.
//!
//! The scene is multi-octave value noise — aperiodic, locally
//! distinctive texture everywhere (the `ml_smoke` rationale: periodic
//! texture aliases correlation peaks; real photographs are aperiodic at
//! frame scale). The flat-patch fallback contract is unit-tested in
//! `refine::tests` (zero-variance → flagged fallback, never NaN).

use maple_pano::ingest::{proxy_to_long_edge, PlanarImage, ValidityMask};
use maple_pano::prng::SplitMix64;
use maple_pano::refine::{refine_correspondences, RefineGeometry, RefineOptions};
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::source::EquirectSource;
use maple_pano::twoview::PixelCorrespondence;
use maple_pano::Camera;

/// Deterministic multi-octave value noise on the equirect grid (see the
/// module docs for why noise and not the periodic synthetic scene).
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
            // Octaves sized so the finest detail is ~6 frame px at this
            // test's source→frame magnification — solid 13×13 templates.
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

/// 16-bit interleaved renderer output → the planar f32 ingest shape.
fn planarize(width: u32, height: u32, rgb16: &[u16]) -> PlanarImage {
    let n = (width as usize) * (height as usize);
    assert_eq!(rgb16.len(), n * 3);
    let (mut r, mut g, mut b) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    for px in rgb16.chunks_exact(3) {
        r.push(f32::from(px[0]) / 65535.0);
        g.push(f32::from(px[1]) / 65535.0);
        b.push(f32::from(px[2]) / 65535.0);
    }
    PlanarImage::from_planes(
        width,
        height,
        r,
        g,
        b,
        ValidityMask::new_filled(width, height, true),
    )
}

/// Ground-truth reprojection of a frame-0 pixel into frame 1 (pure
/// rotation, scene at infinity — exact by construction).
fn reproject(cam0: &Camera, cam1: &Camera, p: (f64, f64)) -> Option<(f64, f64)> {
    cam1.world_dir_to_pixel(cam0.pixel_to_world_dir(p.0, p.1)?)
}

fn median(values: &mut [f64]) -> f64 {
    assert!(!values.is_empty());
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        0.5 * (values[n / 2 - 1] + values[n / 2])
    }
}

#[test]
fn refinement_cuts_proxy_quantization_error_three_fold_and_under_half_px() {
    // ---- Render the pair (exactly known cameras) ------------------------
    const W: u32 = 800;
    const H: u32 = 600;
    const PROXY_LONG_EDGE: u32 = 200; // 800/200 = 4, 600/150 = 4 — exact.
    let source = noise_source(3072, 1536);
    let opts = CameraSetOptions {
        count: 2,
        pattern: Pattern::Ring { full: false },
        fov_deg: 65.0,
        overlap: 0.5,
        pitch_deg: 0.0,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: W,
        height: H,
    };
    let mut cam_rng = SplitMix64::new(7 ^ 0xA076_1D64_78BD_642F);
    let cams_gt = build_camera_set(&opts, &mut cam_rng).expect("camera set");
    let cams: Vec<Camera> = cams_gt.iter().map(|c| c.to_camera()).collect();
    let full: Vec<PlanarImage> = cams
        .iter()
        .map(|cam| planarize(W, H, &render_frame(&source, cam, 2).expect("render")))
        .collect();

    // ---- Proxies through the production downscale -----------------------
    let proxies: Vec<PlanarImage> = full
        .iter()
        .map(|f| proxy_to_long_edge(f, PROXY_LONG_EDGE))
        .collect();
    let scale = (
        f64::from(W) / f64::from(proxies[0].width()),
        f64::from(H) / f64::from(proxies[0].height()),
    );
    assert_eq!(scale, (4.0, 4.0), "test geometry is an exact 4:1 proxy");

    // ---- Ground-truth correspondences + proxy quantization noise --------
    // A grid over frame 0, reprojected into frame 1; both endpoints then
    // get the matcher's proxy-scale noise: ±0.5 proxy px uniform per
    // axis (the quantization the 1600 px production proxy imposes).
    const MARGIN: f64 = 40.0;
    let mut rng = SplitMix64::new(0x1210);
    let mut matches = Vec::new();
    let mut gt_b = Vec::new(); // GT partner of each PERTURBED a seed
    let mut unrefined_err = Vec::new();
    let mut y = MARGIN;
    while y < f64::from(H) - MARGIN {
        let mut x = MARGIN;
        while x < f64::from(W) - MARGIN {
            let a_true = (x + 0.5, y + 0.5);
            if let Some(b_true) = reproject(&cams[0], &cams[1], a_true) {
                if cams[1].pixel_in_bounds(b_true.0, b_true.1, MARGIN) {
                    let a_p = (
                        a_true.0 / scale.0 + rng.next_range(-0.5, 0.5),
                        a_true.1 / scale.1 + rng.next_range(-0.5, 0.5),
                    );
                    let b_p = (
                        b_true.0 / scale.0 + rng.next_range(-0.5, 0.5),
                        b_true.1 / scale.1 + rng.next_range(-0.5, 0.5),
                    );
                    // The refiner keeps A at its (noisy) seed — the GT for
                    // the refined B is the reprojection of that exact seed.
                    let a_seed_full = (a_p.0 * scale.0, a_p.1 * scale.1);
                    let b_gt = reproject(&cams[0], &cams[1], a_seed_full)
                        .expect("seed within frame reprojects");
                    let b_seed_full = (b_p.0 * scale.0, b_p.1 * scale.1);
                    unrefined_err.push((b_seed_full.0 - b_gt.0).hypot(b_seed_full.1 - b_gt.1));
                    gt_b.push(b_gt);
                    matches.push(PixelCorrespondence { a: a_p, b: b_p });
                }
            }
            x += 40.0;
        }
        y += 40.0;
    }
    assert!(
        matches.len() >= 50,
        "need a meaningful population, got {}",
        matches.len()
    );

    // ---- Refine ----------------------------------------------------------
    // Pair geometry as production supplies it: full-res intrinsics +
    // the relative rotation (here ground truth, `d_b = R_bᵀ·R_a·d_a`) —
    // exercising the perspective-compensated template path end to end.
    let rotation = cams[1].rotation.transpose().mul_mat(&cams[0].rotation);
    let geometry = RefineGeometry {
        cam_a: &cams[0],
        cam_b: &cams[1],
        rotation: &rotation,
    };
    let out = refine_correspondences(
        &full[0],
        &full[1],
        scale,
        scale,
        Some(&geometry),
        &matches,
        &RefineOptions::default(),
    );
    assert_eq!(out.refined.len(), matches.len());
    let refined_fraction = out.refined_count as f64 / matches.len() as f64;

    let mut refined_err: Vec<f64> = out
        .refined
        .iter()
        .zip(&gt_b)
        .map(|(m, gt)| (m.b.0 - gt.0).hypot(m.b.1 - gt.1))
        .collect();
    let mut textured_err: Vec<f64> = refined_err
        .iter()
        .zip(&out.refined_mask)
        .filter(|(_, &ok)| ok)
        .map(|(&e, _)| e)
        .collect();
    assert!(!textured_err.is_empty(), "no match refined at all");

    let med_unrefined = median(&mut unrefined_err);
    let med_refined = median(&mut refined_err);
    let med_textured = median(&mut textured_err);
    eprintln!(
        "refine_gates: {} matches, refined {} ({:.1}%), fallback {} — median px \
         unrefined {med_unrefined:.3} → refined {med_refined:.3} \
         (textured-only {med_textured:.3})",
        matches.len(),
        out.refined_count,
        refined_fraction * 100.0,
        out.fallback_count,
    );

    // Gate 1 (#1210): ≥ 3× cut of the median error vs proxy-only.
    assert!(
        med_refined <= med_unrefined / 3.0,
        "median error must drop ≥ 3×: unrefined {med_unrefined:.3} px vs \
         refined {med_refined:.3} px"
    );
    // Gate 2 (#1210): ≤ 0.5 full-res px absolute on textured patches.
    assert!(
        med_textured <= 0.5,
        "textured-patch median {med_textured:.3} px exceeds 0.5 px"
    );
    // The scene is textured everywhere — refinement must not be leaning
    // on fallbacks to pass.
    assert!(
        refined_fraction >= 0.9,
        "only {:.1}% of matches refined on a fully textured scene",
        refined_fraction * 100.0
    );
}
