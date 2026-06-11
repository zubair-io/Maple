//! Validity-aware inverse-map warp onto a projection canvas (M2-CPU,
//! #1155; stitching spec §5.6).
//!
//! Per canvas pixel: canvas → world direction ([`CanvasSpec::pixel_to_dir`])
//! → camera forward projection (rotation + intrinsics + distortion,
//! [`Camera::world_dir_to_pixel`]) → bicubic Catmull-Rom tap on the
//! source [`PlanarImage`] with **validity-weighted, renormalized**
//! kernel taps — invalid and out-of-frame taps get zero weight, so
//! frame edges and masked holes never smear into the output. A canvas
//! pixel is invalid when it maps outside the source frame, behind the
//! camera, or onto fully-invalid taps.
//!
//! The optional per-frame gain (spec §5.5) is folded into the sampling
//! loop — same shape as the WGSL `warp_inverse` kernel will use (eng
//! design §5, "gain multiplier folded in — saves a pass").
//!
//! Rows are rayon-parallel; per-pixel work is pure, so output is
//! byte-deterministic for identical inputs.
//!
//! **Tiling hook (eng design §6):** this CPU reference materializes the
//! full canvas-sized buffer per frame, which is acceptable at test
//! sizes. The production tiled path runs the identical per-pixel chain
//! over canvas tiles with only contributing source tiles resident —
//! [`frame_canvas_bbox`] is the per-frame tile-culling primitive.

use rayon::prelude::*;

use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::math::Vec3;
use crate::project::Projection;

use std::f64::consts::TAU;

/// Canvas-space footprint of a source frame: a y range plus one or two
/// half-open x spans (two when the frame straddles a fully-wrapped
/// canvas's wrap seam).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasBBox {
    pub x_spans: Vec<(u32, u32)>,
    pub y0: u32,
    pub y1: u32,
}

impl CanvasBBox {
    /// Total pixel count covered by the bbox.
    pub fn pixel_count(&self) -> usize {
        let rows = (self.y1 - self.y0) as usize;
        self.x_spans
            .iter()
            .map(|&(x0, x1)| (x1 - x0) as usize * rows)
            .sum()
    }
}

