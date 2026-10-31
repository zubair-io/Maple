//! Canvas-strip warps for the memory-bounded composite (M6-D #1248, #5554).
//!
//! [`warp_window_to_canvas_strip`] works out exactly which source rows a
//! strip's bicubic taps touch, reads only those, and warps from that window
//! through the same per-pixel chain as [`warp_to_canvas_strip`], so its output
//! is bit-identical to warping the whole frame.

use rayon::prelude::*;

use super::{frame_output_bbox, sample_bicubic, CanvasBBox};
use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::gain::FramePhotometry;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::local_align::{LocalCorrection, MAX_CORRECTION_PX};

/// Rows `y0..y0 + image.height()` of a source frame `full_height` rows tall.
/// Sampling keeps full-frame coordinates; only the storage is windowed.
#[derive(Clone, Copy)]
pub struct SourceRows<'a> {
    image: &'a PlanarImage,
    y0: u32,
    full_height: u32,
}

impl<'a> SourceRows<'a> {
    pub fn full(image: &'a PlanarImage) -> Self {
        Self {
            image,
            y0: 0,
            full_height: image.height(),
        }
    }

    pub fn window(image: &'a PlanarImage, y0: u32, full_height: u32) -> Self {
        assert!(
            y0 + image.height() <= full_height,
            "window rows {y0}..{} exceed the frame's {full_height}",
            y0 + image.height()
        );
        Self {
            image,
            y0,
            full_height,
        }
    }

    pub(super) fn image(&self) -> &'a PlanarImage {
        self.image
    }

    pub(super) fn y0(&self) -> u32 {
        self.y0
    }

    pub(super) fn full_height(&self) -> u32 {
        self.full_height
    }
}

/// The output rows of a strip a frame's footprint covers, and that footprint.
struct StripPlan {
    bbox: CanvasBBox,
    row_lo: usize,
    row_hi: usize,
}

fn plan_strip(
    cam: &Camera,
    canvas: &CanvasSpec,
    local_align: Option<&LocalCorrection>,
    tile_y0: u32,
    tile_y1: u32,
) -> Option<StripPlan> {
    assert!(
        tile_y0 < tile_y1 && tile_y1 <= canvas.height,
        "tile y range [{tile_y0}, {tile_y1}) must be within [0, {})",
        canvas.height
    );
    let bbox_margin = if local_align.is_some() {
        4.0 + MAX_CORRECTION_PX
    } else {
        4.0
    };
    let bbox = frame_output_bbox(cam, canvas, bbox_margin)?;
    let row_lo = (bbox.y0 as usize).max(tile_y0 as usize);
    let row_hi = (bbox.y1 as usize).min(tile_y1 as usize);
    (row_lo < row_hi).then_some(StripPlan {
        bbox,
        row_lo,
        row_hi,
    })
}

/// Every pixel of canvas row `canvas_y` that maps onto the source frame,
/// with its source position.
#[allow(clippy::too_many_arguments)]
fn for_each_sample(
    cam: &Camera,
    canvas: &CanvasSpec,
    local_align: Option<&LocalCorrection>,
    x_spans: &[(u32, u32)],
    canvas_y: usize,
    (src_w, src_h): (f64, f64),
    mut visit: impl FnMut(usize, f64, f64),
) {
    let py = canvas_y as f64 + 0.5;
    for &(sx0, sx1) in x_spans {
        for x in sx0 as usize..sx1 as usize {
            let px = x as f64 + 0.5;
            let Some(dir) = canvas.output_pixel_to_dir(px, py) else {
                continue;
            };
            let Some((mut fx, mut fy)) = cam.world_dir_to_pixel(dir) else {
                continue;
            };
            if let Some(la) = local_align {
                (fx, fy) = la.sample_point(fx, fy);
            }
            if fx < 0.0 || fx > src_w || fy < 0.0 || fy > src_h {
                continue;
            }
            visit(x, fx, fy);
        }
    }
}

fn empty_strip(canvas: &CanvasSpec, tile_y0: u32, tile_y1: u32) -> PlanarImage {
    let n = canvas.width as usize * (tile_y1 - tile_y0) as usize;
    PlanarImage::from_planes(
        canvas.width,
        tile_y1 - tile_y0,
        vec![0.0; n],
        vec![0.0; n],
        vec![0.0; n],
        ValidityMask::new_filled(canvas.width, tile_y1 - tile_y0, false),
    )
}

/// Warp one source frame into a horizontal canvas strip `[tile_y0, tile_y1)`.
///
/// The output is `canvas_width × (tile_y1 - tile_y0)` (M6-D, #1248). The semantics are identical to [`super::warp_to_canvas`] over the strip
/// rows; pixel coordinates are the same — row 0 of the returned image
/// corresponds to canvas row `tile_y0`.
///
/// `tile_y0` and `tile_y1` must satisfy `tile_y0 < tile_y1 <= canvas.height`.
pub fn warp_to_canvas_strip(
    src: &PlanarImage,
    cam: &Camera,
    canvas: &CanvasSpec,
    photometry: FramePhotometry,
    local_align: Option<&LocalCorrection>,
    tile_y0: u32,
    tile_y1: u32,
) -> PlanarImage {
    assert_eq!(
        (src.width(), src.height()),
        (cam.width, cam.height),
        "source frame and camera dimensions must agree"
    );
    match plan_strip(cam, canvas, local_align, tile_y0, tile_y1) {
        Some(plan) => warp_planned(
            SourceRows::full(src),
            cam,
            canvas,
            photometry,
            local_align,
            tile_y0,
            tile_y1,
            &plan,
        ),
        None => empty_strip(canvas, tile_y0, tile_y1),
    }
}

