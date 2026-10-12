//! Blind per-lens vignette gates (#4522).

use super::fit::fit_pairs;
use super::solve::solve_from_fits;
use super::tests::frames_to_tmpdir;
use super::vignette::{estimate_falloff, falloff_gain, radius_squared, Correspondence};
use super::*;
use crate::ingest::{FrameMeta, FramePriors, ValidityMask};
use crate::math::Vec3;
use crate::prng::SplitMix64;
use crate::render::{build_camera_set, CameraSetOptions, Pattern};

const PLANTED_Q: f64 = 0.25;
const MULS: [f32; 6] = [1.0, 1.3, 0.8, 1.1, 0.9, 1.2];

fn scene(d: Vec3) -> [f32; 3] {
    let s = (0.05 + 0.3 * (1.0 + (5.0 * d.x).sin() * (4.0 * d.y + 2.0 * d.z).cos())) as f32;
    [s, 0.8 * s + 0.02, 0.6 * s + 0.01]
}

fn grid_cameras() -> Vec<Camera> {
    let opts = CameraSetOptions {
        count: MULS.len() as u32,
        pattern: Pattern::Grid { rows: 2 },
        fov_deg: 60.0,
        overlap: 0.45,
        pitch_deg: 0.0,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: 160,
        height: 120,
    };
    build_camera_set(&opts, &mut SplitMix64::new(11))
        .expect("valid")
        .iter()
        .map(|c| c.to_camera())
        .collect()
}

/// `scene · mul / V_q(r)` per frame; `q_of_frame[f] = 0` plants none.
fn planted(cams: &[Camera], q_of_frame: &[f64]) -> Vec<PlanarImage> {
    cams.iter()
        .zip(MULS.iter().zip(q_of_frame))
        .map(|(cam, (&m, &q))| {
            let (w, h) = (cam.width, cam.height);
            let px: Vec<[f32; 3]> = (0..h)
                .flat_map(|y| (0..w).map(move |x| (x as f64 + 0.5, y as f64 + 0.5)))
                .map(|(x, y)| {
                    let d = cam.pixel_to_world_dir(x, y).expect("invertible");
                    let v = m as f64 / falloff_gain(q, radius_squared(x, y, w as f64, h as f64));
                    scene(d).map(|s| (s as f64 * v) as f32)
                })
                .collect();
            PlanarImage::from_planes(
                w,
                h,
                px.iter().map(|p| p[0]).collect(),
                px.iter().map(|p| p[1]).collect(),
                px.iter().map(|p| p[2]).collect(),
                ValidityMask::new_filled(w, h, true),
            )
        })
        .collect()
}

fn one_lens(n: usize) -> LensGroups {
    LensGroups {
        labels: vec!["Test Synthetic".into()],
        of_frame: vec![Some(0); n],
    }
}

fn solve(frames: &[PlanarImage], cams: &[Camera], lenses: &LensGroups) -> PhotometrySolution {
    solve_photometry(frames, cams, lenses, &GainOptions::default()).unwrap()
}

/// Corrected-over-true ratio at a frame's corner pixel divided by the
/// same ratio at its centre: 1 when the falloff is fully removed.
fn corner_over_centre(
    frame: &PlanarImage,
    cam: &Camera,
    photometry: &FramePhotometry,
    mul: f32,
) -> f64 {
    let (w, h) = (cam.width as f64, cam.height as f64);
    let ratio = |x: u32, y: u32| {
        let i = (y * cam.width + x) as usize;
        let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
        let truth = scene(cam.pixel_to_world_dir(px, py).unwrap())[0] as f64 * mul as f64;
        photometry.apply_at([frame.r[i], frame.g[i], frame.b[i]], px, py, w, h)[0] as f64 / truth
    };
    ratio(0, 0) / ratio(cam.width / 2, cam.height / 2)
}

#[test]
fn planted_vignette_is_recovered_and_flattened() {
    let cams = grid_cameras();
    let frames = planted(&cams, &[PLANTED_Q; MULS.len()]);
    let solution = solve(&frames, &cams, &one_lens(MULS.len()));
    let q = solution.falloff[0].q as f64;
    assert!((q - PLANTED_Q).abs() < 0.01, "q = {q}, planted {PLANTED_Q}");
    assert!(solution.falloff[0].estimable, "{:?}", solution.falloff[0]);
    assert_eq!(
        solution.falloff[0].frames,
        (0..MULS.len()).collect::<Vec<_>>()
    );
    let before = corner_over_centre(&frames[0], &cams[0], &FramePhotometry::IDENTITY, MULS[0]);
    assert!(before < 0.5, "planted corner/centre {before}");
    for ((frame, cam), (p, m)) in frames
        .iter()
        .zip(&cams)
        .zip(solution.frames.iter().zip(MULS))
    {
        let after = corner_over_centre(frame, cam, p, m);
        assert!((after - 1.0).abs() < 0.03, "corner/centre after {after}");
    }
    let exposure: Vec<f64> = solution
        .frames
        .iter()
        .zip(MULS)
        .map(|(p, m)| p.gain[0] as f64 * m as f64)
        .collect();
    for e in &exposure {
        assert!((e / exposure[0] - 1.0).abs() < 0.03, "{exposure:?}");
    }
}