/// Compute the canvas-space bounding box of a camera frame, expanded by
/// `margin_px` on every side. Conservative: the box always contains the
/// frame's full footprint (border extremes bound the interior for these
/// projections as long as no pole lies inside the frame; pole-containing
/// frames get the full x range and an extended y range).
///
/// Returns `None` when nothing of the frame can land on the canvas
/// (e.g. the frame is entirely behind a rectilinear canvas plane).
pub fn frame_canvas_bbox(cam: &Camera, canvas: &CanvasSpec, margin_px: f64) -> Option<CanvasBBox> {
    let w = cam.width as f64;
    let h = cam.height as f64;
    let cw = canvas.width as f64;
    let ch = canvas.height as f64;

    // Border ring: 16 samples per edge + exact corners.
    const EDGE: usize = 16;
    let mut dirs: Vec<Vec3> = Vec::with_capacity(4 * (EDGE + 1));
    for i in 0..=EDGE {
        let t = i as f64 / EDGE as f64;
        for (px, py) in [(t * w, 0.0), (t * w, h), (0.0, t * h), (w, t * h)] {
            if let Some(d) = cam.pixel_to_world_dir(px, py) {
                dirs.push(d);
            }
        }
    }
    if dirs.is_empty() {
        return None;
    }
    let center = cam.pixel_to_world_dir(w * 0.5, h * 0.5);

    let sees = |dir: Vec3| {
        cam.world_dir_to_pixel(dir)
            .is_some_and(|(px, py)| cam.pixel_in_bounds(px, py, 0.0))
    };
    let sees_zenith = sees(Vec3::new(0.0, -1.0, 0.0));
    let sees_nadir = sees(Vec3::new(0.0, 1.0, 0.0));

    let mut any_unrepresentable = sees_zenith || sees_nadir;
    let mut px_lo = f64::INFINITY;
    let mut px_hi = f64::NEG_INFINITY;
    let mut py_lo = f64::INFINITY;
    let mut py_hi = f64::NEG_INFINITY;

    // Unwrap x around the frame center for the angular projections so a
    // frame straddling the canvas's u-origin gets a contiguous span.
    let period = match canvas.projection {
        Projection::Rectilinear => f64::INFINITY,
        _ => TAU * canvas.pixels_per_radian(),
    };
    let center_px = center.and_then(|d| canvas.dir_to_pixel(d)).map(|(x, _)| x);

    for d in &dirs {
        match canvas.dir_to_pixel(*d) {
            None => any_unrepresentable = true,
            Some((mut px, py)) => {
                if let (Some(cx), true) = (center_px, period.is_finite()) {
                    let rel = px - cx;
                    px = cx + rel - (rel / period + 0.5).floor() * period;
                }
                px_lo = px_lo.min(px);
                px_hi = px_hi.max(px);
                py_lo = py_lo.min(py);
                py_hi = py_hi.max(py);
            }
        }
    }
    if !px_lo.is_finite() {
        // Every border direction is unrepresentable (and no pole seen):
        // nothing of the frame is on this canvas.
        if !(sees_zenith || sees_nadir) {
            return None;
        }
        (px_lo, px_hi, py_lo, py_hi) = (0.0, cw, 0.0, ch);
    }

    // A frame containing a pole covers every longitude; a frame with
    // unrepresentable border directions (rect canvas horizon,
    // cylindrical pole) gets the conservative full x range too.
    if any_unrepresentable {
        px_lo = 0.0;
        px_hi = cw;
        if sees_zenith {
            py_lo = 0.0;
        }
        if sees_nadir {
            py_hi = ch;
        }
        if !(sees_zenith || sees_nadir) {
            // Rect-canvas horizon case: extent along y is unbounded in
            // the unrepresentable direction — take the full canvas.
            py_lo = 0.0;
            py_hi = ch;
        }
    }

    px_lo -= margin_px;
    px_hi += margin_px;
    let y0 = ((py_lo - margin_px).floor().max(0.0)) as u32;
    let y1 = ((py_hi + margin_px).ceil().min(ch).max(0.0)) as u32;
    if y0 >= y1 {
        return None;
    }

    let x_spans = if px_hi - px_lo >= cw {
        vec![(0u32, canvas.width)]
    } else if canvas.is_full_wrap() {
        // Wrap spans modulo the canvas width.
        let lo = px_lo.floor().rem_euclid(cw);
        let hi = px_hi.ceil().rem_euclid(cw);
        if lo <= hi {
            vec![(lo as u32, (hi as u32).min(canvas.width).max(lo as u32 + 1))]
        } else {
            vec![
                (0u32, (hi as u32 + 1).min(canvas.width)),
                (lo as u32, canvas.width),
            ]
        }
    } else {
        let lo = px_lo.floor().max(0.0) as u32;
        let hi = (px_hi.ceil().min(cw) as u32).min(canvas.width);
        if lo >= hi {
            return None;
        }
        vec![(lo, hi)]
    };

    Some(CanvasBBox { x_spans, y0, y1 })
}

/// Catmull-Rom kernel weights for the four taps at lattice offsets
/// `-1, 0, +1, +2` around a sample at fractional position `f ∈ [0, 1)`.
/// The weights sum to exactly 1 in exact arithmetic.
#[inline]
fn catmull_rom_weights(f: f64) -> [f64; 4] {
    let f2 = f * f;
    let f3 = f2 * f;
    [
        -0.5 * f3 + f2 - 0.5 * f,
        1.5 * f3 - 2.5 * f2 + 1.0,
        -1.5 * f3 + 2.0 * f2 + 0.5 * f,
        0.5 * f3 - 0.5 * f2,
    ]
}

