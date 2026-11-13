//! Deep-zoom tile selection over FFI (#5714): the native-detail patch, its
//! pan margin and decode halo, and the visible-region update decision from
//! `raw_core::canvas`. Values only — rects in oriented source pixels, flags
//! as `u8` (nonzero = true) — so a call per gesture frame is cheap.

use crate::canvas_math::{MapleCanvasRect, MapleCanvasSize};
use raw_core::canvas::{self, VisibleRegionUpdate};

/// The shared native-detail constants, so hosts never restate them.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasNativeDetailConstants {
    pub min_pixel_scale: f64,
    pub filter_halo: f64,
    pub pan_margin_fraction: f64,
    pub pan_margin_ceiling: f64,
    pub zoom_change_epsilon: f64,
}

/// One visible-region update. `has_published_patch` marks whether
/// `published_patch` is set; zoom is real pixels per image pixel.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasVisibleRegionUpdate {
    pub previous_viewport: MapleCanvasRect,
    pub viewport: MapleCanvasRect,
    pub previous_zoom: f64,
    pub zoom: f64,
    pub has_published_patch: u8,
    pub published_patch: MapleCanvasRect,
    pub image_size: MapleCanvasSize,
}

/// What the update must do; see `raw_core::canvas::VisibleRegionChange`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MapleCanvasVisibleRegionChange {
    pub zoom_changed: u8,
    pub clears_patch: u8,
    pub schedules_refine: u8,
}

fn published(has_patch: u8, patch: MapleCanvasRect) -> Option<canvas::Rect> {
    (has_patch != 0).then(|| patch.into())
}

#[no_mangle]
pub extern "C" fn maple_canvas_native_detail_constants() -> MapleCanvasNativeDetailConstants {
    crate::error::catch_panic(
        "maple_canvas_native_detail_constants",
        MapleCanvasNativeDetailConstants::default(),
        || MapleCanvasNativeDetailConstants {
            min_pixel_scale: canvas::NATIVE_DETAIL_MIN_PIXEL_SCALE,
            filter_halo: canvas::NATIVE_DETAIL_FILTER_HALO,
            pan_margin_fraction: canvas::NATIVE_DETAIL_PAN_MARGIN_FRACTION,
            pan_margin_ceiling: canvas::NATIVE_DETAIL_PAN_MARGIN_CEILING,
            zoom_change_epsilon: canvas::NATIVE_DETAIL_ZOOM_CHANGE_EPSILON,
        },
    )
}

/// 1 when the native-detail patch should render. A non-positive
/// `image_size` skips the whole-image coverage test.
#[no_mangle]
pub extern "C" fn maple_canvas_native_detail_should_render(
    pixel_scale: f64,
    visible_rect: MapleCanvasRect,
    image_size: MapleCanvasSize,
) -> u8 {
    crate::error::catch_panic("maple_canvas_native_detail_should_render", 0, || {
        u8::from(canvas::native_detail_should_render(
            pixel_scale,
            visible_rect.into(),
            image_size.into(),
        ))
    })
}

/// The visible rect rounded outward and clamped to the image; all-zero when
/// either is empty or they do not overlap.
#[no_mangle]
pub extern "C" fn maple_canvas_native_detail_rect(
    visible_rect: MapleCanvasRect,
    image_size: MapleCanvasSize,
) -> MapleCanvasRect {
    crate::error::catch_panic(
        "maple_canvas_native_detail_rect",
        MapleCanvasRect::default(),
        || canvas::detail_rect(visible_rect.into(), image_size.into()).into(),
    )
}

/// Total pixels the published patch grows by on each axis.
#[no_mangle]
pub extern "C" fn maple_canvas_native_detail_pan_margin(visible_rect: MapleCanvasRect) -> f64 {
    crate::error::catch_panic("maple_canvas_native_detail_pan_margin", 0.0, || {
        canvas::pan_margin(visible_rect.into())
    })
}

/// The rect developed and published: the detail rect grown by the pan margin.
#[no_mangle]
pub extern "C" fn maple_canvas_native_detail_patch_rect(
    visible_rect: MapleCanvasRect,
    image_size: MapleCanvasSize,
) -> MapleCanvasRect {
    crate::error::catch_panic(
        "maple_canvas_native_detail_patch_rect",
        MapleCanvasRect::default(),
        || canvas::patch_rect(visible_rect.into(), image_size.into()).into(),
    )
}

/// The decode rect for `detail_rect`; all-zero requests the whole-image
/// refine instead.
#[no_mangle]
pub extern "C" fn maple_canvas_native_detail_decode_rect(
    detail_rect: MapleCanvasRect,
    image_size: MapleCanvasSize,
    halo: f64,
) -> MapleCanvasRect {
    crate::error::catch_panic(
        "maple_canvas_native_detail_decode_rect",
        MapleCanvasRect::default(),
        || canvas::decode_rect(detail_rect.into(), image_size.into(), halo).into(),
    )
}

