//! Interactive crop geometry: the fit footprint the crop tool draws over,
//! the mapping between it and the normalized crop rect, handle hit-testing,
//! handle resizes with an optional aspect lock, moves, and the centred rect
//! for an aspect preset (#638, ported from Apple's `CropGeometry` and the web
//! `crop-geometry.ts`).
//!
//! Coordinate spaces: a [`CropEdges`] is normalized to `[0, 1]` against the
//! display-oriented image, top-left origin (the XMP / pipeline convention).
//! The footprint and every view point are in viewport points; the crop tool
//! forces fit and zero pan, so the image always paints onto the footprint.
//! Straighten rotates the image under an axis-aligned crop rect with no
//! corner fill, so the angle rides along unchanged here.

use super::geometry::{Point, Rect, Size};

/// Smallest crop extent on each axis, as a fraction of that axis, so a drag
/// cannot collapse the rect.
pub const MIN_CROP_FRACTION: f64 = 0.05;

/// Crop edges normalized to the display-oriented image, plus the straighten
/// angle in degrees (positive = clockwise), which geometry never changes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CropEdges {
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub angle: f64,
}

impl CropEdges {
    /// The full frame at `angle`.
    #[must_use]
    pub const fn full_frame(angle: f64) -> Self {
        Self {
            top: 0.0,
            left: 0.0,
            bottom: 1.0,
            right: 1.0,
            angle,
        }
    }
}

impl Default for CropEdges {
    fn default() -> Self {
        Self::full_frame(0.0)
    }
}

/// A grab target on the crop rect: four corners, four edge midpoints, or the
/// interior.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CropHandle {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    Top,
    Bottom,
    Left,
    Right,
    Move,
}

impl CropHandle {
    pub(super) fn moves_left(self) -> bool {
        matches!(self, Self::TopLeft | Self::BottomLeft | Self::Left)
    }

    pub(super) fn moves_right(self) -> bool {
        matches!(self, Self::TopRight | Self::BottomRight | Self::Right)
    }

    pub(super) fn moves_top(self) -> bool {
        matches!(self, Self::TopLeft | Self::TopRight | Self::Top)
    }

    pub(super) fn moves_bottom(self) -> bool {
        matches!(self, Self::BottomLeft | Self::BottomRight | Self::Bottom)
    }
}

/// The image's on-screen rect at fit zoom, centred in a `wrap` viewport:
/// the largest rect of the image's aspect that fits, upscaling an image
/// smaller than the viewport — the same rule as the canvas fit scale
/// (`CanvasMath::fit_pixel_scale`), so the overlay lies on the painted
/// image. A non-positive image axis reads as one pixel; `wrap` is used as
/// given, so a negative or NaN viewport yields a rect of the same kind.
#[must_use]
pub fn fit_footprint(wrap: Size, image: Size) -> Rect {
    let image_width = positive_or_one(image.width);
    let image_height = positive_or_one(image.height);
    let scale = (wrap.width / image_width).min(wrap.height / image_height);
    let width = image_width * scale;
    let height = image_height * scale;
    Rect::new(
        (wrap.width - width) / 2.0,
        (wrap.height - height) / 2.0,
        width,
        height,
    )
}

/// The crop rect in viewport points over `footprint`.
#[must_use]
pub fn crop_rect_in_view(crop: CropEdges, footprint: Rect) -> Rect {
    Rect::new(
        footprint.x + crop.left * footprint.width,
        footprint.y + crop.top * footprint.height,
        (crop.right - crop.left) * footprint.width,
        (crop.bottom - crop.top) * footprint.height,
    )
}

/// A viewport point in normalized image coordinates, clamped to `[0, 1]`.
/// An axis with no footprint extent maps to `0`.
#[must_use]
pub fn view_point_to_normalized(point: Point, footprint: Rect) -> Point {
    let x = if footprint.width > 0.0 {
        (point.x - footprint.x) / footprint.width
    } else {
        0.0
    };
    let y = if footprint.height > 0.0 {
        (point.y - footprint.y) / footprint.height
    } else {
        0.0
    };
    Point::new(clamp_unit(x), clamp_unit(y))
}

