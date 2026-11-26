//! Canvas-strip warps for the memory-bounded composite (M6-D #1248, #5554).
//!
//! [`warp_window_to_canvas_strip`] works out exactly which source rows a
//! strip's bicubic taps touch, reads only those, and warps from that window
//! through the same per-pixel chain as [`warp_to_canvas_strip`], so its output
//! is bit-identical to warping the whole frame. [`warp_rect_to_canvas`]
//! does the same for a rectangle of canvas columns and rows, reading only
//! the source rectangle its taps touch (#6057).

use std::ops::Range;

use rayon::prelude::*;

use super::{frame_output_bbox, sample_bicubic, CanvasBBox};
use crate::camera::Camera;
use crate::canvas::CanvasSpec;
use crate::frame_store::FrameRect;
use crate::gain::FramePhotometry;
use crate::ingest::{PlanarImage, ValidityMask};
use crate::local_align::{LocalCorrection, MAX_CORRECTION_PX};

/// The pixels `x0..x0 + image.width()` × `y0..y0 + image.height()` of a
/// source frame `full_width × full_height`. Sampling keeps full-frame
/// coordinates; only the storage is windowed.
#[derive(Clone, Copy)]
pub struct SourceRows<'a> {
    image: &'a PlanarImage,
    x0: u32,
    y0: u32,
    full_width: u32,
    full_height: u32,
}

impl<'a> SourceRows<'a> {
    pub fn full(image: &'a PlanarImage) -> Self {
        Self {
            image,
            x0: 0,
            y0: 0,
            full_width: image.width(),
            full_height: image.height(),
        }
    }

    pub fn window(image: &'a PlanarImage, y0: u32, full_height: u32) -> Self {
        Self::rect(image, 0, y0, image.width(), full_height)
    }

    pub fn rect(
        image: &'a PlanarImage,
        x0: u32,
        y0: u32,
        full_width: u32,
        full_height: u32,
    ) -> Self {
        assert!(
            x0 + image.width() <= full_width && y0 + image.height() <= full_height,
            "window {x0}..{} x {y0}..{} exceeds the frame's {full_width}x{full_height}",
            x0 + image.width(),
            y0 + image.height()
        );
        Self {
            image,
            x0,
            y0,
            full_width,
            full_height,
        }
    }

    pub(super) fn image(&self) -> &'a PlanarImage {
        self.image
    }

    pub(super) fn x0(&self) -> u32 {
        self.x0
    }

    pub(super) fn y0(&self) -> u32 {
        self.y0
    }

    pub(super) fn full_width(&self) -> u32 {
        self.full_width
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
            &OutputCols::whole(canvas, &plan),
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
    let cols = OutputCols::whole(canvas, &plan);
    let Some(taps) = tap_rect(cam, canvas, local_align, &plan, &cols.spans) else {
        return Ok(empty_strip(canvas, tile_y0, tile_y1));
    };
    let (lo, hi) = (taps.y0, taps.y0 + taps.height);
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
        &cols,
    ))
}

/// One frame warped into the canvas rectangle `cols` × `rows`: a
/// `cols.len() × rows.len()` image whose pixel `(0, 0)` is canvas pixel
/// `(cols.start, rows.start)`, bit-identical to the same pixels of
/// [`warp_to_canvas_strip`]. `read_rect` is asked for exactly the source
/// rectangle those pixels' bicubic taps touch; it is not called, and the
/// result is `None`, when the frame puts no sample in the rectangle.
#[allow(clippy::too_many_arguments)]
pub fn warp_rect_to_canvas<E>(
    cam: &Camera,
    canvas: &CanvasSpec,
    photometry: FramePhotometry,
    local_align: Option<&LocalCorrection>,
    rows: Range<u32>,
    cols: Range<u32>,
    read_rect: impl FnOnce(FrameRect) -> Result<PlanarImage, E>,
) -> Result<Option<PlanarImage>, E> {
    assert!(
        cols.start < cols.end && cols.end <= canvas.width,
        "tile x range [{}, {}) must be within [0, {})",
        cols.start,
        cols.end,
        canvas.width
    );
    let Some(plan) = plan_strip(cam, canvas, local_align, rows.start, rows.end) else {
        return Ok(None);
    };
    let out = OutputCols::clipped(&plan, cols);
    if out.spans.is_empty() {
        return Ok(None);
    }
    let Some(taps) = tap_rect(cam, canvas, local_align, &plan, &out.spans) else {
        return Ok(None);
    };
    let window = read_rect(taps)?;
    assert_eq!(
        (window.width(), window.height()),
        (taps.width, taps.height),
        "read_rect returned the wrong window"
    );
    Ok(Some(warp_planned(
        SourceRows::rect(&window, taps.x0, taps.y0, cam.width, cam.height),
        cam,
        canvas,
        photometry,
        local_align,
        rows.start,
        rows.end,
        &plan,
        &out,
    )))
}