#[test]
fn vignette_free_set_estimates_zero() {
    let cams = grid_cameras();
    let frames = planted(&cams, &[0.0; MULS.len()]);
    let solution = solve(&frames, &cams, &one_lens(MULS.len()));
    let q = solution.falloff[0].q;
    assert!(q < 0.005, "q = {q} on a vignette-free set");
    let plain = solve_photometry(
        &frames,
        &cams,
        &LensGroups::ingest_corrected(frames.len()),
        &GainOptions::default(),
    )
    .unwrap()
    .frames;
    for (a, b) in solution.frames.iter().zip(&plain) {
        assert!(
            (a.gain[0] / b.gain[0] - 1.0).abs() < 0.005,
            "{a:?} vs {b:?}"
        );
    }
}

#[test]
fn ingest_corrected_frames_are_untouched() {
    let cams = grid_cameras();
    let corrected = |f: usize| f >= 3;
    let q_of_frame: Vec<f64> = (0..MULS.len())
        .map(|f| if corrected(f) { 0.0 } else { PLANTED_Q })
        .collect();
    let frames = planted(&cams, &q_of_frame);
    let lenses = LensGroups {
        labels: vec!["Test Synthetic".into()],
        of_frame: (0..MULS.len())
            .map(|f| (!corrected(f)).then_some(0))
            .collect(),
    };
    let solution = solve(&frames, &cams, &lenses);
    let q = solution.falloff[0].q as f64;
    assert!((q - PLANTED_Q).abs() < 0.01, "q = {q}");
    assert_eq!(solution.falloff[0].frames, vec![0, 1, 2]);
    for (f, p) in solution.frames.iter().enumerate() {
        assert_eq!(p.falloff_q == 0.0, corrected(f), "frame {f}: {p:?}");
    }
}

#[test]
fn all_corrected_set_is_bit_identical_to_plain_photometry() {
    let cams = grid_cameras();
    let frames = planted(&cams, &[PLANTED_Q; MULS.len()]);
    let solution = solve(&frames, &cams, &LensGroups::ingest_corrected(MULS.len()));
    let opts = GainOptions::default();
    let set = collect_overlap_set(&frames, &cams, &opts).unwrap();
    let plain = solve_from_fits(&set, &fit_pairs(&set, opts.mode), opts.mode).unwrap();
    assert_eq!(solution.frames, plain);
    assert!(solution.falloff.is_empty());
}

#[test]
fn streaming_recovers_planted_vignette() {
    let cams = grid_cameras();
    let frames = planted(&cams, &[PLANTED_Q; MULS.len()]);
    let (_dir, paths) = frames_to_tmpdir(&frames, &cams);
    let solution = solve_photometry_streaming(
        &paths,
        &cams,
        &one_lens(MULS.len()),
        &GainOptions::default(),
    )
    .unwrap();
    let q = solution.falloff[0].q as f64;
    assert!((q - PLANTED_Q).abs() < 0.01, "streaming q = {q}");
}

#[test]
fn overlap_samples_carry_positions_inside_both_frames() {
    let cams = grid_cameras();
    let frames = planted(&cams, &[0.0; MULS.len()]);
    let set = collect_overlap_set(&frames, &cams, &GainOptions::default()).unwrap();
    assert!(!set.pairs.is_empty());
    for pair in &set.pairs {
        for s in &pair.samples {
            for (pos, cam) in [(s.pos_i, &cams[pair.i]), (s.pos_j, &cams[pair.j])] {
                assert!((0.0..=cam.width as f32).contains(&pos[0]));
                assert!((0.0..=cam.height as f32).contains(&pos[1]));
            }
        }
    }
}

