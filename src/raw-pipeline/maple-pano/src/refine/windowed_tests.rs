use std::sync::atomic::{AtomicU32, Ordering};

use super::*;
use crate::camera::{focal_px_for_hfov, Camera};
use crate::frame_store::InMemory;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::math::Mat3;
use crate::refine::refine_correspondences;

const W: u32 = 300;
const H: u32 = 2400;

fn textured(shift: (f64, f64)) -> PlanarImage {
    image(|x, y| {
        let (fx, fy) = (x - shift.0, y - shift.1);
        (fx * 0.37).sin() * (fy * 0.23).cos() + (fx * fy * 0.002).sin() + 2.0
    })
}

fn image(luma: impl Fn(f64, f64) -> f64) -> PlanarImage {
    let plane: Vec<f32> = (0..H)
        .flat_map(|y| (0..W).map(move |x| (x, y)))
        .map(|(x, y)| luma(f64::from(x) + 0.5, f64::from(y) + 0.5) as f32)
        .collect();
    let mut validity = ValidityMask::new_filled(W, H, true);
    validity.set(W / 3, H / 2, false);
    PlanarImage::from_planes(W, H, plane.clone(), plane.clone(), plane, validity)
}

/// In-memory frames that record the tallest rectangle read from them.
struct Recording<'a> {
    inner: InMemory<'a>,
    tallest_read: AtomicU32,
}

impl FrameRows for Recording<'_> {
    fn frame_count(&self) -> usize {
        self.inner.frame_count()
    }
    fn frame_dims(&self, idx: usize) -> Result<(u32, u32), PanoError> {
        self.inner.frame_dims(idx)
    }
    fn read_rows(&self, idx: usize, y0: u32, rows: u32) -> Result<PlanarImage, PanoError> {
        self.tallest_read.fetch_max(rows, Ordering::Relaxed);
        self.inner.read_rows(idx, y0, rows)
    }
    fn read_rect(&self, idx: usize, rect: FrameRect) -> Result<PlanarImage, PanoError> {
        self.tallest_read.fetch_max(rect.height, Ordering::Relaxed);
        self.inner.read_rect(idx, rect)
    }
}

/// Coherent matches across every band and both frame edges, matches whose
/// B seeds are scattered over the whole of frame B, and a non-finite one.
fn matches() -> Vec<PixelCorrespondence> {
    let at = |k: usize| {
        (
            (k * 37 % W as usize) as f64 / 2.0,
            (k * 97 % H as usize) as f64 / 2.0,
        )
    };
    let coherent = (0..160).map(|k| {
        let (x, y) = at(k);
        PixelCorrespondence {
            a: (x, y),
            b: (x + 1.1, y - 0.8),
        }
    });
    let scattered = (0..40).map(|k| {
        let (x, y) = at(k + 500);
        PixelCorrespondence {
            a: (x, y),
            b: (x, (y * 7.3) % (f64::from(H) / 2.0)),
        }
    });
    coherent
        .chain(scattered)
        .chain([PixelCorrespondence {
            a: (f64::NAN, 3.0),
            b: (2.0, 3.0),
        }])
        .collect()
}

/// Refines `matches` both ways, asserts the outcomes are bit-identical,
/// and returns the whole-frame outcome and the tallest banded read.
fn assert_banded_equals_whole(
    frames: &[PlanarImage; 2],
    matches: &[PixelCorrespondence],
    geometry: Option<&RefineGeometry<'_>>,
) -> (RefineOutcome, u32) {
    let (opts, scale) = (RefineOptions::default(), (2.0, 2.0));
    let whole = refine_correspondences(
        &frames[0], &frames[1], scale, scale, geometry, matches, &opts,
    );
    let recording = Recording {
        inner: InMemory(frames),
        tallest_read: AtomicU32::new(0),
    };
    let banded =
        refine_from_frames(&recording, 0, 1, scale, scale, geometry, matches, &opts).unwrap();
    assert_eq!(banded.refined_mask, whole.refined_mask);
    assert_eq!(banded.refined_count, whole.refined_count);
    let bits = |o: &RefineOutcome| -> Vec<[u64; 4]> {
        o.refined
            .iter()
            .map(|c| [c.a.0, c.a.1, c.b.0, c.b.1].map(f64::to_bits))
            .collect()
    };
    assert_eq!(bits(&banded), bits(&whole));
    (whole, recording.tallest_read.into_inner())
}