/// The output columns a warp writes: canvas columns `x0..x0 + width`, of
/// which the frame's footprint covers `spans`.
struct OutputCols {
    x0: u32,
    width: u32,
    spans: Vec<(u32, u32)>,
}

impl OutputCols {
    fn whole(canvas: &CanvasSpec, plan: &StripPlan) -> Self {
        Self {
            x0: 0,
            width: canvas.width,
            spans: plan.bbox.x_spans.clone(),
        }
    }

    fn clipped(plan: &StripPlan, cols: Range<u32>) -> Self {
        let spans = plan
            .bbox
            .x_spans
            .iter()
            .map(|&(a, b)| (a.max(cols.start), b.min(cols.end)))
            .filter(|(a, b)| a < b)
            .collect();
        Self {
            x0: cols.start,
            width: cols.end - cols.start,
            spans,
        }
    }
}

/// The source rectangle every bicubic tap of the plan's pixels in `x_spans`
/// reads (the rows `floor(fy - 0.5) - 1 ..= floor(fy - 0.5) + 2` that
/// exist, and likewise for columns).
fn tap_rect(
    cam: &Camera,
    canvas: &CanvasSpec,
    local_align: Option<&LocalCorrection>,
    plan: &StripPlan,
    x_spans: &[(u32, u32)],
) -> Option<FrameRect> {
    let src = (cam.width as f64, cam.height as f64);
    let (last_col, last_row) = (cam.width as i64 - 1, cam.height as i64 - 1);
    let taps = |f: f64, last: i64| {
        let i = (f - 0.5).floor() as i64;
        ((i - 1).max(0), (i + 2).min(last))
    };
    let union = |a: [i64; 4], b: [i64; 4]| {
        [
            a[0].min(b[0]),
            a[1].max(b[1]),
            a[2].min(b[2]),
            a[3].max(b[3]),
        ]
    };
    (plan.row_lo..plan.row_hi)
        .into_par_iter()
        .filter_map(|canvas_y| {
            let mut range: Option<[i64; 4]> = None;
            for_each_sample(
                cam,
                canvas,
                local_align,
                x_spans,
                canvas_y,
                src,
                |_, fx, fy| {
                    let (xl, xh) = taps(fx, last_col);
                    let (yl, yh) = taps(fy, last_row);
                    let tap = [xl, xh, yl, yh];
                    range = Some(range.map_or(tap, |r| union(r, tap)));
                },
            );
            range
        })
        .reduce_with(union)
        .filter(|r| r[0] <= r[1] && r[2] <= r[3])
        .map(|r| FrameRect {
            x0: r[0] as u32,
            y0: r[2] as u32,
            width: (r[1] - r[0] + 1) as u32,
            height: (r[3] - r[2] + 1) as u32,
        })
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
    cols: &OutputCols,
) -> PlanarImage {
    let ow = cols.width as usize;
    let ox = cols.x0 as usize;
    let th = (tile_y1 - tile_y0) as usize;
    let n = ow * th;
    let mut r = vec![0.0_f32; n];
    let mut g = vec![0.0_f32; n];
    let mut b = vec![0.0_f32; n];
    let mut valid = vec![false; n];

    let src_w = cam.width as f64;
    let src_h = src.full_height() as f64;
    let strip_lo = plan.row_lo - tile_y0 as usize;
    let strip_hi = plan.row_hi - tile_y0 as usize;

    r[strip_lo * ow..strip_hi * ow]
        .par_chunks_mut(ow)
        .zip(g[strip_lo * ow..strip_hi * ow].par_chunks_mut(ow))
        .zip(b[strip_lo * ow..strip_hi * ow].par_chunks_mut(ow))
        .zip(valid[strip_lo * ow..strip_hi * ow].par_chunks_mut(ow))
        .enumerate()
        .for_each(|(dy, (((row_r, row_g), row_b), row_v))| {
            for_each_sample(
                cam,
                canvas,
                local_align,
                &cols.spans,
                plan.row_lo + dy,
                (src_w, src_h),
                |x, fx, fy| {
                    let Some(s) = sample_bicubic(src, fx, fy) else {
                        return;
                    };
                    let [cr, cg, cb] = photometry.apply_at(s, fx, fy, src_w, src_h);
                    let x = x - ox;
                    row_r[x] = cr;
                    row_g[x] = cg;
                    row_b[x] = cb;
                    row_v[x] = true;
                },
            );
        });

    let mut mask = ValidityMask::new_filled(cols.width, tile_y1 - tile_y0, false);
    for sy in 0..th {
        let row = sy * ow;
        for x in 0..ow {
            if valid[row + x] {
                mask.set(x as u32, sy as u32, true);
            }
        }
    }
    PlanarImage::from_planes(cols.width, tile_y1 - tile_y0, r, g, b, mask)
}

#[cfg(test)]
#[path = "strip_tests.rs"]
mod tests;