/// Minimum |Σ weights| for a renormalized sample to count as covered.
/// Below this the valid taps are only far negative-lobe contributions —
/// the pixel is treated as invalid rather than amplified.
const MIN_TAP_WEIGHT: f64 = 1e-4;

/// Bicubic Catmull-Rom sample at continuous pixel coordinates (texel
/// centers at half-integers), with validity-weighted renormalized taps.
/// Returns `None` when no usable tap weight survives (fully invalid
/// neighborhood).
fn sample_bicubic(src: &PlanarImage, x_px: f64, y_px: f64) -> Option<[f32; 3]> {
    let w = src.width() as i64;
    let h = src.height() as i64;
    let x = x_px - 0.5;
    let y = y_px - 0.5;
    let x1 = x.floor();
    let y1 = y.floor();
    let wx = catmull_rom_weights(x - x1);
    let wy = catmull_rom_weights(y - y1);
    let (x1, y1) = (x1 as i64, y1 as i64);

    let mut acc = [0.0_f64; 3];
    let mut wsum = 0.0_f64;
    for (j, &wyj) in wy.iter().enumerate() {
        let ty = y1 - 1 + j as i64;
        if ty < 0 || ty >= h {
            continue;
        }
        let row = ty as usize * src.width() as usize;
        for (i, &wxi) in wx.iter().enumerate() {
            let tx = x1 - 1 + i as i64;
            if tx < 0 || tx >= w {
                continue;
            }
            if !src.validity.get(tx as u32, ty as u32) {
                continue;
            }
            let wgt = wxi * wyj;
            let idx = row + tx as usize;
            acc[0] += wgt * src.r[idx] as f64;
            acc[1] += wgt * src.g[idx] as f64;
            acc[2] += wgt * src.b[idx] as f64;
            wsum += wgt;
        }
    }
    if wsum.abs() < MIN_TAP_WEIGHT {
        return None;
    }
    let inv = 1.0 / wsum;
    Some([
        (acc[0] * inv) as f32,
        (acc[1] * inv) as f32,
        (acc[2] * inv) as f32,
    ])
}