/// The handle under `point` within `tolerance` points of the crop rect, or
/// `None` outside it. Corners win over edges, edges over the interior.
#[must_use]
pub fn hit_test_handle(point: Point, rect: Rect, tolerance: f64) -> Option<CropHandle> {
    let near_left = (point.x - rect.x).abs() <= tolerance;
    let near_right = (point.x - rect.max_x()).abs() <= tolerance;
    let near_top = (point.y - rect.y).abs() <= tolerance;
    let near_bottom = (point.y - rect.max_y()).abs() <= tolerance;
    let within_x = point.x >= rect.x - tolerance && point.x <= rect.max_x() + tolerance;
    let within_y = point.y >= rect.y - tolerance && point.y <= rect.max_y() + tolerance;
    let candidates = [
        (near_left && near_top, CropHandle::TopLeft),
        (near_right && near_top, CropHandle::TopRight),
        (near_left && near_bottom, CropHandle::BottomLeft),
        (near_right && near_bottom, CropHandle::BottomRight),
        (near_top && within_x, CropHandle::Top),
        (near_bottom && within_x, CropHandle::Bottom),
        (near_left && within_y, CropHandle::Left),
        (near_right && within_y, CropHandle::Right),
        (within_x && within_y, CropHandle::Move),
    ];
    candidates
        .into_iter()
        .find_map(|(hit, handle)| hit.then_some(handle))
}

/// How a handle drag resizes: `aspect` is the locked image-space width ÷
/// height, and `image` is the oriented pixel size the normalized rect is
/// relative to. The lock applies only to a finite positive aspect with a
/// positive finite image; otherwise the resize is free, so an image size that
/// is not known yet cannot collapse the crop.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CropResizeOptions {
    pub aspect: Option<f64>,
    pub image: Size,
}

/// Apply a handle drag to `target` (the pointer in normalized image
/// coordinates). Each moved edge follows the pointer but keeps at least
/// `MIN_CROP_FRACTION` from its opposite edge and stays inside the image;
/// with an aspect lock the free axis is recomputed about the corner opposite
/// the handle, then scaled back if that pushed the rect off the image.
/// A non-finite pointer leaves the crop unchanged.
#[must_use]
pub fn resize_crop(
    crop: CropEdges,
    handle: CropHandle,
    target: Point,
    options: CropResizeOptions,
) -> CropEdges {
    if !target.is_finite() {
        return crop;
    }
    let pick = |moves: bool, moved: f64, kept: f64| clamp_unit(if moves { moved } else { kept });
    let dragged = CropEdges {
        left: pick(
            handle.moves_left(),
            target.x.min(crop.right - MIN_CROP_FRACTION),
            crop.left,
        ),
        right: pick(
            handle.moves_right(),
            target.x.max(crop.left + MIN_CROP_FRACTION),
            crop.right,
        ),
        top: pick(
            handle.moves_top(),
            target.y.min(crop.bottom - MIN_CROP_FRACTION),
            crop.top,
        ),
        bottom: pick(
            handle.moves_bottom(),
            target.y.max(crop.top + MIN_CROP_FRACTION),
            crop.bottom,
        ),
        angle: crop.angle,
    };
    match options.aspect {
        Some(aspect) if lock_is_resolvable(aspect, options.image) => {
            locked_to_aspect(dragged, handle, aspect, options.image)
        }
        _ => dragged,
    }
}

fn lock_is_resolvable(aspect: f64, image: Size) -> bool {
    let image_known = image.is_finite() && image.width > 0.0 && image.height > 0.0;
    aspect.is_finite() && aspect > 0.0 && image_known
}

