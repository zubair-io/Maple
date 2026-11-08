//! Canvas mapping FFI (#5714): plain-value mirrors of `raw_core::canvas`
//! geometry and one call resolving a `CanvasMath` snapshot. Every entry takes
//! and returns values only — no pointers, no allocation — so it is safe to
//! call on every gesture frame.

use raw_core::canvas::{CanvasMath, Point, Rect, Size};

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasSize {
    pub width: f64,
    pub height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<MapleCanvasSize> for Size {
    fn from(size: MapleCanvasSize) -> Self {
        Size::new(size.width, size.height)
    }
}

impl From<Size> for MapleCanvasSize {
    fn from(size: Size) -> Self {
        Self {
            width: size.width,
            height: size.height,
        }
    }
}

impl From<MapleCanvasPoint> for Point {
    fn from(point: MapleCanvasPoint) -> Self {
        Point::new(point.x, point.y)
    }
}

impl From<Point> for MapleCanvasPoint {
    fn from(point: Point) -> Self {
        Self {
            x: point.x,
            y: point.y,
        }
    }
}

impl From<MapleCanvasRect> for Rect {
    fn from(rect: MapleCanvasRect) -> Self {
        Rect::new(rect.x, rect.y, rect.width, rect.height)
    }
}

impl From<Rect> for MapleCanvasRect {
    fn from(rect: Rect) -> Self {
        Self {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        }
    }
}

/// Inputs of one canvas snapshot: `viewport_px` in real pixels,
/// `native_image_size` in oriented source pixels (zero until known),
/// `pixel_scale` with 0 = fit, `pan_offset` in points, `display_scale`
/// points→pixels.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasMathInput {
    pub viewport_px: MapleCanvasSize,
    pub native_image_size: MapleCanvasSize,
    pub pixel_scale: f64,
    pub pan_offset: MapleCanvasSize,
    pub display_scale: f64,
}

/// Every derived value of a snapshot. Each `has_*` flag says whether the
/// matching optional value exists; when false the value is zero.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasMathResult {
    pub has_image_extent: bool,
    pub image_extent: MapleCanvasSize,
    pub fit_pixel_scale: f64,
    pub fill_pixel_scale: f64,
    pub effective_pixel_scale: f64,
    pub has_display_frame: bool,
    pub display_frame_in_points: MapleCanvasSize,
    pub has_fast_target: bool,
    pub fast_target_size: MapleCanvasSize,
    pub has_refined_target: bool,
    pub refined_target_size: MapleCanvasSize,
    pub visible_source_rect: MapleCanvasRect,
}

/// Resolve every derived value of one canvas snapshot. Bad inputs (NaN,
/// negative sizes) degrade as `raw_core::canvas::CanvasMath::new` documents.
#[no_mangle]
pub extern "C" fn maple_canvas_math_resolve(input: MapleCanvasMathInput) -> MapleCanvasMathResult {
    crate::error::catch_panic(
        "maple_canvas_math_resolve",
        MapleCanvasMathResult::default(),
        || {
            let math = CanvasMath::new(
                input.viewport_px.into(),
                input.native_image_size.into(),
                input.pixel_scale,
                input.pan_offset.into(),
                input.display_scale,
            );
            resolve(&math)
        },
    )
}

fn resolve(math: &CanvasMath) -> MapleCanvasMathResult {
    let image_extent = math.image_extent();
    let display_frame = math.display_frame_in_points();
    let fast_target = math.fast_target_size();
    let refined_target = math.refined_target_size();
    MapleCanvasMathResult {
        has_image_extent: image_extent.is_some(),
        image_extent: image_extent.unwrap_or_default().into(),
        fit_pixel_scale: math.fit_pixel_scale(),
        fill_pixel_scale: math.fill_pixel_scale(),
        effective_pixel_scale: math.effective_pixel_scale(),
        has_display_frame: display_frame.is_some(),
        display_frame_in_points: display_frame.unwrap_or_default().into(),
        has_fast_target: fast_target.is_some(),
        fast_target_size: fast_target.unwrap_or_default().into(),
        has_refined_target: refined_target.is_some(),
        refined_target_size: refined_target.unwrap_or_default().into(),
        visible_source_rect: math.visible_source_rect().into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_reports_optional_values_with_flags() {
        let no_image = maple_canvas_math_resolve(MapleCanvasMathInput {
            viewport_px: MapleCanvasSize {
                width: 1000.0,
                height: 800.0,
            },
            display_scale: 2.0,
            ..Default::default()
        });
        assert!(!no_image.has_image_extent);
        assert!(!no_image.has_display_frame);
        assert!(no_image.has_fast_target);
        assert_eq!(no_image.fit_pixel_scale, 1.0);

        let sized = maple_canvas_math_resolve(MapleCanvasMathInput {
            viewport_px: MapleCanvasSize {
                width: 1000.0,
                height: 800.0,
            },
            native_image_size: MapleCanvasSize {
                width: 4000.0,
                height: 3000.0,
            },
            pixel_scale: 1.0,
            pan_offset: MapleCanvasSize::default(),
            display_scale: 1.0,
        });
        assert!(sized.has_image_extent && sized.has_refined_target);
        assert_eq!(
            sized.refined_target_size,
            MapleCanvasSize {
                width: 2000.0,
                height: 2000.0
            }
        );
        assert_eq!(sized.visible_source_rect.x, 1500.0);
    }
}
