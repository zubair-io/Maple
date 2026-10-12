//! Rotation-strategy residual exposure field gates (#4521): a planted
//! smooth per-view gradient that global photometry cannot remove is
//! absorbed (seam step energy falls vs field-off), a flat-exposure set
//! solves to a near-zero field, the solve is deterministic, and the field
//! only rescales pixels the tiled composite already produced.

use maple_pano::camera::Camera;
use maple_pano::canvas::{auto_canvas, CanvasOptions, CanvasSpec};
use maple_pano::composite::composite_tiled_frames;
use maple_pano::gain::{
    solve_exposure_field, solve_photometry, ExposureField, FramePhotometry, GainOptions,
    MAX_NODES_PER_VIEW,
};
use maple_pano::ingest::{PlanarImage, ValidityMask};
use maple_pano::prng::SplitMix64;
use maple_pano::render::{build_camera_set, render_frame, CameraSetOptions, Pattern};
use maple_pano::seam::SeamStrategy;
use maple_pano::source::EquirectSource;

/// Log-exposure slope planted across every frame's width: ±0.3 at the
/// frame edges (≈ ±0.43 EV), zero mean so the per-frame gains stay ≈ 1.
const PLANTED_SLOPE: f32 = 0.6;
const BLOCK_PX: u32 = 16;

struct Scene {
    source: EquirectSource,
    cams: Vec<Camera>,
    frames: Vec<PlanarImage>,
    canvas: CanvasSpec,
    photometry: Vec<FramePhotometry>,
}

fn scene(seed: u64, slope: f32) -> Scene {
    let source = EquirectSource::synthetic(2048, 1024, seed).expect("source");
    let opts = CameraSetOptions {
        count: 6,
        pattern: Pattern::Ring { full: true },
        fov_deg: 70.0,
        overlap: 0.35,
        pitch_deg: 0.0,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: 480,
        height: 360,
    };
    let cams: Vec<Camera> = build_camera_set(&opts, &mut SplitMix64::new(seed))
        .expect("ring")
        .iter()
        .map(|c| c.to_camera())
        .collect();
    let frames: Vec<PlanarImage> = cams
        .iter()
        .map(|cam| ramped_frame(&source, cam, slope))
        .collect();
    let canvas = auto_canvas(&cams, &CanvasOptions::default()).expect("canvas");
    let photometry = solve_photometry(&frames, &cams, &GainOptions::default()).expect("gains");
    Scene {
        source,
        cams,
        frames,
        canvas,
        photometry,
    }
}

fn ramped_frame(source: &EquirectSource, cam: &Camera, slope: f32) -> PlanarImage {
    let data = render_frame(source, cam, 2).expect("render");
    let w = cam.width as usize;
    let scale = |i: usize| (slope * (((i % w) as f32 + 0.5) / w as f32 - 0.5)).exp();
    let plane = |c: usize| -> Vec<f32> {
        data.chunks_exact(3)
            .enumerate()
            .map(|(i, px)| px[c] as f32 / 65535.0 * scale(i))
            .collect()
    };
    PlanarImage::from_planes(
        cam.width,
        cam.height,
        plane(0),
        plane(1),
        plane(2),
        ValidityMask::new_filled(cam.width, cam.height, true),
    )
}

fn field_for(s: &Scene) -> ExposureField {
    solve_exposure_field(&s.frames, &s.cams, &s.photometry, &[], &s.canvas).expect("field")
}

fn tiled(s: &Scene, field: Option<&ExposureField>, strategy: SeamStrategy) -> PlanarImage {
    composite_tiled_frames(
        &s.frames,
        &s.cams,
        &s.photometry,
        &[],
        field,
        &s.canvas,
        64,
        strategy,
        &[],
    )
    .expect("tiled composite")
    .0
}

/// Blocks either side of a seam the step is measured across — wider
/// than the multi-band transition, so the blend's spreading of a step is
/// still counted in full.
const SEAM_REACH_BLOCKS: u32 = 4;