/// Recompute the free axis so the image-space proportions equal `aspect`,
/// anchored on the edges the handle did not move.
fn locked_to_aspect(crop: CropEdges, handle: CropHandle, aspect: f64, image: Size) -> CropEdges {
    let width_to_height_normalized = aspect * (image.height / image.width);
    let drag_width = crop.right - crop.left;
    let drag_height = crop.bottom - crop.top;
    let height_driven = matches!(handle, CropHandle::Top | CropHandle::Bottom);
    let (width, height) = if height_driven {
        (drag_height * width_to_height_normalized, drag_height)
    } else {
        (drag_width, drag_width / width_to_height_normalized)
    };
    let anchor_right = handle.moves_left();
    let anchor_bottom = handle.moves_top();
    let placed = anchored(crop, anchor_right, anchor_bottom, width, height);
    let overflow = [
        overflow_fraction(-placed.left, width),
        overflow_fraction(placed.right - 1.0, width),
        overflow_fraction(-placed.top, height),
        overflow_fraction(placed.bottom - 1.0, height),
    ]
    .into_iter()
    .fold(0.0, f64::max);
    let fitted = if overflow > 0.0 {
        let scale = 1.0 - overflow;
        anchored(
            placed,
            anchor_right,
            anchor_bottom,
            width * scale,
            height * scale,
        )
    } else {
        placed
    };
    CropEdges {
        top: clamp_unit(fitted.top),
        left: clamp_unit(fitted.left),
        bottom: clamp_unit(fitted.bottom),
        right: clamp_unit(fitted.right),
        angle: fitted.angle,
    }
}

/// `crop` resized to `width × height`, keeping the right edge when
/// `anchor_right` (else the left) and the bottom when `anchor_bottom`.
fn anchored(
    crop: CropEdges,
    anchor_right: bool,
    anchor_bottom: bool,
    width: f64,
    height: f64,
) -> CropEdges {
    let (left, right) = if anchor_right {
        (crop.right - width, crop.right)
    } else {
        (crop.left, crop.left + width)
    };
    let (top, bottom) = if anchor_bottom {
        (crop.bottom - height, crop.bottom)
    } else {
        (crop.top, crop.top + height)
    };
    CropEdges {
        top,
        left,
        bottom,
        right,
        angle: crop.angle,
    }
}

fn overflow_fraction(excess: f64, extent: f64) -> f64 {
    if excess > 0.0 {
        excess / extent.max(1e-6)
    } else {
        0.0
    }
}

/// Translate the crop by a normalized `delta`, clamped so it stays inside
/// the image without resizing. A non-finite delta leaves the crop unchanged.
#[must_use]
pub fn move_crop(crop: CropEdges, delta: Size) -> CropEdges {
    if !delta.is_finite() {
        return crop;
    }
    let width = crop.right - crop.left;
    let height = crop.bottom - crop.top;
    let left = (crop.left + delta.width).min(1.0 - width).max(0.0);
    let top = (crop.top + delta.height).min(1.0 - height).max(0.0);
    CropEdges {
        top,
        left,
        bottom: top + height,
        right: left + width,
        angle: crop.angle,
    }
}

/// The largest centred crop of image-space `aspect` (width ÷ height) for an
/// `image`-sized frame, keeping `angle`. The full frame when the aspect or
/// the image is not positive.
#[must_use]
pub fn centered_crop_for_aspect(aspect: f64, image: Size, angle: f64) -> CropEdges {
    if !(aspect > 0.0 && image.width > 0.0 && image.height > 0.0) {
        return CropEdges::full_frame(angle);
    }
    let image_aspect = image.width / image.height;
    let (width, height) = if aspect >= image_aspect {
        (1.0, image_aspect / aspect)
    } else {
        (aspect / image_aspect, 1.0)
    };
    let left = (1.0 - width) / 2.0;
    let top = (1.0 - height) / 2.0;
    CropEdges {
        top,
        left,
        bottom: top + height,
        right: left + width,
        angle,
    }
}

/// `value` clamped to `[0, 1]`; NaN reads as `1`, matching the Swift and
/// TypeScript ports' `max(0, min(1, v))`.
fn clamp_unit(value: f64) -> f64 {
    0.0_f64.max(1.0_f64.min(value))
}

fn positive_or_one(value: f64) -> f64 {
    if value > 0.0 {
        value
    } else {
        1.0
    }
}

#[cfg(test)]
#[path = "crop_tests.rs"]
mod tests;
