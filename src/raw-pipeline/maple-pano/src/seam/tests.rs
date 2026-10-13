use crate::camera::Camera;
use crate::canvas::{auto_canvas, CanvasOptions};
use crate::gain::FramePhotometry;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::local_align::LocalCorrection;
use crate::prng::SplitMix64;
use crate::render::{build_camera_set, CameraSetOptions, Pattern};

use crate::canvas::CanvasSpec;
use crate::warp::warp_to_canvas;

use super::constraints::{rasterize, validate, CanvasRect, SeamConstraint, SeamPins};
use super::labels::compute_labels;
use super::masks::build_from_frames;
use super::{SeamConstraintError, SeamMasks};

fn fnv1a(bytes: impl IntoIterator<Item = u8>) -> u64 {
    bytes.into_iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn textured(w: u32, h: u32, valid: impl Fn(u32, u32) -> bool, seed: u32) -> PlanarImage {
    let n = (w as usize) * (h as usize);
    let mut mask = ValidityMask::new_filled(w, h, false);
    let mut r = vec![0.0_f32; n];
    for y in 0..h {
        for x in 0..w {
            mask.set(x, y, valid(x, y));
            let idx = (y * w + x) as usize;
            let base = 0.3 + 0.2 * ((x as f32) * 0.37).sin() * ((y as f32) * 0.21).cos();
            let blob = (20..28).contains(&x) && (8..16).contains(&y) && seed == 1;
            r[idx] = if blob {
                0.9 - 0.8 * (((x + y) % 2) as f32)
            } else {
                base
            };
        }
    }
    let g = r.iter().map(|v| v * 0.9).collect();
    let b = r.iter().map(|v| v * 0.7).collect();
    PlanarImage::from_planes(w, h, r, g, b, mask)
}

pub(super) fn three_band_layers() -> Vec<PlanarImage> {
    let (w, h) = (48, 24);
    vec![
        textured(w, h, |x, _| x < 22, 0),
        textured(w, h, |x, _| (14..34).contains(&x), 1),
        textured(w, h, |x, _| x >= 26, 2),
    ]
}

fn ring_cameras(count: u32) -> Vec<Camera> {
    let opts = CameraSetOptions {
        count,
        pattern: Pattern::Ring { full: false },
        fov_deg: 60.0,
        overlap: 0.4,
        pitch_deg: 0.0,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: 64,
        height: 48,
    };
    build_camera_set(&opts, &mut SplitMix64::new(7))
        .expect("valid ring")
        .iter()
        .map(|c| c.to_camera())
        .collect()
}

fn frame_from_scene(cam: &Camera, blob: bool) -> PlanarImage {
    let (w, h) = (cam.width, cam.height);
    let n = (w as usize) * (h as usize);
    let (mut r, mut g, mut b) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
    for y in 0..h {
        for x in 0..w {
            let d = cam
                .pixel_to_world_dir(x as f64 + 0.5, y as f64 + 0.5)
                .expect("invertible");
            let v = (0.5 + 0.3 * (5.0 * d.x).sin() * (3.0 * d.y).cos()) as f32;
            let v = if blob && (x / 3 + y / 3) % 2 == 0 && x < w / 3 {
                0.95
            } else {
                v
            };
            let i = (y * w + x) as usize;
            r[i] = v;
            g[i] = v * 0.9;
            b[i] = v * 0.8;
        }
    }
    PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
}

#[test]
fn unconstrained_labels_match_pre_constraint_golden() {
    let labels = compute_labels(&three_band_layers(), &SeamPins::none());
    let hash = fnv1a(labels.iter().flat_map(|l| l.to_le_bytes()));
    assert_eq!(hash, 0x0453_179b_0a4f_44a5);
}

#[test]
fn unconstrained_seam_masks_match_pre_constraint_golden() {
    let ring = Ring::new();
    let seam = ring.masks(&[]).expect("unconstrained seam");
    let canvas = &ring.canvas;
    let weights = (0..canvas.height)
        .flat_map(|y| (0..canvas.width).flat_map(move |x| (0..3).map(move |i| (i, x, y))));
    let hash = fnv1a(weights.flat_map(|(i, x, y)| {
        seam.weight(i, x as f64 + 0.5, y as f64 + 0.5)
            .to_bits()
            .to_le_bytes()
    }));
    assert_eq!(hash, 0x87e3_b328_80b0_98ea);
}

struct Ring {
    cams: Vec<Camera>,
    frames: Vec<PlanarImage>,
    canvas: CanvasSpec,
}

impl Ring {
    fn new() -> Self {
        let cams = ring_cameras(3);
        let frames = cams
            .iter()
            .enumerate()
            .map(|(i, c)| frame_from_scene(c, i == 1))
            .collect();
        let canvas = auto_canvas(&cams, &CanvasOptions::default()).expect("canvas");
        Self {
            cams,
            frames,
            canvas,
        }
    }

    fn masks(&self, constraints: &[SeamConstraint]) -> Result<SeamMasks, crate::error::PanoError> {
        let photometry = vec![FramePhotometry::IDENTITY; self.cams.len()];
        let no_lc: Vec<Option<LocalCorrection>> = vec![None; self.cams.len()];
        build_from_frames(
            &self.frames,
            &self.cams,
            &photometry,
            &no_lc,
            &self.canvas,
            constraints,
        )
    }

    /// `(frame with the least, frame with the most)` unconstrained weight
    /// over `r` among frames 0 and 1, so each gate has to move the seam.
    fn ownership(&self, r: CanvasRect) -> (usize, usize) {
        let free = self.masks(&[]).expect("unconstrained seam");
        let total = |f: usize| -> f32 { rect_pixels(r).map(|(x, y)| free.weight(f, x, y)).sum() };
        if total(0) < total(1) {
            (0, 1)
        } else {
            (1, 0)
        }
    }

    /// A rectangle well inside the overlap of frames 0 and 1.
    fn overlap_rect(&self) -> CanvasRect {
        let layers: Vec<PlanarImage> = self
            .frames
            .iter()
            .zip(&self.cams)
            .map(|(f, c)| warp_to_canvas(f, c, &self.canvas, FramePhotometry::IDENTITY, None))
            .collect();
        let both = |x: u32, y: u32| layers[0].validity.get(x, y) && layers[1].validity.get(x, y);
        let (w, h) = (self.canvas.width, self.canvas.height);
        let cols: Vec<u32> = (0..w).filter(|&x| both(x, h / 2)).collect();
        let x_mid = cols[cols.len() / 2];
        let rows: Vec<u32> = (0..h).filter(|&y| both(x_mid, y)).collect();
        let y_mid = rows[rows.len() / 2];
        CanvasRect {
            x: x_mid - 3,
            y: y_mid - 6,
            width: 6,
            height: 12,
        }
    }
}

fn rect_pixels(r: CanvasRect) -> impl Iterator<Item = (f64, f64)> {
    (r.y..r.y + r.height)
        .flat_map(move |y| (r.x..r.x + r.width).map(move |x| (x as f64 + 0.5, y as f64 + 0.5)))
}

fn labels_in(labels: &[i32], w: u32, r: CanvasRect) -> Vec<i32> {
    (r.y..r.y + r.height)
        .flat_map(|y| (r.x..r.x + r.width).map(move |x| labels[(y * w + x) as usize]))
        .collect()
}

const BLOB: CanvasRect = CanvasRect {
    x: 16,
    y: 4,
    width: 6,
    height: 16,
};

#[test]
fn force_include_region_is_entirely_labelled_with_its_frame() {
    let layers = three_band_layers();
    let free = compute_labels(&layers, &SeamPins::none());
    assert!(
        labels_in(&free, 48, BLOB).iter().any(|&l| l != 0),
        "the unconstrained cut must not already give frame 0 the whole region"
    );
    let pins = rasterize(&[SeamConstraint::ForceInclude(0, BLOB)], &layers, 1.0, 1.0)
        .expect("satisfiable");
    let pinned = compute_labels(&layers, &pins);
    assert!(labels_in(&pinned, 48, BLOB).iter().all(|&l| l == 0));
}

#[test]
fn force_exclude_region_contains_no_pixel_of_its_frame() {
    let layers = three_band_layers();
    let region = CanvasRect {
        x: 26,
        y: 2,
        width: 8,
        height: 20,
    };
    let free = compute_labels(&layers, &SeamPins::none());
    assert!(labels_in(&free, 48, region).contains(&1));
    let pins = rasterize(
        &[SeamConstraint::ForceExclude(1, region)],
        &layers,
        1.0,
        1.0,
    )
    .expect("satisfiable");
    let pinned = compute_labels(&layers, &pins);
    let inside = labels_in(&pinned, 48, region);
    assert!(inside.iter().all(|&l| l == 2), "got {inside:?}");
}

#[test]
fn full_resolution_weights_honour_force_include() {
    let ring = Ring::new();
    let r = ring.overlap_rect();
    let (loser, _) = ring.ownership(r);
    let seam = ring
        .masks(&[SeamConstraint::ForceInclude(loser, r)])
        .expect("satisfiable");
    for (x, y) in rect_pixels(r) {
        assert!((seam.weight(loser, x, y) - 1.0).abs() < 1e-5, "({x},{y})");
        for other in (0..3).filter(|&f| f != loser) {
            assert_eq!(seam.weight(other, x, y), 0.0, "frame {other} at ({x},{y})");
        }
    }
}

#[test]
fn full_resolution_weights_honour_force_exclude() {
    let ring = Ring::new();
    let r = ring.overlap_rect();
    let (_, winner) = ring.ownership(r);
    let seam = ring
        .masks(&[SeamConstraint::ForceExclude(winner, r)])
        .expect("satisfiable");
    for (x, y) in rect_pixels(r) {
        assert_eq!(seam.weight(winner, x, y), 0.0, "({x},{y})");
        let rest: f32 = (0..3).map(|f| seam.weight(f, x, y)).sum();
        assert!(rest > 0.99, "({x},{y}) left uncovered: {rest}");
    }
}

#[test]
fn constraints_rasterize_through_the_seam_canvas_scale() {
    let layers = three_band_layers();
    let rect = CanvasRect {
        x: 50,
        y: 20,
        width: 5,
        height: 5,
    };
    let pins = rasterize(&[SeamConstraint::ForceInclude(1, rect)], &layers, 0.5, 0.5)
        .expect("satisfiable");
    let forced = |x: u32, y: u32| pins.forced((y * 48 + x) as usize);
    for (x, y) in (10..13).flat_map(|y| (25..28).map(move |x| (x, y))) {
        assert_eq!(forced(x, y), Some(1), "core ({x},{y})");
    }
    assert_eq!(forced(21, 10), Some(1), "halo reaches feather + 1");
    assert_eq!(forced(20, 10), None, "halo stops at feather + 1");
}

#[test]
fn conflicting_constraints_are_typed_errors() {
    let layers = three_band_layers();
    let at = |x, width| CanvasRect {
        x,
        y: 6,
        width,
        height: 6,
    };
    let err = |cs: &[SeamConstraint]| rasterize(cs, &layers, 1.0, 1.0).expect_err("conflict");

    assert!(matches!(
        err(&[
            SeamConstraint::ForceInclude(0, at(15, 4)),
            SeamConstraint::ForceInclude(1, at(17, 4)),
        ]),
        SeamConstraintError::OverlappingIncludes {
            first: 0,
            second: 1,
            ..
        }
    ));
    assert!(matches!(
        err(&[SeamConstraint::ForceExclude(1, at(22, 4))]),
        SeamConstraintError::NoCandidate { x: 22.., .. }
    ));
    assert!(matches!(
        err(&[
            SeamConstraint::ForceInclude(1, at(16, 4)),
            SeamConstraint::ForceExclude(1, at(18, 4)),
        ]),
        SeamConstraintError::IncludeExcluded { frame: 1, .. }
    ));
    assert!(matches!(
        err(&[SeamConstraint::ForceInclude(2, at(20, 8))]),
        SeamConstraintError::IncludeOutsideFrame { frame: 2, .. }
    ));
}

#[test]
fn invalid_constraints_are_rejected_before_the_solve() {
    let ring = Ring::new();
    let r = ring.overlap_rect();
    assert_eq!(
        ring.masks(&[SeamConstraint::ForceInclude(3, r)])
            .err()
            .map(|e| e.to_string()),
        Some(
            crate::error::PanoError::from(SeamConstraintError::UnknownFrame {
                frame: 3,
                frames: 3
            })
            .to_string()
        )
    );
    let outside = CanvasRect {
        x: ring.canvas.width,
        ..r
    };
    assert!(matches!(
        validate(&[SeamConstraint::ForceExclude(0, outside)], 3, &ring.canvas),
        Err(SeamConstraintError::EmptyRegion { frame: 0, .. })
    ));
}

#[test]
fn tiled_graph_cut_composite_shows_only_the_force_included_frame() {
    use crate::composite::composite_tiled_frames;
    use crate::seam::SeamStrategy;

    let ring = Ring::new();
    let r = ring.overlap_rect();
    let (loser, _) = ring.ownership(r);
    let photometry = vec![FramePhotometry::IDENTITY; 3];
    let constraint = [SeamConstraint::ForceInclude(loser, r)];
    let run = |strategy| {
        composite_tiled_frames(
            &ring.frames,
            &ring.cams,
            &photometry,
            &[],
            None,
            &ring.canvas,
            16,
            strategy,
            &constraint,
        )
    };

    assert!(matches!(
        run(SeamStrategy::Voronoi),
        Err(crate::error::PanoError::SeamConstraint(
            SeamConstraintError::RequiresGraphCut
        ))
    ));
    let (image, _) = run(SeamStrategy::GraphCut).expect("graph-cut composite");
    let only = warp_to_canvas(
        &ring.frames[loser],
        &ring.cams[loser],
        &ring.canvas,
        FramePhotometry::IDENTITY,
        None,
    );
    let winner = 1 - loser;
    let other = warp_to_canvas(
        &ring.frames[winner],
        &ring.cams[winner],
        &ring.canvas,
        FramePhotometry::IDENTITY,
        None,
    );
    // The tiled composite is multi-band (#4524): the seam's low frequencies
    // reach a few pixels into a 6×12 rectangle, so the included frame's
    // content must dominate there rather than match it bit for bit.
    for (x, y) in rect_pixels(r) {
        let i = (y as usize) * (ring.canvas.width as usize) + x as usize;
        for (img, inc, exc) in [
            (image.r[i], only.r[i], other.r[i]),
            (image.b[i], only.b[i], other.b[i]),
        ] {
            assert!((img - inc).abs() < 0.02, "({x},{y}) {img} vs {inc}");
            if (inc - exc).abs() > 0.1 {
                assert!((img - inc).abs() < 0.25 * (inc - exc).abs(), "({x},{y})");
            }
        }
    }
}