/// The frame whose projection of canvas pixel `(x, y)` sits deepest
/// inside it — the Voronoi owner the tiled composite uses.
fn owner(s: &Scene, x: f64, y: f64) -> Option<usize> {
    let dir = s.canvas.pixel_to_dir(x, y)?;
    s.cams
        .iter()
        .enumerate()
        .filter_map(|(i, cam)| {
            let (px, py) = cam.world_dir_to_pixel(dir)?;
            let depth = px
                .min(cam.width as f64 - px)
                .min(py)
                .min(cam.height as f64 - py);
            (depth > 0.0).then_some((i, depth))
        })
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

/// Seam step energy of a composite: at every block where the Voronoi
/// owner changes, the squared jump of the block-mean `ln(out / source)`
/// between [`SEAM_REACH_BLOCKS`] blocks either side, less the jump the
/// local linear trend (measured a further reach out on both sides)
/// predicts — so a view's own smooth gradient does not count as a step.
fn seam_step_energy(out: &PlanarImage, s: &Scene) -> f64 {
    let (w, h) = (out.width(), out.height());
    let (bw, bh) = (w / BLOCK_PX, h / BLOCK_PX);
    let block_error = |bx: u32, by: u32| -> Option<f64> {
        let logs: Vec<f64> = (0..BLOCK_PX * BLOCK_PX)
            .filter_map(|j| {
                let (x, y) = (bx * BLOCK_PX + j % BLOCK_PX, by * BLOCK_PX + j / BLOCK_PX);
                if !out.validity.get(x, y) {
                    return None;
                }
                let dir = s.canvas.pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5)?;
                let src = s.source.sample_dir(dir)?;
                let i = (y * w + x) as usize;
                let got = (out.r[i] + out.g[i] + out.b[i]) as f64 / 3.0;
                let want = (src[0] + src[1] + src[2]) / 3.0;
                (got > 1e-4 && want > 1e-4).then(|| (got / want).ln())
            })
            .collect();
        (logs.len() * 2 >= (BLOCK_PX * BLOCK_PX) as usize)
            .then(|| logs.iter().sum::<f64>() / logs.len() as f64)
    };
    let centre = |b: u32| (b * BLOCK_PX + BLOCK_PX / 2) as f64;
    let steps: Vec<f64> = (0..bh)
        .flat_map(|by| (2 * SEAM_REACH_BLOCKS..bw - 2 * SEAM_REACH_BLOCKS).map(move |bx| (bx, by)))
        .filter(|&(bx, by)| {
            let row = centre(by);
            matches!(
                (owner(s, centre(bx - 1), row), owner(s, centre(bx), row)),
                (Some(a), Some(b)) if a != b
            )
        })
        .filter_map(|(bx, by)| {
            let k = SEAM_REACH_BLOCKS;
            let [far_left, left, right, far_right] =
                [bx - 2 * k, bx - k, bx + k - 1, bx + 2 * k - 1].map(|b| block_error(b, by));
            let (far_left, left, right, far_right) = (far_left?, left?, right?, far_right?);
            let trend =
                0.5 * ((left - far_left) + (far_right - right)) * (2 * k - 1) as f64 / k as f64;
            Some((right - left - trend).powi(2))
        })
        .collect();
    assert!(!steps.is_empty(), "the ring must have seams to measure");
    steps.iter().sum::<f64>() / steps.len() as f64
}

#[test]
fn planted_gradient_seam_step_falls_with_the_field() {
    let s = scene(21, PLANTED_SLOPE);
    let field = field_for(&s);
    let summary = field.summary;
    println!("planted gradient: {summary:?}");
    assert!(
        summary.step_rms_before > 0.05,
        "planted step must be visible"
    );
    assert!(
        summary.step_rms_after < 0.35 * summary.step_rms_before,
        "overlap step {:.4} → {:.4}",
        summary.step_rms_before,
        summary.step_rms_after
    );
    assert!(summary.max_unknowns_per_view <= MAX_NODES_PER_VIEW);

    for strategy in [SeamStrategy::Voronoi, SeamStrategy::GraphCut] {
        let off = seam_step_energy(&tiled(&s, None, strategy), &s);
        let on = seam_step_energy(&tiled(&s, Some(&field), strategy), &s);
        println!("{strategy:?}: seam step energy field-off {off:.3e}, field-on {on:.3e}");
        assert!(
            on < 0.25 * off,
            "{strategy:?}: field-on {on} vs field-off {off}"
        );
    }
}

#[test]
fn flat_exposure_set_solves_to_a_near_zero_field() {
    let s = scene(22, 0.0);
    let summary = field_for(&s).summary;
    println!("flat set: {summary:?}");
    assert!(
        summary.max_abs_log < 0.01,
        "flat set field {}",
        summary.max_abs_log
    );
}

#[test]
fn field_is_deterministic_and_only_rescales_composited_pixels() {
    let s = scene(23, PLANTED_SLOPE);
    let (a, b) = (field_for(&s), field_for(&s));
    assert_eq!(a.summary, b.summary);
    let on = tiled(&s, Some(&a), SeamStrategy::Voronoi);
    let again = tiled(&s, Some(&b), SeamStrategy::Voronoi);
    let bits = |img: &PlanarImage| -> Vec<u32> {
        img.r
            .iter()
            .chain(&img.g)
            .chain(&img.b)
            .map(|v| v.to_bits())
            .collect()
    };
    assert_eq!(bits(&on), bits(&again), "composite must be bit-identical");

    let off = tiled(&s, None, SeamStrategy::Voronoi);
    assert_eq!((on.width(), on.height()), (off.width(), off.height()));
    assert_eq!(on.validity.count_valid(), off.validity.count_valid());
}
