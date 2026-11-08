//! The shared canvas zoom model (`raw_core::canvas`, #5714) for the Compose
//! canvas. Kotlin owns the state as a `STATE_LEN`-slot `double[]` and passes
//! it into each transition, so Rust holds nothing between gesture frames and
//! the per-event path never allocates. Canvas units are Compose pixels: the
//! viewport and image extents go in as pixels with a display scale of 1.

use raw_core::canvas::{
    anchored_pan, next_stop, CanvasZoomContext, CanvasZoomModel, DoubleTapBehavior, Point, Rect,
    Size, ZoomStop, MAX_PIXEL_SCALE,
};

#[path = "canvas_zoom_abi.rs"]
mod abi;
#[path = "canvas_zoom_live.rs"]
mod live;
#[path = "canvas_zoom_reframe.rs"]
mod reframe;

use abi::*;
use live::{adopt_image_size, continued, rebase_pinch, rebased_for_geometry};
use reframe::{reframe, settle};

/// Slots holding the shared model, including the live gesture's latest input
/// the model re-captures from; the layout is `encode`'s.
const MODEL_SLOTS: usize = 22;
/// The previous call's geometry, so a change can re-capture a live gesture;
/// all zero until the first call that carries one.
const GEOMETRY_SLOT: usize = MODEL_SLOTS;
const _: () = assert!(GEOMETRY_SLOT + 4 == STATE_LEN);

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

    fn read(state: &[f64; STATE_LEN]) -> Option<Self> {
        let stored = Self::new(
            state[GEOMETRY_SLOT],
            state[GEOMETRY_SLOT + 1],
            state[GEOMETRY_SLOT + 2],
            state[GEOMETRY_SLOT + 3],
        );
        (stored != Self::new(0.0, 0.0, 0.0, 0.0)).then_some(stored)
    }

    fn write(self, state: &mut [f64; STATE_LEN]) {
        state[GEOMETRY_SLOT] = self.viewport.width;
        state[GEOMETRY_SLOT + 1] = self.viewport.height;
        state[GEOMETRY_SLOT + 2] = self.image.width;
        state[GEOMETRY_SLOT + 3] = self.image.height;
    }
}

fn flag(value: bool) -> f64 {
    if value {
        1.0
    } else {
        0.0
    }
}

fn encode(model: &CanvasZoomModel) -> [f64; MODEL_SLOTS] {
    let drag_base = model.drag_translation_base.unwrap_or(Size::ZERO);
    let drag_last = model.drag_last_translation.unwrap_or(Size::ZERO);
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
        model.pinch_start_magnification,
        model.pinch_last_magnification,
        flag(model.drag_last_translation.is_some()),
        drag_last.width,
        drag_last.height,
    ]
}

fn decode<const N: usize>(state: &[f64; N]) -> CanvasZoomModel {
    const { assert!(N >= MODEL_SLOTS) };
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
        pinch_start_magnification: state[17],
        pinch_last_magnification: state[18],
        drag_last_translation: (state[19] != 0.0).then(|| Size::new(state[20], state[21])),
    }
}

/// One transition; returns the next model and the op's boolean result
/// (drag consumed / pan committed; `true` for ops without one), or `None` for
/// an unknown op. `stored` is the previous call's geometry.
fn apply(
    model: CanvasZoomModel,
    op: u32,
    args: [f64; 4],
    stored: Option<Geometry>,
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
        OP_REBASE_PINCH => rebase_pinch(model, Point::new(a, b), &context),
        OP_DOUBLE_TAP => model.double_tap(
            Point::new(a, b),
            DoubleTapBehavior::ToggleFitAnd100,
            &context,
        ),
        OP_ADVANCE_STOP => model.advance_stop(&context),
        OP_RECLAMP => continued(model, &context),
        OP_ADOPT_IMAGE => {
            let previous = Geometry {
                image: Size::new(a, b),
                ..geometry
            };
            let adopted = adopt_image_size(model, Point::new(c, d), &previous.context(), &context);
            continued(adopted, &context)
        }
        OP_REFRAME_IMAGE => {
            let reframed = match stored {
                Some(previous) => {
                    reframe(model, Rect::new(a, b, c, d), &previous.context(), &context)
                }
                None => model.reclamp_pan(&context),
            };
            continued(reframed, &context)
        }
        OP_SETTLE => settle(model, &context),
        _ => return None,
    };
    Some((transitioned, true))
}

fn stop_code(stop: ZoomStop) -> f64 {
    f64::from(match stop {
        ZoomStop::Fit => STOP_FIT,
        ZoomStop::Fill => STOP_FILL,
        ZoomStop::ActualSize => STOP_ACTUAL_SIZE,
    })
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
        let stored = Geometry::read(slots);
        let model = rebased_for_geometry(decode(slots), op, stored, geometry);
        Ok(match apply(model, op, [a, b, c, d], stored, geometry) {
            Some((next, result)) => {
                slots[..MODEL_SLOTS].copy_from_slice(&encode(&next));
                if op != OP_DRAG_ENDED {
                    geometry.write(slots);
                }
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
    crate::guarded(f64::NAN, || {
        let stored = Geometry::read(slots);
        let model = rebased_for_geometry(decode(slots), OP_RECLAMP, stored, geometry);
        Ok(query(model, which, geometry))
    })
}

#[cfg(test)]
#[path = "canvas_zoom_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "canvas_zoom_live_tests.rs"]
mod live_tests;

#[cfg(test)]
#[path = "canvas_zoom_rebase_tests.rs"]
mod rebase_tests;

#[cfg(test)]
#[path = "canvas_zoom_reframe_tests.rs"]
mod reframe_tests;
