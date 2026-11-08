//! Canvas overlays drawn by the shared overlay surface (#5715): a
//! fixed-capacity list of coverage primitives in overlay-surface pixels, the
//! crop tool's overlay built from [`super::crop`]'s geometry, and the CPU
//! rasterizer the fallback path uses.
//!
//! The overlay surface is upright, the viewport grown by
//! [`CROP_OVERLAY_OVERSCAN`] on every side, and composited by the platform
//! above the (possibly straighten-rotated) image, so every primitive is
//! axis-aligned in view space. Pixels are premultiplied RGBA at
//! SDR reference white: white is `1.0`, never boosted into EDR headroom.
//!
//! [`overlay_pixel`] is the per-pixel reference. `raw-gpu`'s `overlay.wgsl`
//! evaluates the same expression in the same order, and the parity test in
//! `raw-gpu` holds the two within one 8-bit step. [`rasterize_overlay`]
//! produces exactly [`overlay_pixel`]'s bytes, filling constant-coverage
//! runs once instead of re-evaluating every primitive at every pixel.

use super::crop::{crop_rect_in_view, fit_footprint, CropEdges, CropHandle};
use super::geometry::{Point, Rect, Size};

/// Most primitives one overlay can carry; the GPU uniform array has the same
/// length.
pub const OVERLAY_CAPACITY: usize = 16;

pub const OVERLAY_KIND_NONE: u32 = 0;
/// Fill `rect`.
pub const OVERLAY_KIND_FILL: u32 = 1;
/// Fill `clip` minus `rect`; `rect` must lie inside `clip`.
pub const OVERLAY_KIND_FILL_OUTSIDE: u32 = 2;
/// Fill the disc centred at `rect.xy` with radius `rect.z`.
pub const OVERLAY_KIND_DISC: u32 = 3;

/// One primitive. `rect` and `clip` are `[x0, y0, x1, y1]` in overlay-surface
/// pixels (top-left origin), `color` is premultiplied RGBA. The layout matches
/// the GPU uniform element (four 16-byte rows).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OverlayPrimitive {
    pub rect: [f32; 4],
    pub clip: [f32; 4],
    pub color: [f32; 4],
    pub kind: u32,
    pub reserved: [u32; 3],
}

/// Primitives composited in order, later ones over earlier ones.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CanvasOverlay {
    pub primitives: [OverlayPrimitive; OVERLAY_CAPACITY],
    pub count: usize,
}

impl CanvasOverlay {
    pub const EMPTY: Self = Self {
        primitives: [OverlayPrimitive {
            rect: [0.0; 4],
            clip: [0.0; 4],
            color: [0.0; 4],
            kind: OVERLAY_KIND_NONE,
            reserved: [0; 3],
        }; OVERLAY_CAPACITY],
        count: 0,
    };

    /// The primitives in drawing order.
    #[must_use]
    pub fn active(&self) -> &[OverlayPrimitive] {
        &self.primitives[..self.count.min(OVERLAY_CAPACITY)]
    }

    /// `self` with `primitive` appended; a full overlay drops it.
    #[must_use]
    fn with(mut self, primitive: OverlayPrimitive) -> Self {
        if self.count < OVERLAY_CAPACITY {
            self.primitives[self.count] = primitive;
            self.count += 1;
        }
        self
    }
}

impl Default for CanvasOverlay {
    fn default() -> Self {
        Self::EMPTY
    }
}

/// Everything the crop overlay depends on. `viewport` is in points;
/// `pixel_scale` is overlay-surface pixels per point; `active` is the handle
/// being dragged, if any.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CropOverlayInput {
    pub crop: CropEdges,
    pub viewport: Size,
    pub image: Size,
    pub pixel_scale: f64,
    pub active: Option<CropHandle>,
}

/// Mask outside the crop, over photo content only.
pub const CROP_MASK_ALPHA: f32 = 0.55;
pub const CROP_FRAME_ALPHA: f32 = 0.9;
pub const CROP_FRAME_WIDTH: f64 = 1.0;
/// The frame edges a dragged handle moves are drawn at this width, opaque.
pub const CROP_ACTIVE_FRAME_WIDTH: f64 = 2.0;
pub const CROP_GRID_ALPHA: f32 = 0.35;
pub const CROP_GRID_WIDTH: f64 = 0.5;
pub const CROP_CORNER_DOT_DIAMETER: f64 = 12.0;
/// Points the crop overlay surface extends past the viewport on every side,
/// so a corner dot or frame stroke centred on a viewport edge (a full-frame
/// fit) is drawn whole: the dot radius plus its antialiased fringe.
pub const CROP_OVERLAY_OVERSCAN: f64 = CROP_CORNER_DOT_DIAMETER / 2.0 + 1.0;

