//! Boundary Warp through the rotation composite (#5572): a jittered ring of
//! synthetic frames whose footprint is ragged top and bottom.

use super::*;
use crate::canvas::{auto_canvas, CanvasOptions};
use crate::composite::composite_tiled_frames;
use crate::gain::FramePhotometry;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::prng::SplitMix64;
use crate::render::{build_camera_set, CameraSetOptions, Pattern};
use crate::seam::SeamStrategy;
use crate::warp::frame_output_bbox;

fn ring() -> Vec<Camera> {
    let opts = CameraSetOptions {
        count: 4,
        pattern: Pattern::Ring { full: false },
        fov_deg: 50.0,
        overlap: 0.35,
        pitch_deg: 0.0,
        jitter_deg: 4.0,
        k1: 0.0,
        k2: 0.0,
        width: 96,
        height: 72,
    };
    build_camera_set(&opts, &mut SplitMix64::new(3))
        .expect("valid ring")
        .iter()
        .map(|c| c.to_camera())
        .collect()
}

fn frame(cam: &Camera) -> PlanarImage {
    let (w, h) = (cam.width, cam.height);
    let samples: Vec<f32> = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| {
            let d = cam
                .pixel_to_world_dir(x as f64 + 0.5, y as f64 + 0.5)
                .expect("invertible");
            (0.4 + 0.2 * (5.0 * d.x).sin() + 0.1 * (3.0 * d.y).cos()) as f32
        })
        .collect();
    PlanarImage::from_planes(
        w,
        h,
        samples.clone(),
        samples.iter().map(|v| v * 0.9).collect(),
        samples.iter().map(|v| v * 0.7).collect(),
        ValidityMask::new_filled(w, h, true),
    )
}

struct Scene {
    cameras: Vec<Camera>,
    frames: Vec<PlanarImage>,
    canvas: CanvasSpec,
    no_lc: Vec<Option<LocalCorrection>>,
}

fn scene() -> Scene {
    let cameras = ring();
    let frames = cameras.iter().map(frame).collect();
    let canvas = auto_canvas(&cameras, &CanvasOptions::default()).expect("canvas");
    let no_lc = vec![None; cameras.len()];
    Scene {
        cameras,
        frames,
        canvas,
        no_lc,
    }
}

fn composite(s: &Scene, canvas: &CanvasSpec, tile_rows: u32, seam: SeamStrategy) -> PlanarImage {
    let photometry = vec![FramePhotometry::IDENTITY; s.cameras.len()];
    composite_tiled_frames(
        &s.frames,
        &s.cameras,
        &photometry,
        &s.no_lc,
        None,
        canvas,
        tile_rows,
        seam,
        &[],
    )
    .expect("composite")
    .0
}

fn warped(s: &Scene, strength: f64) -> (CanvasSpec, BoundaryWarpReport) {
    let (canvas, report) = warped_canvas(&s.canvas, strength, || {
        rotation_footprint(&s.cameras, &s.no_lc, &s.canvas)
    });
    (canvas, report.expect("a positive strength reports"))
}

fn uncovered(image: &PlanarImage) -> usize {
    image.width() as usize * image.height() as usize - image.validity.count_valid()
}

#[test]
fn strength_zero_composites_the_unwarped_canvas_without_a_footprint() {
    let s = scene();
    let (canvas, report) = warped_canvas(&s.canvas, 0.0, || unreachable!("no footprint at 0"));
    assert!(report.is_none() && canvas.boundary_warp().is_none());
}

#[test]
fn a_full_strength_warp_leaves_no_output_pixel_uncovered() {
    let s = scene();
    let unwarped = composite(&s, &s.canvas, 16, SeamStrategy::Voronoi);
    assert!(uncovered(&unwarped) > 0, "the ring's edge must be ragged");
    let (canvas, report) = warped(&s, 1.0);
    assert_eq!(
        report.status,
        crate::boundary_warp::BoundaryWarpStatus::Applied
    );
    for seam in [SeamStrategy::Voronoi, SeamStrategy::GraphCut] {
        let image = composite(&s, &canvas, 16, seam);
        assert_eq!(uncovered(&image), 0, "{seam:?}");
    }
}

#[test]
fn a_warped_composite_is_independent_of_strip_height() {
    let s = scene();
    let (canvas, _) = warped(&s, 0.7);
    let reference = composite(&s, &canvas, canvas.height, SeamStrategy::Voronoi);
    for tile_rows in [5, 23] {
        let strips = composite(&s, &canvas, tile_rows, SeamStrategy::Voronoi);
        assert_eq!(strips.r, reference.r, "tile_rows {tile_rows}");
        assert_eq!(strips.validity, reference.validity, "tile_rows {tile_rows}");
    }
}

#[test]
fn the_output_bbox_holds_every_output_pixel_a_frame_covers() {
    let s = scene();
    let (canvas, _) = warped(&s, 1.0);
    for cam in &s.cameras {
        let bbox = frame_output_bbox(cam, &canvas, 4.0).expect("on canvas");
        let (x0, x1) = bbox.x_spans[0];
        for y in 0..canvas.height {
            for x in 0..canvas.width {
                let lands = canvas
                    .output_pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5)
                    .and_then(|dir| cam.world_dir_to_pixel(dir))
                    .is_some_and(|(fx, fy)| cam.pixel_in_bounds(fx, fy, 0.0));
                assert!(
                    !lands || ((x0..x1).contains(&x) && (bbox.y0..bbox.y1).contains(&y)),
                    "({x}, {y}) outside {bbox:?}"
                );
            }
        }
    }
}
