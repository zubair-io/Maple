//! Canvas zoom model for the web shell (#5714): raw-core's `canvas` module,
//! compiled from its own source, behind scalar wasm-bindgen exports.
//!
//! This is a separate, unthreaded module rather than part of the pipeline
//! bundle because the main thread needs it on the first gesture: it has no
//! dependencies beyond `wasm-bindgen`, so it is small, compiles quickly, and
//! owns an ordinary unshared memory instead of the pipeline's shared one.
//! The canvas source has no dependencies of its own, so compiling it here by
//! path is the same code raw-core and the Apple FFI run.
//!
//! The boundary carries only scalars: the host writes its viewport, image
//! extent, display scale and zoom state into a fixed scratch block in linear
//! memory (laid out by [`CanvasSlot`]), calls one transition, and reads the
//! next state back from the same block. Nothing is allocated, boxed or held
//! in Rust between calls.

#[path = "../../raw-core/src/canvas/mod.rs"]
pub mod canvas;

use std::sync::atomic::{AtomicU64, Ordering};

use crate::canvas::{
    CanvasZoomContext, CanvasZoomModel, DoubleTapBehavior, Point, Size, WheelIntent, ZoomStop,
};
use wasm_bindgen::prelude::*;

/// Offsets (in `f64` elements) into the scratch block at
/// [`canvas_scratch_ptr`]. The context comes first, then the zoom state;
/// `Count` is the block length. Flags are stored as `0.0` / `1.0`.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanvasSlot {
    ViewportWidth = 0,
    ViewportHeight = 1,
    NativeWidth = 2,
    NativeHeight = 3,
    DisplayScale = 4,
    PixelScale = 5,
    PanX = 6,
    PanY = 7,
    BasePanX = 8,
    BasePanY = 9,
    HasDragTranslationBase = 10,
    DragTranslationBaseX = 11,
    DragTranslationBaseY = 12,
    HasPinchStartScale = 13,
    PinchStartScale = 14,
    PinchStartPanX = 15,
    PinchStartPanY = 16,
    PinchStartCentroidX = 17,
    PinchStartCentroidY = 18,
    PinchLastCentroidX = 19,
    PinchLastCentroidY = 20,
    PinchStartMagnification = 21,
    PinchLastMagnification = 22,
    HasDragLastTranslation = 23,
    DragLastTranslationX = 24,
    DragLastTranslationY = 25,
    FillsViewport = 26,
    Count = 27,
}

/// Double-tap behaviour per surface.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanvasDoubleTap {
    ResetToFit = 0,
    ToggleFitAnd100 = 1,
}

/// Where a scroll-wheel event over the canvas routes.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanvasWheelIntent {
    Zoom = 0,
    Pan = 1,
    Editing = 2,
}

/// A named zoom stop, or `None` for a free scale.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanvasZoomStop {
    None = 0,
    Fit = 1,
    Fill = 2,
    ActualSize = 3,
}

const SLOT_COUNT: usize = CanvasSlot::Count as usize;

/// Atomic cells only so the static is `Sync` without `unsafe`; every access
/// is `Relaxed` (plain loads and stores on wasm32) and the host reads the
/// same bytes as `f64`.
static SCRATCH: [AtomicU64; SLOT_COUNT] = [const { AtomicU64::new(0) }; SLOT_COUNT];

fn read(slot: CanvasSlot) -> f64 {
    f64::from_bits(SCRATCH[slot as usize].load(Ordering::Relaxed))
}

fn write(slot: CanvasSlot, value: f64) {
    SCRATCH[slot as usize].store(value.to_bits(), Ordering::Relaxed);
}

fn flag(slot: CanvasSlot) -> bool {
    read(slot) != 0.0
}

fn write_flag(slot: CanvasSlot, value: bool) {
    write(slot, if value { 1.0 } else { 0.0 });
}

fn read_size(width: CanvasSlot, height: CanvasSlot) -> Size {
    Size::new(read(width), read(height))
}

fn read_point(x: CanvasSlot, y: CanvasSlot) -> Point {
    Point::new(read(x), read(y))
}

fn write_size(width: CanvasSlot, height: CanvasSlot, size: Size) {
    write(width, size.width);
    write(height, size.height);
}

fn write_point(x: CanvasSlot, y: CanvasSlot, point: Point) {
    write(x, point.x);
    write(y, point.y);
}

fn read_context() -> CanvasZoomContext {
    CanvasZoomContext::new(
        read_size(CanvasSlot::ViewportWidth, CanvasSlot::ViewportHeight),
        read_size(CanvasSlot::NativeWidth, CanvasSlot::NativeHeight),
        read(CanvasSlot::DisplayScale),
    )
}

