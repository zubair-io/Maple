//! Interactive crop geometry over FFI (#5714): footprint, view mapping,
//! handle hit-testing, resize with aspect lock, move and aspect presets from
//! `raw_core::canvas`. Values only. Handles travel as
//! `MAPLE_CANVAS_CROP_HANDLE_*` codes; `NONE` is "no handle", and resizing
//! with an unknown code leaves the crop unchanged.

use crate::canvas_math::{MapleCanvasPoint, MapleCanvasRect, MapleCanvasSize};
use raw_core::canvas::{self, CropEdges, CropHandle, CropResizeOptions};

pub const MAPLE_CANVAS_CROP_HANDLE_NONE: u32 = 0;
pub const MAPLE_CANVAS_CROP_HANDLE_TOP_LEFT: u32 = 1;
pub const MAPLE_CANVAS_CROP_HANDLE_TOP_RIGHT: u32 = 2;
pub const MAPLE_CANVAS_CROP_HANDLE_BOTTOM_LEFT: u32 = 3;
pub const MAPLE_CANVAS_CROP_HANDLE_BOTTOM_RIGHT: u32 = 4;
pub const MAPLE_CANVAS_CROP_HANDLE_TOP: u32 = 5;
pub const MAPLE_CANVAS_CROP_HANDLE_BOTTOM: u32 = 6;
pub const MAPLE_CANVAS_CROP_HANDLE_LEFT: u32 = 7;
pub const MAPLE_CANVAS_CROP_HANDLE_RIGHT: u32 = 8;
pub const MAPLE_CANVAS_CROP_HANDLE_MOVE: u32 = 9;

/// Crop edges normalized to `[0, 1]` of the display-oriented image, top-left
/// origin, plus the straighten angle in degrees (positive = clockwise).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasCrop {
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub angle: f64,
}

/// Resize options: `aspect` (image-space width ÷ height) applies when
/// `has_aspect` is nonzero and it is positive; `image_size` in pixels.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasCropResizeOptions {
    pub has_aspect: u8,
    pub aspect: f64,
    pub image_size: MapleCanvasSize,
}

impl From<MapleCanvasCrop> for CropEdges {
    fn from(crop: MapleCanvasCrop) -> Self {
        CropEdges {
            top: crop.top,
            left: crop.left,
            bottom: crop.bottom,
            right: crop.right,
            angle: crop.angle,
        }
    }
}

impl From<CropEdges> for MapleCanvasCrop {
    fn from(crop: CropEdges) -> Self {
        Self {
            top: crop.top,
            left: crop.left,
            bottom: crop.bottom,
            right: crop.right,
            angle: crop.angle,
        }
    }
}

fn handle_code(handle: Option<CropHandle>) -> u32 {
    match handle {
        None => MAPLE_CANVAS_CROP_HANDLE_NONE,
        Some(CropHandle::TopLeft) => MAPLE_CANVAS_CROP_HANDLE_TOP_LEFT,
        Some(CropHandle::TopRight) => MAPLE_CANVAS_CROP_HANDLE_TOP_RIGHT,
        Some(CropHandle::BottomLeft) => MAPLE_CANVAS_CROP_HANDLE_BOTTOM_LEFT,
        Some(CropHandle::BottomRight) => MAPLE_CANVAS_CROP_HANDLE_BOTTOM_RIGHT,
        Some(CropHandle::Top) => MAPLE_CANVAS_CROP_HANDLE_TOP,
        Some(CropHandle::Bottom) => MAPLE_CANVAS_CROP_HANDLE_BOTTOM,
        Some(CropHandle::Left) => MAPLE_CANVAS_CROP_HANDLE_LEFT,
        Some(CropHandle::Right) => MAPLE_CANVAS_CROP_HANDLE_RIGHT,
        Some(CropHandle::Move) => MAPLE_CANVAS_CROP_HANDLE_MOVE,
    }
}