/// Warp one source frame onto the canvas. `gain` is the per-channel
/// multiplier from gain compensation (`[1.0; 3]` = none), folded into
/// the sampling loop.
///
/// The output is a canvas-sized [`PlanarImage`] whose validity marks
/// exactly the pixels that received a covered sample.
pub fn warp_to_canvas(
    src: &PlanarImage,
    cam: &Camera,
    canvas: &CanvasSpec,
    gain: [f32; 3],
) -> PlanarImage {
    assert_eq!(
        (src.width(), src.height()),
        (cam.width, cam.height),
        "source frame and camera dimensions must agree"
    );
    let cw = canvas.width as usize;
    let ch = canvas.height as usize;
    let n = cw * ch;
    let mut r = vec![0.0_f32; n];
    let mut g = vec![0.0_f32; n];
    let mut b = vec![0.0_f32; n];
    let mut valid = vec![false; n];

    // Bicubic support is 2 px; bbox margin covers it plus border
    // sampling slack.
    let bbox = frame_canvas_bbox(cam, canvas, 4.0);

    if let Some(bbox) = bbox {
        let src_w = src.width() as f64;
        let src_h = src.height() as f64;
        let y0 = bbox.y0 as usize;
        let y1 = bbox.y1 as usize;

        r[y0 * cw..y1 * cw]
            .par_chunks_mut(cw)
            .zip(g[y0 * cw..y1 * cw].par_chunks_mut(cw))
            .zip(b[y0 * cw..y1 * cw].par_chunks_mut(cw))
            .zip(valid[y0 * cw..y1 * cw].par_chunks_mut(cw))
            .enumerate()
            .for_each(|(dy, (((row_r, row_g), row_b), row_v))| {
                let py = (y0 + dy) as f64 + 0.5;
                for &(sx0, sx1) in &bbox.x_spans {
                    for x in sx0 as usize..sx1 as usize {
                        let px = x as f64 + 0.5;
                        let Some(dir) = canvas.pixel_to_dir(px, py) else {
                            continue;
                        };
                        let Some((fx, fy)) = cam.world_dir_to_pixel(dir) else {
                            continue;
                        };
                        // Footprint test: the sample point must land on
                        // the source frame.
                        if fx < 0.0 || fx > src_w || fy < 0.0 || fy > src_h {
                            continue;
                        }
                        let Some(s) = sample_bicubic(src, fx, fy) else {
                            continue;
                        };
                        row_r[x] = s[0] * gain[0];
                        row_g[x] = s[1] * gain[1];
                        row_b[x] = s[2] * gain[2];
                        row_v[x] = true;
                    }
                }
            });
    }

    let mut mask = ValidityMask::new_filled(canvas.width, canvas.height, false);
    for y in 0..ch {
        let row = y * cw;
        for x in 0..cw {
            if valid[row + x] {
                mask.set(x as u32, y as u32, true);
            }
        }
    }
    PlanarImage::from_planes(canvas.width, canvas.height, r, g, b, mask)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas::CanvasSpec;
    use crate::math::Mat3;
    use crate::project::Projection;

    fn planar_from_fn(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> PlanarImage {
        let n = (w as usize) * (h as usize);
        let (mut r, mut g, mut b) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        for y in 0..h {
            for x in 0..w {
                let p = f(x, y);
                r.push(p[0]);
                g.push(p[1]);
                b.push(p[2]);
            }
        }
        PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
    }

    /// Rectilinear canvas exactly aligned with a distortion-free
    /// camera: the warp is the identity mapping (up to f64 rounding in
    /// the projection round trip).
    fn aligned_canvas(cam: &Camera) -> CanvasSpec {
        let f = cam.focal_px;
        CanvasSpec::with_window(
            Projection::Rectilinear,
            cam.width,
            cam.height,
            -(cam.width as f64 * 0.5) / f,
            -(cam.height as f64 * 0.5) / f,
            1.0 / f,
            1.0 / f,
            cam.rotation,
            false,
        )
        .unwrap()
    }

    /// Identity warp reproduces the source to ~f64 rounding noise
    /// (≤ 1e-9 — projecting through the canvas/camera chain leaves the
    /// sample a few ulp off the exact texel center, so true bit
    /// equality is not attainable; any half-pixel convention bug would
    /// show up as errors at the 1e-2 scale on this content).
    #[test]
    fn identity_warp_reproduces_source_near_exactly() {
        let cam = Camera::new([0.2, -0.7, 0.1], 240.0, 0.0, 0.0, 96, 72);
        let src = planar_from_fn(96, 72, |x, y| {
            [
                (x as f32 * 0.013).sin().abs(),
                (y as f32 * 0.031).cos().abs(),
                ((x + y) as f32 * 0.007).fract(),
            ]
        });
        let out = warp_to_canvas(&src, &cam, &aligned_canvas(&cam), [1.0; 3]);
        for i in 0..src.pixel_count() {
            assert!((out.r[i] - src.r[i]).abs() < 1e-9, "R at {i}");
            assert!((out.g[i] - src.g[i]).abs() < 1e-9, "G at {i}");
            assert!((out.b[i] - src.b[i]).abs() < 1e-9, "B at {i}");
        }
        assert!(out.validity.all_valid());
    }

    #[test]
    fn gain_is_folded_into_the_warp() {
        let cam = Camera::new([0.0; 3], 100.0, 0.0, 0.0, 32, 24);
        let src = planar_from_fn(32, 24, |_, _| [0.25, 0.5, 0.125]);
        let out = warp_to_canvas(&src, &cam, &aligned_canvas(&cam), [2.0, 0.5, 4.0]);
        for i in 0..out.pixel_count() {
            assert_eq!(out.r[i], 0.5);
            assert_eq!(out.g[i], 0.25);
            assert_eq!(out.b[i], 0.5);
        }
    }

    /// Catmull-Rom reproduces linear ramps exactly (within f32) at
    /// fractional sample positions — pins the half-pixel convention.
    #[test]
    fn bicubic_reproduces_linear_ramp_at_fractional_offsets() {
        let src = planar_from_fn(32, 8, |x, _| [x as f32, 0.0, 0.0]);
        for &(sx, sy) in &[(5.75, 3.5), (8.5, 2.25), (12.301, 4.71), (2.5, 1.5)] {
            let s = sample_bicubic(&src, sx, sy).expect("interior sample");
            // Texel x stores value x; centers at x + 0.5 → value(sx) = sx − 0.5.
            assert!(
                (s[0] as f64 - (sx - 0.5)).abs() < 1e-5,
                "ramp at ({sx}, {sy}): got {}",
                s[0]
            );
        }
    }

    /// A constant source with an invalid hole stays exactly constant at
    /// every valid output pixel — the validity-weighted renormalization
    /// cannot leak the hole's (zeroed) content. The hole itself stays
    /// invalid.
    #[test]
    fn invalid_hole_does_not_smear_into_neighbors() {
        let w = 48;
        let h = 36;
        let mut src = planar_from_fn(w, h, |_, _| [0.625, 0.625, 0.625]);
        for y in 14..20 {
            for x in 20..26 {
                src.validity.set(x, y, false);
                let i = (y * w + x) as usize;
                src.r[i] = 0.0; // poison the hole so any leak is visible
                src.g[i] = 0.0;
                src.b[i] = 0.0;
            }
        }
        // Quarter-pixel-offset canvas forces real 4×4 interpolation.
        let cam = Camera::new([0.0; 3], 150.0, 0.0, 0.0, w, h);
        let f = cam.focal_px;
        let canvas = CanvasSpec::with_window(
            Projection::Rectilinear,
            w,
            h,
            -(w as f64 * 0.5 - 0.25) / f,
            -(h as f64 * 0.5 - 0.25) / f,
            1.0 / f,
            1.0 / f,
            cam.rotation,
            false,
        )
        .unwrap();
        let out = warp_to_canvas(&src, &cam, &canvas, [1.0; 3]);
        let mut checked_valid = 0;
        let mut hole_interior_invalid = 0;
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) as usize;
                if out.validity.get(x, y) {
                    assert!(
                        (out.r[i] - 0.625).abs() < 1e-6,
                        "smear at ({x}, {y}): {}",
                        out.r[i]
                    );
                    checked_valid += 1;
                } else if (21..25).contains(&x) && (15..19).contains(&y) {
                    hole_interior_invalid += 1;
                }
            }
        }
        assert!(checked_valid > (w * h / 2) as usize, "warp mostly valid");
        assert!(hole_interior_invalid > 0, "hole interior must stay invalid");
    }

    /// Narrow camera on a full-sphere canvas: validity covers exactly
    /// the camera footprint (checked against the camera's own mapping).
    #[test]
    fn footprint_validity_matches_camera_mapping() {
        let cam = Camera::new([0.1, 0.9, 0.0], 80.0, -0.03, 0.01, 64, 48);
        let src = planar_from_fn(64, 48, |_, _| [0.5; 3]);
        let canvas = CanvasSpec::full_sphere(96).unwrap();
        let out = warp_to_canvas(&src, &cam, &canvas, [1.0; 3]);
        let mut mismatches = 0;
        for y in 0..canvas.height {
            for x in 0..canvas.width {
                let dir = canvas
                    .pixel_to_dir(x as f64 + 0.5, y as f64 + 0.5)
                    .expect("sphere total");
                let inside = cam
                    .world_dir_to_pixel(dir)
                    .is_some_and(|(px, py)| px >= 0.0 && px <= 64.0 && py >= 0.0 && py <= 48.0);
                if inside != out.validity.get(x, y) {
                    mismatches += 1;
                }
            }
        }
        // The mapping is exact; allow zero mismatches.
        assert_eq!(mismatches, 0, "footprint mismatch count");
        assert!(out.validity.count_valid() > 0);
    }

    /// A frame straddling the ±180° meridian on a full-wrap canvas
    /// writes to both canvas edges and nothing near the center.
    #[test]
    fn wrap_straddling_frame_covers_both_canvas_edges() {
        let cam = Camera::new([0.0, std::f64::consts::PI, 0.0], 80.0, 0.0, 0.0, 64, 48);
        let src = planar_from_fn(64, 48, |_, _| [1.0; 3]);
        let canvas = CanvasSpec::full_sphere(64).unwrap();
        let bbox = frame_canvas_bbox(&cam, &canvas, 4.0).expect("on canvas");
        assert_eq!(bbox.x_spans.len(), 2, "bbox must split across the wrap");
        let out = warp_to_canvas(&src, &cam, &canvas, [1.0; 3]);
        let h2 = canvas.height / 2;
        assert!(out.validity.get(0, h2), "left edge covered");
        assert!(out.validity.get(canvas.width - 1, h2), "right edge covered");
        assert!(
            !out.validity.get(canvas.width / 2, h2),
            "canvas center (yaw 0) must be empty for a yaw-180 frame"
        );
    }

    /// Frame entirely behind a rectilinear canvas → empty output, and
    /// `frame_canvas_bbox` reports it as off-canvas.
    #[test]
    fn frame_behind_rect_canvas_is_fully_invalid() {
        let cam = Camera::new([0.0, std::f64::consts::PI, 0.0], 100.0, 0.0, 0.0, 32, 24);
        let forward = Camera::new([0.0; 3], 100.0, 0.0, 0.0, 32, 24);
        let canvas = aligned_canvas(&forward);
        assert_eq!(frame_canvas_bbox(&cam, &canvas, 4.0), None);
        let src = planar_from_fn(32, 24, |_, _| [1.0; 3]);
        let out = warp_to_canvas(&src, &cam, &canvas, [1.0; 3]);
        assert_eq!(out.validity.count_valid(), 0);
    }

    /// Determinism: two runs produce byte-identical planes and masks.
    #[test]
    fn warp_is_deterministic() {
        let cam = Camera::new([0.05, 0.4, -0.02], 90.0, -0.05, 0.012, 80, 60);
        let src = planar_from_fn(80, 60, |x, y| {
            [
                ((x * 7 + y * 3) % 13) as f32 / 13.0,
                ((x * 5 + y * 11) % 7) as f32 / 7.0,
                ((x + y) % 3) as f32 / 3.0,
            ]
        });
        let canvas = CanvasSpec::full_sphere(80).unwrap();
        let a = warp_to_canvas(&src, &cam, &canvas, [1.1, 0.9, 1.0]);
        let b = warp_to_canvas(&src, &cam, &canvas, [1.1, 0.9, 1.0]);
        assert_eq!(a.r, b.r);
        assert_eq!(a.g, b.g);
        assert_eq!(a.b, b.b);
        assert_eq!(a.validity, b.validity);
    }

    /// Pole-containing frame gets the full x span (it covers every
    /// longitude on a spherical canvas).
    #[test]
    fn pole_frame_gets_full_x_span() {
        // Pitch the camera straight up (+90° about +X looks at −Y).
        let cam = Camera::new(
            [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
            60.0,
            0.0,
            0.0,
            64,
            48,
        );
        let canvas = CanvasSpec::full_sphere(64).unwrap();
        let bbox = frame_canvas_bbox(&cam, &canvas, 0.0).expect("on canvas");
        assert_eq!(bbox.x_spans, vec![(0, canvas.width)]);
        assert_eq!(bbox.y0, 0, "zenith frame reaches the top row");
    }

    #[test]
    fn rotation_accessor_used_by_tests_matches_identity() {
        // Guard: aligned_canvas relies on Mat3::identity for the
        // unrotated case staying exact.
        let i = Mat3::identity();
        assert_eq!(
            i.mul_vec(Vec3::new(0.3, -0.2, 0.9)),
            Vec3::new(0.3, -0.2, 0.9)
        );
    }
}
