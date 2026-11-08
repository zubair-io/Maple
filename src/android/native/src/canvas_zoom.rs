//! The shared canvas zoom model (`raw_core::canvas`, #5714) for the Compose
//! canvas. Kotlin owns the state as a `STATE_LEN`-slot `double[]` and passes
//! it into each transition, so Rust holds nothing between gesture frames and
//! the per-event path never allocates. Canvas units are Compose pixels: the
//! viewport and image extents go in as pixels with a display scale of 1.

use raw_core::canvas::{
    anchored_pan, next_stop, CanvasZoomContext, CanvasZoomModel, DoubleTapBehavior, Point, Size,
    ZoomStop, MAX_PIXEL_SCALE,
};

/// Slots in the Kotlin state array; the layout is `encode`'s.
const STATE_LEN: usize = 17;

const OP_PINCH_CHANGED: u32 = 0;
const OP_PINCH_ENDED: u32 = 1;
const OP_DRAG_CHANGED: u32 = 2;
const OP_DRAG_ENDED: u32 = 3;
const OP_REBASE_DRAG: u32 = 4;
const OP_DOUBLE_TAP: u32 = 5;
const OP_ADVANCE_STOP: u32 = 6;
const OP_RECLAMP: u32 = 7;
const OP_ADOPT_IMAGE: u32 = 8;

const QUERY_EFFECTIVE_SCALE: u32 = 0;
const QUERY_FIT_SCALE: u32 = 1;
const QUERY_NEXT_STOP: u32 = 2;

/// Returned by a transition that was rejected (null state, unknown op, or a
/// caught panic).
const REJECTED: i32 = -1;

/// Geometry of one call, in Compose pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Geometry {
    viewport: Size,
    image: Size,
}

impl Geometry {
    fn new(viewport_width: f64, viewport_height: f64, image_width: f64, image_height: f64) -> Self {
        Self {
            viewport: Size::new(viewport_width, viewport_height),
            image: Size::new(image_width, image_height),
        }
    }

    fn context(self) -> CanvasZoomContext {
        CanvasZoomContext::new(self.viewport, self.image, 1.0)
    }
}

fn flag(value: bool) -> f64 {
    if value {
        1.0
    } else {
        0.0
    }
}

fn encode(model: &CanvasZoomModel) -> [f64; STATE_LEN] {
    let drag_base = model.drag_translation_base.unwrap_or(Size::ZERO);
    [
        model.pixel_scale,
        model.pan_offset.width,
        model.pan_offset.height,
        model.base_pan.width,
        model.base_pan.height,
        flag(model.drag_translation_base.is_some()),
        drag_base.width,
        drag_base.height,
        flag(model.pinch_start_scale.is_some()),
        model.pinch_start_scale.unwrap_or(0.0),
        model.pinch_start_pan.width,
        model.pinch_start_pan.height,
        model.pinch_start_centroid.x,
        model.pinch_start_centroid.y,
        model.pinch_last_centroid.x,
        model.pinch_last_centroid.y,
        flag(model.fills_viewport),
    ]
}

fn decode(state: &[f64; STATE_LEN]) -> CanvasZoomModel {
    CanvasZoomModel {
        pixel_scale: state[0],
        pan_offset: Size::new(state[1], state[2]),
        base_pan: Size::new(state[3], state[4]),
        drag_translation_base: (state[5] != 0.0).then(|| Size::new(state[6], state[7])),
        pinch_start_scale: (state[8] != 0.0).then_some(state[9]),
        pinch_start_pan: Size::new(state[10], state[11]),
        pinch_start_centroid: Point::new(state[12], state[13]),
        pinch_last_centroid: Point::new(state[14], state[15]),
        fills_viewport: state[16] != 0.0,
    }
}

/// Carries the zoom across the image extent changing under it (a placeholder
/// size replaced by the original's): a free scale keeps its on-screen size,
/// a named stop keeps its meaning (100% stays 1:1, fill re-resolves), and the
/// image point under `anchor` (viewport pixels) stays as close as the pan
/// clamp allows. A pinch or drag in progress continues without a jump: the
/// pinch's start scale is carried relative to fit, and a live drag keeps its
/// offset from the committed pan.
fn adopt_image_size(
    model: CanvasZoomModel,
    anchor: Point,
    previous: &CanvasZoomContext,
    next: &CanvasZoomContext,
) -> CanvasZoomModel {
    let fit_ratio = next.fit_scale() / previous.fit_scale();
    let carried = CanvasZoomModel {
        pinch_start_scale: model.pinch_start_scale.map(|start| start * fit_ratio),
        ..model
    };
    if !carried.is_zoomed_in() {
        return carried;
    }
    let start_scale = previous.effective_scale(carried.pixel_scale);
    let scale = match carried.current_stop() {
        Some(ZoomStop::Fill) => next.fill_scale(),
        Some(ZoomStop::Fit | ZoomStop::ActualSize) => carried.pixel_scale,
        None => (start_scale * fit_ratio).min(MAX_PIXEL_SCALE),
    };
    let pan = anchored_pan(
        anchor,
        next.viewport_points(),
        carried.pan_offset,
        start_scale * previous.native_image_size().width,
        next.effective_scale(scale) * next.native_image_size().width,
    );
    let live_drag = Size::new(
        carried.pan_offset.width - carried.base_pan.width,
        carried.pan_offset.height - carried.base_pan.height,
    );
    CanvasZoomModel {
        pixel_scale: scale,
        pan_offset: pan,
        base_pan: Size::new(pan.width - live_drag.width, pan.height - live_drag.height),
        ..carried
    }
    .reclamp_pan(next)
}