pub(crate) fn handle_from_code(code: u32) -> Option<CropHandle> {
    match code {
        MAPLE_CANVAS_CROP_HANDLE_TOP_LEFT => Some(CropHandle::TopLeft),
        MAPLE_CANVAS_CROP_HANDLE_TOP_RIGHT => Some(CropHandle::TopRight),
        MAPLE_CANVAS_CROP_HANDLE_BOTTOM_LEFT => Some(CropHandle::BottomLeft),
        MAPLE_CANVAS_CROP_HANDLE_BOTTOM_RIGHT => Some(CropHandle::BottomRight),
        MAPLE_CANVAS_CROP_HANDLE_TOP => Some(CropHandle::Top),
        MAPLE_CANVAS_CROP_HANDLE_BOTTOM => Some(CropHandle::Bottom),
        MAPLE_CANVAS_CROP_HANDLE_LEFT => Some(CropHandle::Left),
        MAPLE_CANVAS_CROP_HANDLE_RIGHT => Some(CropHandle::Right),
        MAPLE_CANVAS_CROP_HANDLE_MOVE => Some(CropHandle::Move),
        _ => None,
    }
}

/// The smallest crop extent per axis, as a fraction of that axis.
#[no_mangle]
pub extern "C" fn maple_canvas_crop_min_fraction() -> f64 {
    crate::error::catch_panic(
        "maple_canvas_crop_min_fraction",
        canvas::MIN_CROP_FRACTION,
        || canvas::MIN_CROP_FRACTION,
    )
}

/// The image's fit-zoom rect (points) centred in a `wrap_size` viewport.
#[no_mangle]
pub extern "C" fn maple_canvas_crop_fit_footprint(
    wrap_size: MapleCanvasSize,
    image_size: MapleCanvasSize,
) -> MapleCanvasRect {
    crate::error::catch_panic(
        "maple_canvas_crop_fit_footprint",
        MapleCanvasRect::default(),
        || canvas::fit_footprint(wrap_size.into(), image_size.into()).into(),
    )
}

/// The crop rect in viewport points over `footprint`.
#[no_mangle]
pub extern "C" fn maple_canvas_crop_rect_in_view(
    crop: MapleCanvasCrop,
    footprint: MapleCanvasRect,
) -> MapleCanvasRect {
    crate::error::catch_panic(
        "maple_canvas_crop_rect_in_view",
        MapleCanvasRect::default(),
        || canvas::crop_rect_in_view(crop.into(), footprint.into()).into(),
    )
}

/// A viewport point in normalized image coordinates, clamped to `[0, 1]`.
#[no_mangle]
pub extern "C" fn maple_canvas_crop_view_point_to_normalized(
    point: MapleCanvasPoint,
    footprint: MapleCanvasRect,
) -> MapleCanvasPoint {
    crate::error::catch_panic(
        "maple_canvas_crop_view_point_to_normalized",
        MapleCanvasPoint::default(),
        || canvas::view_point_to_normalized(point.into(), footprint.into()).into(),
    )
}

/// The `MAPLE_CANVAS_CROP_HANDLE_*` code under `point`, or `NONE`.
#[no_mangle]
pub extern "C" fn maple_canvas_crop_hit_test(
    point: MapleCanvasPoint,
    rect: MapleCanvasRect,
    tolerance: f64,
) -> u32 {
    crate::error::catch_panic(
        "maple_canvas_crop_hit_test",
        MAPLE_CANVAS_CROP_HANDLE_NONE,
        || {
            handle_code(canvas::hit_test_handle(
                point.into(),
                rect.into(),
                tolerance,
            ))
        },
    )
}

/// Apply a drag of `handle` to `target` (normalized image coordinates).
#[no_mangle]
pub extern "C" fn maple_canvas_crop_resize(
    crop: MapleCanvasCrop,
    handle: u32,
    target: MapleCanvasPoint,
    options: MapleCanvasCropResizeOptions,
) -> MapleCanvasCrop {
    crate::error::catch_panic("maple_canvas_crop_resize", crop, || {
        let Some(handle) = handle_from_code(handle) else {
            return crop;
        };
        let options = CropResizeOptions {
            aspect: (options.has_aspect != 0).then_some(options.aspect),
            image: options.image_size.into(),
        };
        canvas::resize_crop(crop.into(), handle, target.into(), options).into()
    })
}

