//! The shared canvas zoom model (`raw_core::canvas`, #5714) for the Compose
//! canvas. Kotlin owns the state as a `STATE_LEN`-slot `double[]` and passes
//! it into each transition, so Rust holds nothing between gesture frames and
//! the per-event path never allocates. Canvas units are Compose pixels: the
//! viewport and image extents go in as pixels with a display scale of 1.

use raw_core::canvas::{
    anchored_pan, next_stop, CanvasZoomContext, CanvasZoomModel, DoubleTapBehavior, Point, Size,
    ZoomStop, MAX_PIXEL_SCALE,
};

/// Slots holding the shared model; the layout is `encode`'s.
const MODEL_SLOTS: usize = 17;
/// The live gesture's last cumulative input as Kotlin sent it: the pinch
/// magnification (0 when no pinch is in progress) and the drag translation
/// (zero once the drag ends). The model keeps only clamped results, which
/// cannot recover these once a pinch or drag has run into a limit.
const PINCH_MAGNIFICATION_SLOT: usize = MODEL_SLOTS;
const DRAG_TRANSLATION_SLOT: usize = MODEL_SLOTS + 1;
/// Slots in the Kotlin state array.
const STATE_LEN: usize = MODEL_SLOTS + 3;

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

fn encode(model: &CanvasZoomModel) -> [f64; MODEL_SLOTS] {
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
    }
}

/// The live gesture's last cumulative input (see `PINCH_MAGNIFICATION_SLOT`).
#[derive(Clone, Copy, Debug, PartialEq)]
struct LiveGesture {
    pinch_magnification: f64,
    drag_translation: Size,
}

impl LiveGesture {
    fn read(state: &[f64; STATE_LEN]) -> Self {
        Self {
            pinch_magnification: state[PINCH_MAGNIFICATION_SLOT],
            drag_translation: Size::new(
                state[DRAG_TRANSLATION_SLOT],
                state[DRAG_TRANSLATION_SLOT + 1],
            ),
        }
    }

    fn write(self, state: &mut [f64; STATE_LEN]) {
        state[PINCH_MAGNIFICATION_SLOT] = self.pinch_magnification;
        state[DRAG_TRANSLATION_SLOT] = self.drag_translation.width;
        state[DRAG_TRANSLATION_SLOT + 1] = self.drag_translation.height;
    }

    /// The input to keep after `op` (first arguments `a`, `b`) produced
    /// `next`: the latest values Kotlin sent while each gesture is live. At
    /// fit nothing pans, so the translation is not kept and fit stays the
    /// all-zero state.
    fn after(self, op: u32, a: f64, b: f64, next: &CanvasZoomModel) -> Self {
        let pinch_magnification = match (next.pinch_start_scale, op) {
            (None, _) => 0.0,
            (Some(_), OP_PINCH_CHANGED) if a.is_finite() => a,
            (Some(_), _) => self.pinch_magnification,
        };
        let translation = Size::new(a, b);
        let drag_translation = match op {
            _ if !next.is_zoomed_in() => Size::ZERO,
            OP_DRAG_ENDED => Size::ZERO,
            OP_DRAG_CHANGED | OP_REBASE_DRAG if translation.is_finite() => translation,
            _ => self.drag_translation,
        };
        Self {
            pinch_magnification,
            drag_translation,
        }
    }
}

/// Carries the zoom across the image extent changing under it (a placeholder
/// size replaced by the original's): a free scale keeps its on-screen size,
/// a named stop keeps its meaning (100% stays 1:1, fill re-resolves), and the
/// image point under `anchor` (viewport pixels) stays as close as the pan
/// clamp allows.
fn adopt_image_size(
    model: CanvasZoomModel,
    anchor: Point,
    previous: &CanvasZoomContext,
    next: &CanvasZoomContext,
) -> CanvasZoomModel {
    if !model.is_zoomed_in() {
        return model;
    }
    let start_scale = previous.effective_scale(model.pixel_scale);
    let scale = match model.current_stop() {
        Some(ZoomStop::Fill) => next.fill_scale(),
        Some(ZoomStop::Fit | ZoomStop::ActualSize) => model.pixel_scale,
        None => (start_scale * next.fit_scale() / previous.fit_scale()).min(MAX_PIXEL_SCALE),
    };
    let pan = anchored_pan(
        anchor,
        next.viewport_points(),
        model.pan_offset,
        start_scale * previous.native_image_size().width,
        next.effective_scale(scale) * next.native_image_size().width,
    );
    CanvasZoomModel {
        pixel_scale: scale,
        pan_offset: pan,
        base_pan: pan,
        ..model
    }
    .reclamp_pan(next)
}

