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
use crate::local_align::{LocalCorrection, MAX_CORRECTION_PX};
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
///
/// `local_align`: optional per-frame local-alignment correction (#1218,
/// spec §8).  When present it is applied to the rotation-warp's output
/// sample coordinate in a **single resample** — no extra pass.  The bbox
/// margin is widened by [`MAX_CORRECTION_PX`] to keep coverage correct.
pub fn warp_to_canvas(
    src: &PlanarImage,
    cam: &Camera,
    canvas: &CanvasSpec,
    gain: [f32; 3],
    local_align: Option<&LocalCorrection>,
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
    // sampling slack.  Widen by MAX_CORRECTION_PX when local alignment
    // is active so the corrected sample always lands in the bbox.
    let bbox_margin = if local_align.is_some() {
        4.0 + MAX_CORRECTION_PX
    } else {
        4.0
    };
    let bbox = frame_canvas_bbox(cam, canvas, bbox_margin);

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
                        let Some((mut fx, mut fy)) = cam.world_dir_to_pixel(dir) else {
                            continue;
                        };
                        // Stage F: apply per-frame local alignment correction
                        // in a SINGLE resample — no extra pass.
                        if let Some(la) = local_align {
                            (fx, fy) = la.apply(fx, fy);
                        }
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
mod tests;