/// One transition; returns the next model and the op's boolean result
/// (drag consumed / pan committed; `true` for ops without one), or `None` for
/// an unknown op.
fn apply(
    model: CanvasZoomModel,
    op: u32,
    args: [f64; 4],
    geometry: Geometry,
) -> Option<(CanvasZoomModel, bool)> {
    let context = geometry.context();
    let [a, b, c, d] = args;
    let transitioned = match op {
        OP_PINCH_CHANGED => model.pinch_changed(a, Point::new(b, c), &context),
        OP_PINCH_ENDED => model.pinch_ended(a, &context),
        OP_DRAG_CHANGED => return Some(model.drag_changed(Size::new(a, b), &context)),
        OP_DRAG_ENDED => return Some(model.drag_ended()),
        OP_REBASE_DRAG => model.rebase_drag_baseline(Size::new(a, b)),
        OP_DOUBLE_TAP => model.double_tap(
            Point::new(a, b),
            DoubleTapBehavior::ToggleFitAnd100,
            &context,
        ),
        OP_ADVANCE_STOP => model.advance_stop(&context),
        OP_RECLAMP => model.reclamp_pan(&context),
        OP_ADOPT_IMAGE => {
            let previous = Geometry {
                image: Size::new(a, b),
                ..geometry
            };
            adopt_image_size(model, Point::new(c, d), &previous.context(), &context)
        }
        _ => return None,
    };
    Some((transitioned, true))
}

fn stop_code(stop: ZoomStop) -> f64 {
    match stop {
        ZoomStop::Fit => 0.0,
        ZoomStop::Fill => 1.0,
        ZoomStop::ActualSize => 2.0,
    }
}

fn query(model: CanvasZoomModel, which: u32, geometry: Geometry) -> f64 {
    let context = geometry.context();
    match which {
        QUERY_EFFECTIVE_SCALE => context.effective_scale(model.pixel_scale),
        QUERY_FIT_SCALE => context.fit_scale(),
        QUERY_NEXT_STOP => stop_code(next_stop(
            model.current_stop(),
            CanvasZoomModel::badge_stops(&context).as_slice(),
        )),
        _ => f64::NAN,
    }
}

/// The slot count `bridge.cpp` checks its state copy against, so the two
/// sides cannot disagree on the buffer Rust reads and writes.
#[no_mangle]
pub extern "C" fn maple_android_canvas_zoom_state_len() -> usize {
    STATE_LEN
}

/// Applies `op` to the `STATE_LEN`-slot `state` in place. Returns 1 or 0 for
/// the op's boolean result, or -1 (state untouched) for a null `state`, an
/// unknown op, or a caught panic.
///
/// # Safety
/// `state` is null or points to `STATE_LEN` writable, initialised `f64`s that
/// nothing else accesses for the duration of the call.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn maple_android_canvas_zoom(
    state: *mut f64,
    op: u32,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    viewport_width: f64,
    viewport_height: f64,
    image_width: f64,
    image_height: f64,
) -> i32 {
    if state.is_null() {
        return REJECTED;
    }
    // SAFETY: non-null, and the caller guarantees STATE_LEN exclusive f64s.
    let slots = unsafe { &mut *state.cast::<[f64; STATE_LEN]>() };
    let geometry = Geometry::new(viewport_width, viewport_height, image_width, image_height);
    crate::guarded(REJECTED, || {
        Ok(match apply(decode(slots), op, [a, b, c, d], geometry) {
            Some((next, result)) => {
                *slots = encode(&next);
                i32::from(result)
            }
            None => REJECTED,
        })
    })
}

/// Reads `which` (effective scale, fit scale, or the next badge stop as
/// 0 fit / 1 fill / 2 100%) from `state`; NaN for a null `state`, an unknown
/// query, or a caught panic.
///
/// # Safety
/// `state` is null or points to `STATE_LEN` initialised `f64`s.
#[no_mangle]
pub unsafe extern "C" fn maple_android_canvas_zoom_query(
    state: *const f64,
    which: u32,
    viewport_width: f64,
    viewport_height: f64,
    image_width: f64,
    image_height: f64,
) -> f64 {
    if state.is_null() {
        return f64::NAN;
    }
    // SAFETY: non-null, and the caller guarantees STATE_LEN readable f64s.
    let slots = unsafe { &*state.cast::<[f64; STATE_LEN]>() };
    let geometry = Geometry::new(viewport_width, viewport_height, image_width, image_height);
    crate::guarded(f64::NAN, || Ok(query(decode(slots), which, geometry)))
}

#[cfg(test)]
#[path = "canvas_zoom_tests.rs"]
mod tests;