fn read_model() -> CanvasZoomModel {
    CanvasZoomModel {
        pixel_scale: read(CanvasSlot::PixelScale),
        pan_offset: read_size(CanvasSlot::PanX, CanvasSlot::PanY),
        base_pan: read_size(CanvasSlot::BasePanX, CanvasSlot::BasePanY),
        drag_translation_base: flag(CanvasSlot::HasDragTranslationBase).then(|| {
            read_size(
                CanvasSlot::DragTranslationBaseX,
                CanvasSlot::DragTranslationBaseY,
            )
        }),
        pinch_start_scale: flag(CanvasSlot::HasPinchStartScale)
            .then(|| read(CanvasSlot::PinchStartScale)),
        pinch_start_pan: read_size(CanvasSlot::PinchStartPanX, CanvasSlot::PinchStartPanY),
        pinch_start_centroid: read_point(
            CanvasSlot::PinchStartCentroidX,
            CanvasSlot::PinchStartCentroidY,
        ),
        pinch_last_centroid: read_point(
            CanvasSlot::PinchLastCentroidX,
            CanvasSlot::PinchLastCentroidY,
        ),
        pinch_start_magnification: read(CanvasSlot::PinchStartMagnification),
        pinch_last_magnification: read(CanvasSlot::PinchLastMagnification),
        drag_last_translation: flag(CanvasSlot::HasDragLastTranslation).then(|| {
            read_size(
                CanvasSlot::DragLastTranslationX,
                CanvasSlot::DragLastTranslationY,
            )
        }),
        fills_viewport: flag(CanvasSlot::FillsViewport),
    }
}

fn write_model(model: CanvasZoomModel) {
    write(CanvasSlot::PixelScale, model.pixel_scale);
    write_size(CanvasSlot::PanX, CanvasSlot::PanY, model.pan_offset);
    write_size(CanvasSlot::BasePanX, CanvasSlot::BasePanY, model.base_pan);
    write_flag(
        CanvasSlot::HasDragTranslationBase,
        model.drag_translation_base.is_some(),
    );
    write_size(
        CanvasSlot::DragTranslationBaseX,
        CanvasSlot::DragTranslationBaseY,
        model.drag_translation_base.unwrap_or_default(),
    );
    write_flag(
        CanvasSlot::HasPinchStartScale,
        model.pinch_start_scale.is_some(),
    );
    write(
        CanvasSlot::PinchStartScale,
        model.pinch_start_scale.unwrap_or_default(),
    );
    write_size(
        CanvasSlot::PinchStartPanX,
        CanvasSlot::PinchStartPanY,
        model.pinch_start_pan,
    );
    write_point(
        CanvasSlot::PinchStartCentroidX,
        CanvasSlot::PinchStartCentroidY,
        model.pinch_start_centroid,
    );
    write_point(
        CanvasSlot::PinchLastCentroidX,
        CanvasSlot::PinchLastCentroidY,
        model.pinch_last_centroid,
    );
    write(
        CanvasSlot::PinchStartMagnification,
        model.pinch_start_magnification,
    );
    write(
        CanvasSlot::PinchLastMagnification,
        model.pinch_last_magnification,
    );
    write_flag(
        CanvasSlot::HasDragLastTranslation,
        model.drag_last_translation.is_some(),
    );
    write_size(
        CanvasSlot::DragLastTranslationX,
        CanvasSlot::DragLastTranslationY,
        model.drag_last_translation.unwrap_or_default(),
    );
    write_flag(CanvasSlot::FillsViewport, model.fills_viewport);
}

fn transition(step: impl FnOnce(CanvasZoomModel, &CanvasZoomContext) -> CanvasZoomModel) {
    write_model(step(read_model(), &read_context()));
}

fn handled_transition(
    step: impl FnOnce(CanvasZoomModel, &CanvasZoomContext) -> (CanvasZoomModel, bool),
) -> bool {
    let (next, handled) = step(read_model(), &read_context());
    write_model(next);
    handled
}

fn stop_code(stop: Option<ZoomStop>) -> CanvasZoomStop {
    match stop {
        None => CanvasZoomStop::None,
        Some(ZoomStop::Fit) => CanvasZoomStop::Fit,
        Some(ZoomStop::Fill) => CanvasZoomStop::Fill,
        Some(ZoomStop::ActualSize) => CanvasZoomStop::ActualSize,
    }
}

/// Byte offset of the scratch block in this instance's linear memory
/// (8-byte aligned; `CanvasSlot::Count` `f64` elements).
#[wasm_bindgen]
#[must_use]
pub fn canvas_scratch_ptr() -> usize {
    SCRATCH.as_ptr() as usize
}