/// Translate the crop by a normalized `delta`, kept inside the image.
#[no_mangle]
pub extern "C" fn maple_canvas_crop_move(
    crop: MapleCanvasCrop,
    delta: MapleCanvasSize,
) -> MapleCanvasCrop {
    crate::error::catch_panic("maple_canvas_crop_move", crop, || {
        canvas::move_crop(crop.into(), delta.into()).into()
    })
}

/// The largest centred crop of `aspect` (image-space width ÷ height).
#[no_mangle]
pub extern "C" fn maple_canvas_crop_centered_for_aspect(
    aspect: f64,
    image_size: MapleCanvasSize,
    angle: f64,
) -> MapleCanvasCrop {
    crate::error::catch_panic(
        "maple_canvas_crop_centered_for_aspect",
        CropEdges::full_frame(angle).into(),
        || canvas::centered_crop_for_aspect(aspect, image_size.into(), angle).into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: MapleCanvasCrop = MapleCanvasCrop {
        top: 0.0,
        left: 0.0,
        bottom: 1.0,
        right: 1.0,
        angle: 0.0,
    };

    #[test]
    fn handle_codes_round_trip() {
        for code in MAPLE_CANVAS_CROP_HANDLE_TOP_LEFT..=MAPLE_CANVAS_CROP_HANDLE_MOVE {
            assert_eq!(handle_code(handle_from_code(code)), code);
        }
        assert_eq!(handle_from_code(MAPLE_CANVAS_CROP_HANDLE_NONE), None);
        assert_eq!(handle_from_code(42), None);
    }

    #[test]
    fn hit_test_and_resize_match_the_core() {
        let rect = MapleCanvasRect {
            x: 100.0,
            y: 100.0,
            width: 200.0,
            height: 200.0,
        };
        let corner = MapleCanvasPoint { x: 100.0, y: 100.0 };
        assert_eq!(
            maple_canvas_crop_hit_test(corner, rect, 12.0),
            MAPLE_CANVAS_CROP_HANDLE_TOP_LEFT
        );
        assert_eq!(
            maple_canvas_crop_hit_test(MapleCanvasPoint { x: 0.0, y: 0.0 }, rect, 12.0),
            MAPLE_CANVAS_CROP_HANDLE_NONE
        );
        let options = MapleCanvasCropResizeOptions {
            has_aspect: 0,
            aspect: 1.0,
            image_size: MapleCanvasSize {
                width: 600.0,
                height: 400.0,
            },
        };
        let target = MapleCanvasPoint { x: 0.3, y: 0.2 };
        let resized =
            maple_canvas_crop_resize(FULL, MAPLE_CANVAS_CROP_HANDLE_TOP_LEFT, target, options);
        assert_eq!((resized.left, resized.top), (0.3, 0.2));
        assert_eq!(maple_canvas_crop_resize(FULL, 42, target, options), FULL);
    }

    #[test]
    fn footprint_move_and_presets_match_the_core() {
        let footprint = maple_canvas_crop_fit_footprint(
            MapleCanvasSize {
                width: 1000.0,
                height: 400.0,
            },
            MapleCanvasSize {
                width: 600.0,
                height: 400.0,
            },
        );
        assert_eq!(footprint.x, 200.0);
        let moved = maple_canvas_crop_move(
            MapleCanvasCrop {
                top: 0.1,
                left: 0.1,
                bottom: 0.5,
                right: 0.5,
                angle: 0.0,
            },
            MapleCanvasSize {
                width: 0.7,
                height: 0.0,
            },
        );
        assert_eq!(moved.right, 1.0);
        let preset = maple_canvas_crop_centered_for_aspect(
            0.0,
            MapleCanvasSize {
                width: 600.0,
                height: 400.0,
            },
            4.0,
        );
        assert_eq!(preset, MapleCanvasCrop { angle: 4.0, ..FULL });
        assert_eq!(maple_canvas_crop_min_fraction(), 0.05);
    }
}
