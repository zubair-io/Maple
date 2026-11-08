//! Deep-zoom tile selection: which native-resolution patch of the oriented
//! image covers the visible region at 100% and above, how far it is grown so
//! small pans reuse it, the decode rect that adds filter context around it,
//! and when a visible-region change must drop or redevelop the published
//! patch. The rendering itself stays with each platform.
//!
//! All rects are in oriented source pixels, top-left origin. A negative
//! extent is standardized; a non-finite rect or size is treated as empty.

use super::geometry::{Rect, Size};
use super::mapping::MAX_TEXTURE_EDGE;

/// Native detail starts at 1:1; below it the sized whole-image decode is
/// already at least as sharp as the screen.
pub const NATIVE_DETAIL_MIN_PIXEL_SCALE: f64 = 1.0;

/// Floor on the filter context around a patch. The develop chain's own reach
/// widens it when a stage needs more (#5169).
pub const NATIVE_DETAIL_FILTER_HALO: f64 = 96.0;

/// The published patch grows by this fraction of the visible rect's longer
/// edge (split across both edges, on both axes) so a typical small pan lands
/// inside the previous publish instead of paying a fresh develop (#2063).
pub const NATIVE_DETAIL_PAN_MARGIN_FRACTION: f64 = 0.25;

/// Ceiling on the total pan margin per axis, in source pixels, so a very
/// large viewport does not grow the develop without bound.
pub const NATIVE_DETAIL_PAN_MARGIN_CEILING: f64 = 512.0;

/// Below this zoom difference a visible-region update counts as a pure pan,
/// so sub-pixel jitter during a pinch does not reschedule refines.
pub const NATIVE_DETAIL_ZOOM_CHANGE_EPSILON: f64 = 0.01;

/// Whether the native-detail patch should render: at or above 1:1, for a
/// non-empty visible rect that does not already cover the whole image. An
/// `image_size` that is not positive on both axes skips the whole-image test.
#[must_use]
pub fn native_detail_should_render(pixel_scale: f64, visible_rect: Rect, image_size: Size) -> bool {
    let visible = visible_rect.standardized();
    let at_one_to_one = pixel_scale >= NATIVE_DETAIL_MIN_PIXEL_SCALE;
    if !at_one_to_one || visible.is_empty() {
        return false;
    }
    let image_known = image_size.width > 0.0 && image_size.height > 0.0;
    !(image_known && visible.width >= image_size.width && visible.height >= image_size.height)
}

/// The integer source rect the overlay displays: the visible rect rounded
/// outward so every visible pixel is covered, clamped to the image.
/// `Rect::ZERO` when either input is empty or they do not overlap.
#[must_use]
pub fn detail_rect(visible_rect: Rect, image_size: Size) -> Rect {
    let visible = visible_rect.standardized();
    match image_bounds(image_size) {
        Some(bounds) if !visible.is_empty() => visible
            .integral()
            .intersection(bounds)
            .unwrap_or(Rect::ZERO),
        _ => Rect::ZERO,
    }
}

/// Total pixels the published patch grows by on each axis (split evenly
/// between both edges): `NATIVE_DETAIL_PAN_MARGIN_FRACTION` of the visible
/// rect's longer edge, at most `NATIVE_DETAIL_PAN_MARGIN_CEILING`. Zero for
/// an empty rect.
#[must_use]
pub fn pan_margin(visible_rect: Rect) -> f64 {
    let visible = visible_rect.standardized();
    if visible.is_empty() {
        return 0.0;
    }
    (visible.width.max(visible.height) * NATIVE_DETAIL_PAN_MARGIN_FRACTION)
        .min(NATIVE_DETAIL_PAN_MARGIN_CEILING)
}

/// The rect developed and published: [`detail_rect`] grown by
/// [`pan_margin`] and clamped to the image. Always contains the ungrown
/// detail rect, which the containment fast path relies on.
#[must_use]
pub fn patch_rect(visible_rect: Rect, image_size: Size) -> Rect {
    let base = detail_rect(visible_rect, image_size);
    let margin = pan_margin(visible_rect);
    match image_bounds(image_size) {
        Some(bounds) if !base.is_empty() && margin > 0.0 => base
            .inset(-margin / 2.0, -margin / 2.0)
            .integral()
            .intersection(bounds)
            .unwrap_or(base),
        _ => base,
    }
}