/// [`warp_to_canvas_strip`] reading only the source rows the strip's taps
/// touch: `read_rows(y0, rows)` returns rows `y0..y0 + rows` of the
/// `cam.width × cam.height` frame, and is not called when the strip needs
/// none.
#[allow(clippy::too_many_arguments)]
pub fn warp_window_to_canvas_strip<E>(
    cam: &Camera,
    canvas: &CanvasSpec,
    photometry: FramePhotometry,
    local_align: Option<&LocalCorrection>,
    tile_y0: u32,
    tile_y1: u32,
    read_rows: impl FnOnce(u32, u32) -> Result<PlanarImage, E>,
) -> Result<PlanarImage, E> {
    let Some(plan) = plan_strip(cam, canvas, local_align, tile_y0, tile_y1) else {
        return Ok(empty_strip(canvas, tile_y0, tile_y1));
    };
    let Some((lo, hi)) = tap_rows(cam, canvas, local_align, &plan) else {
        return Ok(empty_strip(canvas, tile_y0, tile_y1));
    };
    let window = read_rows(lo, hi - lo)?;
    assert_eq!(
        (window.width(), window.height()),
        (cam.width, hi - lo),
        "read_rows returned the wrong window"
    );
    Ok(warp_planned(
        SourceRows::window(&window, lo, cam.height),
        cam,
        canvas,
        photometry,
        local_align,
        tile_y0,
        tile_y1,
        &plan,
    ))
}

/// Half-open source row range every bicubic tap of the strip reads (the
/// rows `floor(fy - 0.5) - 1 ..= floor(fy - 0.5) + 2` that exist).
fn tap_rows(
    cam: &Camera,
    canvas: &CanvasSpec,
    local_align: Option<&LocalCorrection>,
    plan: &StripPlan,
) -> Option<(u32, u32)> {
    let src = (cam.width as f64, cam.height as f64);
    let last_row = cam.height as i64 - 1;
    (plan.row_lo..plan.row_hi)
        .into_par_iter()
        .filter_map(|canvas_y| {
            let mut range: Option<(i64, i64)> = None;
            for_each_sample(
                cam,
                canvas,
                local_align,
                &plan.bbox.x_spans,
                canvas_y,
                src,
                |_, _, fy| {
                    let y1 = (fy - 0.5).floor() as i64;
                    let (lo, hi) = ((y1 - 1).max(0), (y1 + 2).min(last_row));
                    range = Some(range.map_or((lo, hi), |(a, b)| (a.min(lo), b.max(hi))));
                },
            );
            range
        })
        .reduce_with(|(a, b), (c, d)| (a.min(c), b.max(d)))
        .filter(|(lo, hi)| lo <= hi)
        .map(|(lo, hi)| (lo as u32, hi as u32 + 1))
}

#[allow(clippy::too_many_arguments)]
fn warp_planned(
    src: SourceRows<'_>,
    cam: &Camera,
    canvas: &CanvasSpec,
    photometry: FramePhotometry,
    local_align: Option<&LocalCorrection>,
    tile_y0: u32,
    tile_y1: u32,
    plan: &StripPlan,
) -> PlanarImage {
    let cw = canvas.width as usize;
    let th = (tile_y1 - tile_y0) as usize;
    let n = cw * th;
    let mut r = vec![0.0_f32; n];
    let mut g = vec![0.0_f32; n];
    let mut b = vec![0.0_f32; n];
    let mut valid = vec![false; n];

    let src_w = cam.width as f64;
    let src_h = src.full_height() as f64;
    let strip_lo = plan.row_lo - tile_y0 as usize;
    let strip_hi = plan.row_hi - tile_y0 as usize;

    r[strip_lo * cw..strip_hi * cw]
        .par_chunks_mut(cw)
        .zip(g[strip_lo * cw..strip_hi * cw].par_chunks_mut(cw))
        .zip(b[strip_lo * cw..strip_hi * cw].par_chunks_mut(cw))
        .zip(valid[strip_lo * cw..strip_hi * cw].par_chunks_mut(cw))
        .enumerate()
        .for_each(|(dy, (((row_r, row_g), row_b), row_v))| {
            for_each_sample(
                cam,
                canvas,
                local_align,
                &plan.bbox.x_spans,
                plan.row_lo + dy,
                (src_w, src_h),
                |x, fx, fy| {
                    let Some(s) = sample_bicubic(src, fx, fy) else {
                        return;
                    };
                    let [cr, cg, cb] = photometry.apply_at(s, fx, fy, src_w, src_h);
                    row_r[x] = cr;
                    row_g[x] = cg;
                    row_b[x] = cb;
                    row_v[x] = true;
                },
            );
        });

    let mut mask = ValidityMask::new_filled(canvas.width, tile_y1 - tile_y0, false);
    for sy in 0..th {
        let row = sy * cw;
        for x in 0..cw {
            if valid[row + x] {
                mask.set(x as u32, sy as u32, true);
            }
        }
    }
    PlanarImage::from_planes(canvas.width, tile_y1 - tile_y0, r, g, b, mask)
}

#[cfg(test)]
#[path = "strip_tests.rs"]
mod tests;