/// The crop tool's overlay: the dimmed photo outside the crop, the frame
/// (dragged edges emphasised), the rule-of-thirds grid and the corner dots.
/// Coordinates are surface pixels, whose origin sits [`CROP_OVERLAY_OVERSCAN`]
/// points above and left of the viewport's. A non-finite or non-positive
/// `pixel_scale` reads as `1`.
#[must_use]
pub fn crop_overlay(input: CropOverlayInput) -> CanvasOverlay {
    let scale = if input.pixel_scale.is_finite() && input.pixel_scale > 0.0 {
        input.pixel_scale
    } else {
        1.0
    };
    let fitted = fit_footprint(input.viewport, input.image);
    let footprint_points = Rect::new(
        fitted.x + CROP_OVERLAY_OVERSCAN,
        fitted.y + CROP_OVERLAY_OVERSCAN,
        fitted.width,
        fitted.height,
    );
    let footprint = scaled(footprint_points, scale);
    let crop = scaled(crop_rect_in_view(input.crop, footprint_points), scale);
    let edge_width = |moved: bool| {
        if moved {
            (CROP_ACTIVE_FRAME_WIDTH * scale, 1.0)
        } else {
            (CROP_FRAME_WIDTH * scale, CROP_FRAME_ALPHA)
        }
    };
    let active = input.active;
    let moved = |test: fn(CropHandle) -> bool| active.is_some_and(test);
    let (top_w, top_a) = edge_width(moved(CropHandle::moves_top));
    let (bottom_w, bottom_a) = edge_width(moved(CropHandle::moves_bottom));
    let (left_w, left_a) = edge_width(moved(CropHandle::moves_left));
    let (right_w, right_a) = edge_width(moved(CropHandle::moves_right));
    let (x0, y0, x1, y1) = (crop.x, crop.y, crop.max_x(), crop.max_y());
    let grid_half = CROP_GRID_WIDTH * scale / 2.0;
    let thirds_x = [x0 + crop.width / 3.0, x0 + 2.0 * crop.width / 3.0];
    let thirds_y = [y0 + crop.height / 3.0, y0 + 2.0 * crop.height / 3.0];
    let dot_radius = CROP_CORNER_DOT_DIAMETER * scale / 2.0;

    let overlay = CanvasOverlay::EMPTY
        .with(OverlayPrimitive {
            rect: corners(x0, y0, x1, y1),
            clip: corners(
                footprint.x,
                footprint.y,
                footprint.max_x(),
                footprint.max_y(),
            ),
            color: black(CROP_MASK_ALPHA),
            kind: OVERLAY_KIND_FILL_OUTSIDE,
            reserved: [0; 3],
        })
        .with(fill(
            corners(
                x0 - top_w / 2.0,
                y0 - top_w / 2.0,
                x1 + top_w / 2.0,
                y0 + top_w / 2.0,
            ),
            white(top_a),
        ))
        .with(fill(
            corners(
                x0 - bottom_w / 2.0,
                y1 - bottom_w / 2.0,
                x1 + bottom_w / 2.0,
                y1 + bottom_w / 2.0,
            ),
            white(bottom_a),
        ))
        .with(fill(
            corners(
                x0 - left_w / 2.0,
                y0 + top_w / 2.0,
                x0 + left_w / 2.0,
                y1 - bottom_w / 2.0,
            ),
            white(left_a),
        ))
        .with(fill(
            corners(
                x1 - right_w / 2.0,
                y0 + top_w / 2.0,
                x1 + right_w / 2.0,
                y1 - bottom_w / 2.0,
            ),
            white(right_a),
        ));
    let gridded = thirds_x
        .into_iter()
        .map(|x| corners(x - grid_half, y0, x + grid_half, y1))
        .chain(
            thirds_y
                .into_iter()
                .map(|y| corners(x0, y - grid_half, x1, y + grid_half)),
        )
        .fold(overlay, |acc, rect| {
            acc.with(fill(rect, white(CROP_GRID_ALPHA)))
        });
    [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
        .into_iter()
        .fold(gridded, |acc, (x, y)| {
            acc.with(OverlayPrimitive {
                rect: [x as f32, y as f32, dot_radius as f32, 0.0],
                clip: [0.0; 4],
                color: white(1.0),
                kind: OVERLAY_KIND_DISC,
                reserved: [0; 3],
            })
        })
}

/// The handles that get an accessible element, with their centre in viewport
/// points: four corners, then the four edge midpoints.
#[must_use]
pub fn crop_handle_centers(input: CropOverlayInput) -> [(CropHandle, Point); 8] {
    let rect = crop_rect_in_view(input.crop, fit_footprint(input.viewport, input.image));
    let (x0, y0, x1, y1) = (rect.x, rect.y, rect.max_x(), rect.max_y());
    let (mx, my) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    [
        (CropHandle::TopLeft, Point::new(x0, y0)),
        (CropHandle::TopRight, Point::new(x1, y0)),
        (CropHandle::BottomLeft, Point::new(x0, y1)),
        (CropHandle::BottomRight, Point::new(x1, y1)),
        (CropHandle::Top, Point::new(mx, y0)),
        (CropHandle::Bottom, Point::new(mx, y1)),
        (CropHandle::Left, Point::new(x0, my)),
        (CropHandle::Right, Point::new(x1, my)),
    ]
}

fn scaled(rect: Rect, scale: f64) -> Rect {
    Rect::new(
        rect.x * scale,
        rect.y * scale,
        rect.width * scale,
        rect.height * scale,
    )
}

fn corners(x0: f64, y0: f64, x1: f64, y1: f64) -> [f32; 4] {
    [x0 as f32, y0 as f32, x1 as f32, y1 as f32]
}

fn fill(rect: [f32; 4], color: [f32; 4]) -> OverlayPrimitive {
    OverlayPrimitive {
        rect,
        clip: [0.0; 4],
        color,
        kind: OVERLAY_KIND_FILL,
        reserved: [0; 3],
    }
}

fn white(alpha: f32) -> [f32; 4] {
    [alpha, alpha, alpha, alpha]
}

fn black(alpha: f32) -> [f32; 4] {
    [0.0, 0.0, 0.0, alpha]
}

/// Area of the pixel span `[p, p + 1]` inside `[lo, hi]`.
fn axis_coverage(p: f32, lo: f32, hi: f32) -> f32 {
    ((p + 1.0).min(hi) - p.max(lo)).clamp(0.0, 1.0)
}

fn rect_coverage(px: f32, py: f32, rect: [f32; 4]) -> f32 {
    axis_coverage(px, rect[0], rect[2]) * axis_coverage(py, rect[1], rect[3])
}

/// How much of pixel `(px, py)` `primitive` covers, in `[0, 1]`.
fn coverage(primitive: &OverlayPrimitive, px: f32, py: f32) -> f32 {
    match primitive.kind {
        OVERLAY_KIND_FILL => rect_coverage(px, py, primitive.rect),
        OVERLAY_KIND_FILL_OUTSIDE => {
            (rect_coverage(px, py, primitive.clip) - rect_coverage(px, py, primitive.rect)).max(0.0)
        }
        OVERLAY_KIND_DISC => {
            let dx = px + 0.5 - primitive.rect[0];
            let dy = py + 0.5 - primitive.rect[1];
            (primitive.rect[2] - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0)
        }
        _ => 0.0,
    }
}

/// Premultiplied RGBA of pixel `(x, y)`: every primitive's colour scaled by
/// its coverage, composited source-over in order onto transparent.
#[must_use]
pub fn overlay_pixel(overlay: &CanvasOverlay, x: u32, y: u32) -> [f32; 4] {
    let (px, py) = (x as f32, y as f32);
    overlay
        .active()
        .iter()
        .fold([0.0_f32; 4], |acc, primitive| {
            let c = coverage(primitive, px, py);
            let src = primitive.color.map(|channel| channel * c);
            let keep = 1.0 - src[3];
            [
                src[0] + acc[0] * keep,
                src[1] + acc[1] * keep,
                src[2] + acc[2] * keep,
                src[3] + acc[3] * keep,
            ]
        })
}

/// One unorm channel as the GPU stores it: round to nearest.
#[must_use]
pub fn unorm8(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// Why [`rasterize_overlay`] refused to write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RasterizeError {
    /// `stride` is narrower than `width * 4` bytes.
    StrideTooSmall,
    /// `out` holds fewer than `stride * height` bytes.
    BufferTooSmall,
}

/// Write `overlay` into `out` as premultiplied RGBA8, `stride` bytes per row,
/// every byte equal to [`overlay_pixel`] through [`unorm8`]. Allocates
/// nothing: each row is split at the pixels where some primitive's coverage
/// can change, and a run whose coverage is constant is evaluated once.
pub fn rasterize_overlay(
    overlay: &CanvasOverlay,
    width: u32,
    height: u32,
    stride: usize,
    out: &mut [u8],
) -> Result<(), RasterizeError> {
    let row_bytes = width as usize * 4;
    if stride < row_bytes {
        return Err(RasterizeError::StrideTooSmall);
    }
    if out.len() < stride * height as usize {
        return Err(RasterizeError::BufferTooSmall);
    }
    for y in 0..height {
        let row = &mut out[y as usize * stride..y as usize * stride + row_bytes];
        rasterize_row(overlay, width, y, row);
    }
    Ok(())
}

/// Each primitive contributes up to eight x positions where its coverage can
/// change, plus the row's two ends.
const MAX_BREAKS: usize = OVERLAY_CAPACITY * 8 + 2;

fn rasterize_row(overlay: &CanvasOverlay, width: u32, y: u32, row: &mut [u8]) {
    let mut breaks = [0_u32; MAX_BREAKS];
    let mut count = 0;
    let mut push = |x: f32| {
        if count < MAX_BREAKS {
            breaks[count] = clamp_column(x, width);
            count += 1;
        }
    };
    push(0.0);
    push(width as f32);
    let mut varies_per_pixel = [false; OVERLAY_CAPACITY];
    for (index, primitive) in overlay.active().iter().enumerate() {
        match primitive.kind {
            OVERLAY_KIND_FILL => rect_breaks(primitive.rect, &mut push),
            OVERLAY_KIND_FILL_OUTSIDE => {
                rect_breaks(primitive.rect, &mut push);
                rect_breaks(primitive.clip, &mut push);
            }
            OVERLAY_KIND_DISC => {
                let [cx, cy, radius, _] = primitive.rect;
                let reach = radius + 1.0;
                if (y as f32 + 0.5 - cy).abs() <= reach {
                    varies_per_pixel[index] = true;
                    push((cx - reach).floor());
                    push((cx + reach).floor() + 1.0);
                }
            }
            _ => {}
        }
    }
    let breaks = &mut breaks[..count];
    breaks.sort_unstable();
    for pair in breaks.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        if start == end {
            continue;
        }
        let per_pixel = overlay
            .active()
            .iter()
            .zip(varies_per_pixel)
            .any(|(primitive, varies)| varies && disc_reaches(primitive, start, end));
        let run = &mut row[start as usize * 4..end as usize * 4];
        if per_pixel {
            run.chunks_exact_mut(4)
                .zip(start..end)
                .for_each(|(pixel, x)| {
                    pixel.copy_from_slice(&overlay_pixel(overlay, x, y).map(unorm8))
                });
        } else {
            let bytes = overlay_pixel(overlay, start, y).map(unorm8);
            run.chunks_exact_mut(4)
                .for_each(|pixel| pixel.copy_from_slice(&bytes));
        }
    }
}

fn rect_breaks(rect: [f32; 4], push: &mut impl FnMut(f32)) {
    let (x0, x1) = (rect[0].floor(), rect[2].floor());
    push(x0);
    push(x0 + 1.0);
    push(x1);
    push(x1 + 1.0);
}

fn disc_reaches(primitive: &OverlayPrimitive, start: u32, end: u32) -> bool {
    let [cx, _, radius, _] = primitive.rect;
    let reach = radius + 1.0;
    (start as f32) < cx + reach && (end as f32) > cx - reach
}

fn clamp_column(x: f32, width: u32) -> u32 {
    if x.is_nan() || x <= 0.0 {
        0
    } else if x >= width as f32 {
        width
    } else {
        x as u32
    }
}

#[cfg(test)]
#[path = "overlay_tests.rs"]
mod tests;