/// Re-anchors a live gesture's captures on a zoom that changed under it
/// (adoption or a viewport change), so the gesture's next frame with the same
/// cumulative input reproduces that zoom and then continues from it. A drag's
/// committed pan absorbs the translation so far; a pinch restarts at its last
/// centroid with its magnification so far, as if it had begun on the new zoom.
fn recapture_live_gesture(
    model: CanvasZoomModel,
    live: LiveGesture,
    context: &CanvasZoomContext,
) -> CanvasZoomModel {
    let drag_base = model.drag_translation_base.unwrap_or(Size::ZERO);
    let dragged = Size::new(
        live.drag_translation.width - drag_base.width,
        live.drag_translation.height - drag_base.height,
    );
    let rebased = if model.is_zoomed_in() {
        CanvasZoomModel {
            base_pan: Size::new(
                model.pan_offset.width - dragged.width,
                model.pan_offset.height - dragged.height,
            ),
            ..model
        }
    } else {
        model
    };
    let magnification = live.pinch_magnification;
    if rebased.pinch_start_scale.is_none() || !magnification.is_finite() || magnification <= 0.0 {
        return rebased;
    }
    let centroid = rebased.pinch_last_centroid;
    let viewport = context.viewport_points();
    let offset = Size::new(
        centroid.x - viewport.width / 2.0,
        centroid.y - viewport.height / 2.0,
    );
    CanvasZoomModel {
        pinch_start_scale: Some(context.effective_scale(rebased.pixel_scale) / magnification),
        pinch_start_centroid: centroid,
        pinch_start_pan: Size::new(
            offset.width - (offset.width - rebased.pan_offset.width) / magnification,
            offset.height - (offset.height - rebased.pan_offset.height) / magnification,
        ),
        ..rebased
    }
}

/// `next` with any live gesture re-anchored on it when `next` changed the
/// zoom out from under the gesture (see `recapture_live_gesture`).
fn keeping_live_gesture(
    model: CanvasZoomModel,
    next: CanvasZoomModel,
    live: LiveGesture,
    context: &CanvasZoomContext,
) -> CanvasZoomModel {
    if next == model {
        next
    } else {
        recapture_live_gesture(next, live, context)
    }
}

/// One transition; returns the next model and the op's boolean result
/// (drag consumed / pan committed; `true` for ops without one), or `None` for
/// an unknown op.
fn apply(
    model: CanvasZoomModel,
    op: u32,
    args: [f64; 4],
    live: LiveGesture,
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
        OP_RECLAMP => keeping_live_gesture(model, model.reclamp_pan(&context), live, &context),
        OP_ADOPT_IMAGE => {
            let previous = Geometry {
                image: Size::new(a, b),
                ..geometry
            };
            let adopted = adopt_image_size(model, Point::new(c, d), &previous.context(), &context);
            recapture_live_gesture(adopted, live, &context)
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
        let live = LiveGesture::read(slots);
        Ok(
            match apply(decode(slots), op, [a, b, c, d], live, geometry) {
                Some((next, result)) => {
                    slots[..MODEL_SLOTS].copy_from_slice(&encode(&next));
                    live.after(op, a, b, &next).write(slots);
                    i32::from(result)
                }
                None => REJECTED,
            },
        )
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

#[cfg(test)]
#[path = "canvas_zoom_live_tests.rs"]
mod live_tests;