/// `detail_rect` inside `decode_rect` with a bottom-left origin.
#[no_mangle]
pub extern "C" fn maple_canvas_native_detail_bottom_up_rect(
    detail_rect: MapleCanvasRect,
    decode_rect: MapleCanvasRect,
) -> MapleCanvasRect {
    crate::error::catch_panic(
        "maple_canvas_native_detail_bottom_up_rect",
        MapleCanvasRect::default(),
        || canvas::detail_rect_in_decode_bottom_up(detail_rect.into(), decode_rect.into()).into(),
    )
}

/// 1 when the published patch (if `has_published_patch`) covers
/// `detail_rect`.
#[no_mangle]
pub extern "C" fn maple_canvas_native_detail_patch_covers(
    has_published_patch: u8,
    published_patch: MapleCanvasRect,
    detail_rect: MapleCanvasRect,
) -> u8 {
    crate::error::catch_panic("maple_canvas_native_detail_patch_covers", 0, || {
        u8::from(canvas::published_patch_covers(
            published(has_published_patch, published_patch),
            detail_rect.into(),
        ))
    })
}

/// Whether a visible-region update clears the published patch and whether
/// it must schedule the refine itself.
#[no_mangle]
pub extern "C" fn maple_canvas_visible_region_change(
    update: MapleCanvasVisibleRegionUpdate,
) -> MapleCanvasVisibleRegionChange {
    crate::error::catch_panic(
        "maple_canvas_visible_region_change",
        MapleCanvasVisibleRegionChange::default(),
        || {
            let change = canvas::visible_region_change(VisibleRegionUpdate {
                previous_viewport: update.previous_viewport.into(),
                viewport: update.viewport.into(),
                previous_zoom: update.previous_zoom,
                zoom: update.zoom,
                published_patch: published(update.has_published_patch, update.published_patch),
                image_size: update.image_size.into(),
            });
            MapleCanvasVisibleRegionChange {
                zoom_changed: u8::from(change.zoom_changed),
                clears_patch: u8::from(change.clears_patch),
                schedules_refine: u8::from(change.schedules_refine),
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> MapleCanvasRect {
        MapleCanvasRect {
            x,
            y,
            width,
            height,
        }
    }

    const IMAGE: MapleCanvasSize = MapleCanvasSize {
        width: 13000.0,
        height: 8000.0,
    };

    #[test]
    fn patch_and_decode_rects_match_the_core() {
        let visible = rect(2000.0, 2000.0, 1600.0, 1000.0);
        assert_eq!(
            maple_canvas_native_detail_should_render(1.0, visible, IMAGE),
            1
        );
        assert_eq!(
            maple_canvas_native_detail_should_render(0.5, visible, IMAGE),
            0
        );
        assert_eq!(maple_canvas_native_detail_pan_margin(visible), 400.0);
        let patch = maple_canvas_native_detail_patch_rect(visible, IMAGE);
        assert_eq!(patch, rect(1800.0, 1800.0, 2000.0, 1400.0));
        assert_eq!(
            maple_canvas_native_detail_decode_rect(patch, IMAGE, 0.0),
            rect(1704.0, 1704.0, 2192.0, 1592.0)
        );
        assert_eq!(
            maple_canvas_native_detail_bottom_up_rect(
                rect(1000.0, 2000.0, 800.0, 600.0),
                rect(900.0, 1800.0, 1200.0, 1000.0)
            ),
            rect(100.0, 200.0, 800.0, 600.0)
        );
        let detail = maple_canvas_native_detail_rect(visible, IMAGE);
        assert_eq!(maple_canvas_native_detail_patch_covers(1, patch, detail), 1);
        assert_eq!(maple_canvas_native_detail_patch_covers(0, patch, detail), 0);
    }

    #[test]
    fn visible_region_change_reports_flags() {
        let first = rect(2000.0, 2000.0, 1600.0, 1000.0);
        let update = MapleCanvasVisibleRegionUpdate {
            previous_viewport: first,
            viewport: rect(2900.0, 2000.0, 1600.0, 1000.0),
            previous_zoom: 1.0,
            zoom: 1.0,
            has_published_patch: 1,
            published_patch: maple_canvas_native_detail_patch_rect(first, IMAGE),
            image_size: IMAGE,
        };
        assert_eq!(
            maple_canvas_visible_region_change(update),
            MapleCanvasVisibleRegionChange {
                zoom_changed: 0,
                clears_patch: 1,
                schedules_refine: 1,
            }
        );
        assert_eq!(
            maple_canvas_visible_region_change(MapleCanvasVisibleRegionUpdate {
                viewport: rect(2030.0, 2020.0, 1600.0, 1000.0),
                ..update
            }),
            MapleCanvasVisibleRegionChange::default()
        );
    }

    #[test]
    fn constants_come_from_the_core() {
        let constants = maple_canvas_native_detail_constants();
        assert_eq!(constants.filter_halo, canvas::NATIVE_DETAIL_FILTER_HALO);
        assert_eq!(constants.min_pixel_scale, 1.0);
        assert_eq!(constants.zoom_change_epsilon, 0.01);
    }
}
