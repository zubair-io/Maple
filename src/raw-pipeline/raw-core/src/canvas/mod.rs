//! Canvas geometry shared by every platform shell (#5714): the fit / fill /
//! 100% zoom model with its gesture transitions, the mapping between the
//! viewport and the oriented image (fit scale, on-screen frame, render
//! targets, visible source rect), deep-zoom tile selection, the two-phase
//! render scheduling rules, the interactive crop geometry, and the overlay
//! primitives the shared overlay surface draws (#5715).
//!
//! Every type is a `Copy` value with no allocation, and every function is a
//! total function of its inputs: non-finite or negative sizes, a zero
//! viewport, or a missing image extent degrade to documented fallbacks rather
//! than panicking. Units: viewport and pan in POINTS unless a name says `px`;
//! image extents in oriented source pixels; a `pixel_scale` is real screen
//! pixels per image pixel, with `0` meaning fit-to-viewport.

mod crop;
mod geometry;
mod mapping;
mod native_detail;
mod overlay;
mod render_schedule;
mod zoom;
mod zoom_context;
mod zoom_continuity;
mod zoom_pinch;
mod zoom_queries;
mod zoom_rebase;
mod zoom_rules;

pub use crop::{
    centered_crop_for_aspect, crop_rect_in_view, fit_footprint, hit_test_handle, move_crop,
    resize_crop, view_point_to_normalized, CropEdges, CropHandle, CropResizeOptions,
    MIN_CROP_FRACTION,
};
pub use geometry::{Insets, Point, Rect, Size};
pub use mapping::{CanvasMath, MAX_TEXTURE_EDGE};
pub use native_detail::{
    decode_rect, detail_rect, detail_rect_in_decode_bottom_up, native_detail_should_render,
    pan_margin, patch_rect, published_patch_covers, visible_region_change, VisibleRegionChange,
    VisibleRegionUpdate, NATIVE_DETAIL_FILTER_HALO, NATIVE_DETAIL_MIN_PIXEL_SCALE,
    NATIVE_DETAIL_PAN_MARGIN_CEILING, NATIVE_DETAIL_PAN_MARGIN_FRACTION,
    NATIVE_DETAIL_ZOOM_CHANGE_EPSILON,
};
pub use overlay::{
    crop_handle_centers, crop_overlay, overlay_pixel, rasterize_overlay, unorm8, CanvasOverlay,
    CropOverlayInput, OverlayPrimitive, RasterizeError, CROP_ACTIVE_FRAME_WIDTH,
    CROP_CORNER_DOT_DIAMETER, CROP_FRAME_ALPHA, CROP_FRAME_WIDTH, CROP_GRID_ALPHA, CROP_GRID_WIDTH,
    CROP_MASK_ALPHA, CROP_OVERLAY_OVERSCAN, OVERLAY_CAPACITY, OVERLAY_KIND_DISC, OVERLAY_KIND_FILL,
    OVERLAY_KIND_FILL_OUTSIDE, OVERLAY_KIND_NONE,
};
pub use render_schedule::{
    refine_matches_fast_target, refine_tries_native_detail, RefineContext, RenderSchedule,
    REFINE_DEBOUNCE_MS,
};
pub use zoom::{
    CanvasZoomModel, DoubleTapBehavior, DETENT_TOLERANCE, MAX_PIXEL_SCALE, MIN_EXPLICIT_ZOOM,
    MIN_FIT_FRACTION, WHEEL_ZOOM_SENSITIVITY, ZOOM_STEP,
};
pub use zoom_context::CanvasZoomContext;
pub use zoom_queries::{DragIntent, WheelIntent};
pub use zoom_rules::{
    anchored_pan, clamped_explicit_zoom, crosses_fit, detent, distinct_stops, live_pinch_pan,
    next_stop, pinch_scale, zoom_in_target, zoom_out_target, ZoomOutResult, ZoomStop, ZoomStops,
};