fn meta(
    make: &str,
    focal: Option<f32>,
    dims: (u32, u32),
    fc: raw_core::FalloffCorrection,
) -> FrameMeta {
    FrameMeta {
        proxy: PlanarImage::from_planes(
            1,
            1,
            vec![0.0],
            vec![0.0],
            vec![0.0],
            ValidityMask::new_filled(1, 1, true),
        ),
        proxy_scale_x: 1.0,
        proxy_scale_y: 1.0,
        full_width: dims.0,
        full_height: dims.1,
        priors: FramePriors {
            focal_mm: focal,
            focal_35mm_equiv: None,
            focal_px: None,
            gimbal: None,
        },
        camera_make: make.into(),
        camera_model: "Body".into(),
        applied_opcodes: Vec::new(),
        falloff_correction: fc,
    }
}

#[test]
fn lens_groups_split_by_lens_and_skip_ingest_corrected_frames() {
    use raw_core::FalloffCorrection::{BundledProfile, None as Uncorrected, Opcode};
    let metas = [
        meta("A", Some(24.0), (6000, 4000), Uncorrected),
        meta("A", Some(24.0), (4000, 6000), Uncorrected),
        meta("A", Some(50.0), (6000, 4000), Uncorrected),
        meta("A", Some(24.0), (6000, 4000), Opcode),
        meta("A", Some(24.0), (6000, 4000), BundledProfile),
        meta("B", Some(24.0), (6000, 4000), Uncorrected),
        meta("", Some(30.0), (6000, 4000), Uncorrected),
    ];
    let groups = LensGroups::from_metas(&metas);
    assert_eq!(
        groups.of_frame,
        vec![Some(0), Some(0), Some(1), None, None, Some(2), Some(3)]
    );
    assert_eq!(
        groups.labels,
        vec![
            "A Body 24.0mm",
            "A Body 50.0mm",
            "B Body 24.0mm",
            "Body 30.0mm"
        ]
    );
}

#[test]
fn batch_composite_estimates_and_reports_falloff() {
    use crate::composite::{composite, CompositeOptions};
    let cams = grid_cameras();
    let frames = planted(&cams, &[PLANTED_Q; MULS.len()]);
    let opts = CompositeOptions {
        lenses: Some(one_lens(MULS.len())),
        ..Default::default()
    };
    let (_, report) = composite(&frames, &cams, &opts, &[]).unwrap();
    let q = report.falloff[0].q as f64;
    assert!((q - PLANTED_Q).abs() < 0.01, "composite q = {q}");
    assert!(report.photometry.iter().all(|p| p.falloff_q == q as f32));
    let (_, plain) = composite(&frames, &cams, &CompositeOptions::default(), &[]).unwrap();
    assert!(plain.falloff.is_empty());
    assert!(plain.photometry.iter().all(|p| p.falloff_q == 0.0));
}

/// Synthetic correspondences between 6 frames with per-frame log-gains
/// and a planted `q`; `r2_of` picks each side's squared radius.
fn synthetic_correspondences(
    q: f64,
    r2_of: impl Fn(f64, f64) -> (f64, f64),
) -> Vec<Correspondence> {
    let mut rng = SplitMix64::new(5);
    let log_gain = |f: usize| 0.1 * f as f64 - 0.25;
    let lens = |r2: f64| 2.0 * (1.0 + q * r2).ln();
    (0..4000)
        .map(|n| {
            let i = n % 5;
            let (r2_i, r2_j) = r2_of(rng.next_range(0.0, 2.0), rng.next_range(0.0, 2.0));
            Correspondence {
                i,
                j: i + 1,
                r2_i,
                r2_j,
                log_ratio: log_gain(i) - log_gain(i + 1) + lens(r2_i) - lens(r2_j),
            }
        })
        .collect()
}

#[test]
fn falloff_is_not_estimable_when_both_sides_share_a_radius() {
    let obs = synthetic_correspondences(PLANTED_Q, |a, _| (a, a));
    let fit = estimate_falloff(&obs, &[Some(0); 6], 1)[0];
    assert!(!fit.estimable, "{fit:?}");
    assert_eq!(fit.q, 0.0);
}

#[test]
fn negative_falloff_is_measured_but_not_applied() {
    let obs = synthetic_correspondences(-0.07, |a, b| (a, b));
    let fit = estimate_falloff(&obs, &[Some(0); 6], 1)[0];
    assert!(fit.estimable, "{fit:?}");
    assert!((fit.q_unconstrained + 0.07).abs() < 0.02, "{fit:?}");
    assert_eq!(fit.q, 0.0);
}

#[test]
fn observable_positive_falloff_is_estimable() {
    let obs = synthetic_correspondences(PLANTED_Q, |a, b| (a, b));
    let fit = estimate_falloff(&obs, &[Some(0); 6], 1)[0];
    assert!(fit.estimable && fit.sigma < 0.01, "{fit:?}");
    assert!((fit.q - PLANTED_Q).abs() < 0.01, "{fit:?}");
}