/// The source rect sent to the RAW tile develop: `detail_rect` plus a halo of
/// at least `NATIVE_DETAIL_FILTER_HALO` on every side, clamped to the image.
///
/// `Rect::ZERO` asks for the whole-image refine instead: an empty patch, an
/// unknown image, an infinite halo, or a decode rect (after clamping to the
/// image) wider or taller than `MAX_TEXTURE_EDGE` — the halo is never
/// truncated on one side only, which would make the patch's edge pixels
/// disagree with the whole-image render. A NaN halo uses the floor.
#[must_use]
pub fn decode_rect(detail_rect: Rect, image_size: Size, halo: f64) -> Rect {
    let reach = NATIVE_DETAIL_FILTER_HALO.max(halo);
    let detail = detail_rect.standardized();
    let Some(bounds) = image_bounds(image_size) else {
        return Rect::ZERO;
    };
    if detail.is_empty() || !reach.is_finite() {
        return Rect::ZERO;
    }
    match detail.inset(-reach, -reach).integral().intersection(bounds) {
        Some(expanded)
            if expanded.width <= MAX_TEXTURE_EDGE && expanded.height <= MAX_TEXTURE_EDGE =>
        {
            expanded
        }
        _ => Rect::ZERO,
    }
}

/// `detail_rect` (top-left origin, image coordinates) expressed inside its
/// containing `decode_rect` with a bottom-left origin, as CoreImage and other
/// y-up surfaces address the decoded patch. `Rect::ZERO` when either is empty.
#[must_use]
pub fn detail_rect_in_decode_bottom_up(detail_rect: Rect, decode_rect: Rect) -> Rect {
    let detail = detail_rect.standardized();
    let decode = decode_rect.standardized();
    if detail.is_empty() || decode.is_empty() {
        return Rect::ZERO;
    }
    let top = detail.y - decode.y;
    Rect::new(
        detail.x - decode.x,
        decode.height - top - detail.height,
        detail.width,
        detail.height,
    )
}

/// Whether a published patch already covers `detail_rect`, so there is
/// nothing new to develop. False when nothing is published or the detail
/// rect is empty.
#[must_use]
pub fn published_patch_covers(published_patch: Option<Rect>, detail_rect: Rect) -> bool {
    match published_patch {
        Some(patch) => !detail_rect.is_empty() && patch.contains_rect(detail_rect),
        None => false,
    }
}

/// One visible-region update: the region (oriented source pixels) and zoom
/// (real pixels per image pixel) before and after, and the patch currently
/// published (if any). A NaN zoom on either side reads as "zoom unchanged".
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VisibleRegionUpdate {
    pub previous_viewport: Rect,
    pub viewport: Rect,
    pub previous_zoom: f64,
    pub zoom: f64,
    pub published_patch: Option<Rect>,
    pub image_size: Size,
}

/// What a visible-region update must do to the native-detail patch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VisibleRegionChange {
    /// The zoom moved by more than `NATIVE_DETAIL_ZOOM_CHANGE_EPSILON`; the
    /// zoom change itself reschedules the refine.
    pub zoom_changed: bool,
    /// The region moved off the published patch: drop it before it shows the
    /// wrong pixels.
    pub clears_patch: bool,
    /// A pure pan off the published patch: no zoom change will reschedule,
    /// so the update must schedule the refine itself.
    pub schedules_refine: bool,
}

/// The containment fast path (#2063): a pure pan whose new detail rect stays
/// inside the published patch keeps it and develops nothing.
#[must_use]
pub fn visible_region_change(update: VisibleRegionUpdate) -> VisibleRegionChange {
    let rect_changed = update.previous_viewport.standardized() != update.viewport.standardized();
    let zoom_changed =
        (update.zoom - update.previous_zoom).abs() > NATIVE_DETAIL_ZOOM_CHANGE_EPSILON;
    let new_detail = detail_rect(update.viewport, update.image_size);
    let covered = !zoom_changed && published_patch_covers(update.published_patch, new_detail);
    let moves_off_patch = rect_changed && !covered;
    VisibleRegionChange {
        zoom_changed,
        clears_patch: moves_off_patch,
        schedules_refine: moves_off_patch && !zoom_changed,
    }
}

fn image_bounds(image_size: Size) -> Option<Rect> {
    let bounds = Rect::from_size(image_size);
    (bounds.width > 0.0 && bounds.height > 0.0 && bounds.is_finite()).then_some(bounds)
}

#[cfg(test)]
#[path = "native_detail_tests.rs"]
mod tests;