/// One pinch frame: `magnification` is cumulative since the pinch began,
/// `(x, y)` the centroid in viewport points from the top-left.
#[wasm_bindgen]
pub fn canvas_zoom_pinch_changed(magnification: f64, x: f64, y: f64) {
    transition(|model, context| model.pinch_changed(magnification, Point::new(x, y), context));
}

/// Pinch release; below fit, or inside a fit or fill detent band, it settles
/// on that stop.
#[wasm_bindgen]
pub fn canvas_zoom_pinch_ended(magnification: f64) {
    transition(|model, context| model.pinch_ended(magnification, context));
}

/// One drag frame, `(x, y)` the translation in points since the drag began.
/// Returns whether the drag panned.
#[wasm_bindgen]
pub fn canvas_zoom_drag_changed(x: f64, y: f64) -> bool {
    handled_transition(|model, context| model.drag_changed(Size::new(x, y), context))
}

/// Drag release. Returns whether a pan was committed.
#[wasm_bindgen]
pub fn canvas_zoom_drag_ended() -> bool {
    handled_transition(|model, _| model.drag_ended())
}

/// Two-finger scroll / wheel pan by `(x, y)` points (positive = image moves
/// right/down) while zoomed.
#[wasm_bindgen]
pub fn canvas_zoom_wheel_pan(x: f64, y: f64) {
    transition(|model, context| model.wheel_pan(Size::new(x, y), context));
}

/// Command-scroll zoom anchored at `(x, y)`; positive deltas zoom in.
#[wasm_bindgen]
pub fn canvas_zoom_wheel_zoom(normalized_delta_y: f64, x: f64, y: f64) {
    transition(|model, context| model.wheel_zoom(normalized_delta_y, Point::new(x, y), context));
}

/// Double-tap / double-click at `(x, y)`.
#[wasm_bindgen]
pub fn canvas_zoom_double_tap(x: f64, y: f64, behavior: CanvasDoubleTap) {
    let behavior = match behavior {
        CanvasDoubleTap::ResetToFit => DoubleTapBehavior::ResetToFit,
        CanvasDoubleTap::ToggleFitAnd100 => DoubleTapBehavior::ToggleFitAnd100,
    };
    transition(|model, context| model.double_tap(Point::new(x, y), behavior, context));
}

/// Fit, centred; a live pinch or drag continues from it.
#[wasm_bindgen]
pub fn canvas_zoom_reset_to_fit() {
    transition(|model, context| model.reset_to_fit(context));
}

/// Explicit zoom target (⌘1 = `1`), clamped and re-centred; a live pinch or
/// drag continues from it.
#[wasm_bindgen]
pub fn canvas_zoom_to_scale(scale: f64) {
    transition(|model, context| model.zoom_to_scale(scale, context));
}

/// Badge tap: the next stop in `fit → fill → 100%`.
#[wasm_bindgen]
pub fn canvas_zoom_advance_stop() {
    transition(|model, context| model.advance_stop(context));
}

/// Zoom-in step anchored at the viewport centre.
#[wasm_bindgen]
pub fn canvas_zoom_step_in() {
    transition(|model, context| model.step_zoom_in(context));
}

/// Zoom-out step anchored at the viewport centre.
#[wasm_bindgen]
pub fn canvas_zoom_step_out() {
    transition(|model, context| model.step_zoom_out(context));
}

/// Re-resolve against fresh geometry (resize, image size landing).
#[wasm_bindgen]
pub fn canvas_zoom_reclamp_pan() {
    transition(|model, context| model.reclamp_pan(context));
}

/// Where a wheel event routes for the current state.
#[wasm_bindgen]
#[must_use]
pub fn canvas_zoom_wheel_intent(command_held: bool) -> CanvasWheelIntent {
    match read_model().wheel_intent(command_held, &read_context()) {
        WheelIntent::Zoom => CanvasWheelIntent::Zoom,
        WheelIntent::Pan => CanvasWheelIntent::Pan,
        WheelIntent::Editing => CanvasWheelIntent::Editing,
    }
}

/// The state's `pixel_scale` with fit resolved (real pixels per image pixel).
#[wasm_bindgen]
#[must_use]
pub fn canvas_zoom_effective_scale() -> f64 {
    read_context().effective_scale(read(CanvasSlot::PixelScale))
}

/// The stop a badge tap would move to.
#[wasm_bindgen]
#[must_use]
pub fn canvas_zoom_next_badge_stop() -> CanvasZoomStop {
    let model = read_model().advance_stop(&read_context());
    stop_code(model.current_stop())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