/// Banded window reads refine every match exactly as whole frames do,
/// and no read is much taller than one band, even for scattered B seeds.
#[test]
fn banded_refinement_matches_whole_frame_refinement() {
    let frames = [textured((0.0, 0.0)), textured((2.3, -1.6))];
    let (whole, tallest_read) = assert_banded_equals_whole(&frames, &matches(), None);
    assert!(
        whole.refined_count > 80,
        "too few refined: {}",
        whole.refined_count
    );
    assert!(
        tallest_read < 640,
        "read {tallest_read} of {H} rows at once"
    );
}

/// The same through the rotation path's per-match warped templates: frame
/// B is frame A rolled about the principal point, so every template is
/// sampled well away from the identity and still refines.
#[test]
fn banded_refinement_matches_whole_frame_refinement_with_geometry() {
    let cam = Camera::new([0.0; 3], focal_px_for_hfov(20.0, W), 0.0, 0.0, W, H);
    let rotation = Mat3::rotation_z(0.25);
    let geometry = RefineGeometry {
        cam_a: &cam,
        cam_b: &cam,
        rotation: &rotation,
    };
    let c = cam.principal_point();
    let m = warp::local_warp_inverse(&geometry, c).unwrap();
    assert!(
        m[1].abs() > 0.2,
        "template warp too close to identity: {m:?}"
    );
    let det = m[0] * m[3] - m[1] * m[2];
    let j = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
    let luma =
        |x: f64, y: f64| (x * 0.37).sin() * (y * 0.23).cos() + (0.11 * x + 0.17 * y).sin() + 2.0;
    let shift = (0.3, -0.2);
    let frames = [
        image(luma),
        image(|x, y| {
            let (dx, dy) = (x - c.0 - shift.0, y - c.1 - shift.1);
            luma(c.0 + m[0] * dx + m[1] * dy, c.1 + m[2] * dx + m[3] * dy)
        }),
    ];
    let matches: Vec<PixelCorrespondence> = (0..160)
        .map(|k| {
            let a = (20.0 + (k * 37 % 260) as f64, 700.0 + (k * 97 % 1000) as f64);
            let (dx, dy) = (a.0 - c.0, a.1 - c.1);
            let b = (
                c.0 + j[0] * dx + j[1] * dy + shift.0 + 0.6,
                c.1 + j[2] * dx + j[3] * dy + shift.1 - 0.5,
            );
            PixelCorrespondence {
                a: (a.0 / 2.0, a.1 / 2.0),
                b: (b.0 / 2.0, b.1 / 2.0),
            }
        })
        .collect();
    let (whole, _) = assert_banded_equals_whole(&frames, &matches, Some(&geometry));
    assert!(
        whole.refined_count > 40,
        "too few refined: {}",
        whole.refined_count
    );
}

#[test]
fn grid_bounds_cover_a_warped_grid_and_its_stencils() {
    let m = [0.8, 0.3, -0.2, 1.1];
    let (x0, y0, x1, y1) = grid_bounds((40.3, 25.7), 6, &m);
    for (i, j) in [(-6.0, -6.0), (6.0, -6.0), (-6.0, 6.0), (6.0, 6.0)] {
        let (x, y) = (40.3 + m[0] * i + m[1] * j, 25.7 + m[2] * i + m[3] * j);
        let (sx, sy) = ((x - 0.5).floor() as i64, (y - 0.5).floor() as i64);
        assert!(x0 <= sx && sx + 1 <= x1 && y0 <= sy && sy + 1 <= y1);
    }
}
