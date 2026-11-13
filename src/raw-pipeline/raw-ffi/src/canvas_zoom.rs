//! Canvas zoom-model FFI (#5714) over `raw_core::canvas`. The host keeps a
//! `MapleCanvasZoomState` value and passes it through each transition, which
//! returns the next state. Values only — no pointers, no allocation, no
//! per-tick state held in Rust — so a call per gesture frame is cheap.
//!
//! Double-tap behaviour travels as `MAPLE_CANVAS_DOUBLE_TAP_*` (an unknown
//! code resets to fit) and intents as `MAPLE_CANVAS_*_INTENT_*`. The
//! stateless rules and the stop codes are in `canvas_zoom_rules.rs`, the
//! visible-area queries in `canvas_zoom_insets.rs`, the transitions that keep
//! live gestures continuous in `canvas_zoom_continuity.rs`.

use crate::canvas_math::{MapleCanvasPoint, MapleCanvasSize};
use crate::canvas_zoom_rules::{stop_code, MAPLE_CANVAS_ZOOM_STOP_NONE};
use raw_core::canvas::{
    self, CanvasZoomContext, CanvasZoomModel, DoubleTapBehavior, DragIntent, WheelIntent,
};

pub use crate::canvas_zoom_insets::MapleCanvasInsets;

pub const MAPLE_CANVAS_DOUBLE_TAP_RESET_TO_FIT: u32 = 0;
pub const MAPLE_CANVAS_DOUBLE_TAP_TOGGLE_FIT_AND_100: u32 = 1;

pub const MAPLE_CANVAS_DRAG_INTENT_EDITING: u32 = 0;
pub const MAPLE_CANVAS_DRAG_INTENT_PAN: u32 = 1;

pub const MAPLE_CANVAS_WHEEL_INTENT_ZOOM: u32 = 0;
pub const MAPLE_CANVAS_WHEEL_INTENT_PAN: u32 = 1;
pub const MAPLE_CANVAS_WHEEL_INTENT_EDITING: u32 = 2;

/// The shared zoom constants, so hosts never restate them.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasConstants {
    pub max_pixel_scale: f64,
    pub min_explicit_zoom: f64,
    pub zoom_step: f64,
    pub detent_tolerance: f64,
    pub min_fit_fraction: f64,
    pub wheel_zoom_sensitivity: f64,
    pub max_texture_edge: f64,
}

/// Viewport (points), image extent (oriented source pixels, zero until
/// known), points→pixels factor and the chrome insets that fit, fill and the
/// centred position resolve inside. Sanitized on every call.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasZoomContext {
    pub viewport_points: MapleCanvasSize,
    pub native_image_size: MapleCanvasSize,
    pub display_scale: f64,
    pub insets: MapleCanvasInsets,
}

/// `raw_core::canvas::CanvasZoomModel` flattened: each `has_*` flag marks
/// whether the optional value after it is set. Flags are `u8` (nonzero =
/// true) so any byte a host sends is a valid value. All-zero is fit mode.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasZoomState {
    pub pixel_scale: f64,
    pub pan_offset: MapleCanvasSize,
    pub base_pan: MapleCanvasSize,
    pub has_drag_translation_base: u8,
    pub drag_translation_base: MapleCanvasSize,
    pub has_pinch_start_scale: u8,
    pub pinch_start_scale: f64,
    pub pinch_start_pan: MapleCanvasSize,
    pub pinch_start_centroid: MapleCanvasPoint,
    pub pinch_last_centroid: MapleCanvasPoint,
    pub fills_viewport: u8,
    /// Magnification at the pinch capture; the pinch scales by the ratio of
    /// the live magnification to it (0 reads as 1).
    pub pinch_start_magnification: f64,
    /// Latest pinch magnification, with `pinch_last_centroid` the live pinch
    /// input (0 reads as 1).
    pub pinch_last_magnification: f64,
    pub has_drag_last_translation: u8,
    /// Latest cumulative translation of a live drag.
    pub drag_last_translation: MapleCanvasSize,
}

/// A transition that also reports whether the input was consumed/committed.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MapleCanvasZoomTransition {
    pub state: MapleCanvasZoomState,
    pub handled: bool,
}

impl From<MapleCanvasZoomContext> for CanvasZoomContext {
    fn from(context: MapleCanvasZoomContext) -> Self {
        CanvasZoomContext::new(
            context.viewport_points.into(),
            context.native_image_size.into(),
            context.display_scale,
        )
        .with_insets(context.insets.into())
    }
}

impl From<CanvasZoomContext> for MapleCanvasZoomContext {
    fn from(context: CanvasZoomContext) -> Self {
        Self {
            viewport_points: context.viewport_points().into(),
            native_image_size: context.native_image_size().into(),
            display_scale: context.display_scale(),
            insets: context.insets().into(),
        }
    }
}

impl From<MapleCanvasZoomState> for CanvasZoomModel {
    fn from(state: MapleCanvasZoomState) -> Self {
        CanvasZoomModel {
            pixel_scale: state.pixel_scale,
            pan_offset: state.pan_offset.into(),
            base_pan: state.base_pan.into(),
            drag_translation_base: state
                .has_drag_translation_base
                .ne(&0)
                .then(|| state.drag_translation_base.into()),
            pinch_start_scale: state
                .has_pinch_start_scale
                .ne(&0)
                .then_some(state.pinch_start_scale),
            pinch_start_pan: state.pinch_start_pan.into(),
            pinch_start_centroid: state.pinch_start_centroid.into(),
            pinch_last_centroid: state.pinch_last_centroid.into(),
            pinch_start_magnification: state.pinch_start_magnification,
            pinch_last_magnification: state.pinch_last_magnification,
            drag_last_translation: state
                .has_drag_last_translation
                .ne(&0)
                .then(|| state.drag_last_translation.into()),
            fills_viewport: state.fills_viewport != 0,
        }
    }
}

impl From<CanvasZoomModel> for MapleCanvasZoomState {
    fn from(model: CanvasZoomModel) -> Self {
        Self {
            pixel_scale: model.pixel_scale,
            pan_offset: model.pan_offset.into(),
            base_pan: model.base_pan.into(),
            has_drag_translation_base: u8::from(model.drag_translation_base.is_some()),
            drag_translation_base: model.drag_translation_base.unwrap_or_default().into(),
            has_pinch_start_scale: u8::from(model.pinch_start_scale.is_some()),
            pinch_start_scale: model.pinch_start_scale.unwrap_or_default(),
            pinch_start_pan: model.pinch_start_pan.into(),
            pinch_start_centroid: model.pinch_start_centroid.into(),
            pinch_last_centroid: model.pinch_last_centroid.into(),
            fills_viewport: u8::from(model.fills_viewport),
            pinch_start_magnification: model.pinch_start_magnification,
            pinch_last_magnification: model.pinch_last_magnification,
            has_drag_last_translation: u8::from(model.drag_last_translation.is_some()),
            drag_last_translation: model.drag_last_translation.unwrap_or_default().into(),
        }
    }
}

/// Run `transition` on the decoded state and context; on a panic the host
/// gets its input state back unchanged.
pub(crate) fn zoom_transition(
    entry: &str,
    state: MapleCanvasZoomState,
    context: MapleCanvasZoomContext,
    step: impl FnOnce(CanvasZoomModel, &CanvasZoomContext) -> CanvasZoomModel,
) -> MapleCanvasZoomState {
    crate::error::catch_panic(entry, state, || step(state.into(), &context.into()).into())
}

#[no_mangle]
pub extern "C" fn maple_canvas_constants() -> MapleCanvasConstants {
    crate::error::catch_panic(
        "maple_canvas_constants",
        MapleCanvasConstants::default(),
        || MapleCanvasConstants {
            max_pixel_scale: canvas::MAX_PIXEL_SCALE,
            min_explicit_zoom: canvas::MIN_EXPLICIT_ZOOM,
            zoom_step: canvas::ZOOM_STEP,
            detent_tolerance: canvas::DETENT_TOLERANCE,
            min_fit_fraction: canvas::MIN_FIT_FRACTION,
            wheel_zoom_sensitivity: canvas::WHEEL_ZOOM_SENSITIVITY,
            max_texture_edge: canvas::MAX_TEXTURE_EDGE,
        },
    )
}

/// The context as every other entry sees it (sizes and display scale
/// sanitized), so the host can store exactly what Rust resolves against.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_context_sanitize(
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomContext {
    crate::error::catch_panic("maple_canvas_zoom_context_sanitize", context, || {
        CanvasZoomContext::from(context).into()
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_fit_scale(context: MapleCanvasZoomContext) -> f64 {
    crate::error::catch_panic("maple_canvas_zoom_fit_scale", 1.0, || {
        CanvasZoomContext::from(context).fit_scale()
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_fill_scale(context: MapleCanvasZoomContext) -> f64 {
    crate::error::catch_panic("maple_canvas_zoom_fill_scale", 1.0, || {
        CanvasZoomContext::from(context).fill_scale()
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_min_scale(context: MapleCanvasZoomContext) -> f64 {
    crate::error::catch_panic("maple_canvas_zoom_min_scale", 0.5, || {
        CanvasZoomContext::from(context).min_scale()
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_viewport_px(
    context: MapleCanvasZoomContext,
) -> MapleCanvasSize {
    crate::error::catch_panic(
        "maple_canvas_zoom_viewport_px",
        MapleCanvasSize::default(),
        || CanvasZoomContext::from(context).viewport_px().into(),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_max_pan_offset(
    context: MapleCanvasZoomContext,
    pixel_scale: f64,
) -> MapleCanvasSize {
    crate::error::catch_panic(
        "maple_canvas_zoom_max_pan_offset",
        MapleCanvasSize::default(),
        || {
            CanvasZoomContext::from(context)
                .max_pan_offset(pixel_scale)
                .into()
        },
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_clamped_pan(
    context: MapleCanvasZoomContext,
    pan: MapleCanvasSize,
    pixel_scale: f64,
) -> MapleCanvasSize {
    crate::error::catch_panic(
        "maple_canvas_zoom_clamped_pan",
        MapleCanvasSize::default(),
        || {
            CanvasZoomContext::from(context)
                .clamped_pan(pan.into(), pixel_scale)
                .into()
        },
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_pinch_changed(
    state: MapleCanvasZoomState,
    magnification: f64,
    location: MapleCanvasPoint,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_pinch_changed",
        state,
        context,
        |model, ctx| model.pinch_changed(magnification, location.into(), ctx),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_pinch_ended(
    state: MapleCanvasZoomState,
    magnification: f64,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_pinch_ended",
        state,
        context,
        |model, ctx| model.pinch_ended(magnification, ctx),
    )
}

/// The fingers of a live pinch changed (one lifted or landed): re-anchor so
/// `magnification` at `location` reproduces the frame shown at
/// `shown_magnification` about `shown_location` (#5732).
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_pinch_rebased(
    state: MapleCanvasZoomState,
    shown_magnification: f64,
    shown_location: MapleCanvasPoint,
    magnification: f64,
    location: MapleCanvasPoint,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_pinch_rebased",
        state,
        context,
        |model, ctx| {
            model.pinch_rebased(
                shown_magnification,
                shown_location.into(),
                magnification,
                location.into(),
                ctx,
            )
        },
    )
}

/// `handled` = the drag was consumed as a pan.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_drag_changed(
    state: MapleCanvasZoomState,
    translation: MapleCanvasSize,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomTransition {
    let unchanged = MapleCanvasZoomTransition {
        state,
        handled: false,
    };
    crate::error::catch_panic("maple_canvas_zoom_drag_changed", unchanged, || {
        let (model, consumed) =
            CanvasZoomModel::from(state).drag_changed(translation.into(), &context.into());
        MapleCanvasZoomTransition {
            state: model.into(),
            handled: consumed,
        }
    })
}

/// `handled` = a pan was committed.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_drag_ended(
    state: MapleCanvasZoomState,
) -> MapleCanvasZoomTransition {
    let unchanged = MapleCanvasZoomTransition {
        state,
        handled: false,
    };
    crate::error::catch_panic("maple_canvas_zoom_drag_ended", unchanged, || {
        let (model, committed) = CanvasZoomModel::from(state).drag_ended();
        MapleCanvasZoomTransition {
            state: model.into(),
            handled: committed,
        }
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_rebase_drag_baseline(
    state: MapleCanvasZoomState,
    translation: MapleCanvasSize,
) -> MapleCanvasZoomState {
    crate::error::catch_panic("maple_canvas_zoom_rebase_drag_baseline", state, || {
        CanvasZoomModel::from(state)
            .rebase_drag_baseline(translation.into())
            .into()
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_wheel_pan(
    state: MapleCanvasZoomState,
    delta: MapleCanvasSize,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_wheel_pan",
        state,
        context,
        |model, ctx| model.wheel_pan(delta.into(), ctx),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_wheel_zoom(
    state: MapleCanvasZoomState,
    normalized_delta_y: f64,
    location: MapleCanvasPoint,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_wheel_zoom",
        state,
        context,
        |model, ctx| model.wheel_zoom(normalized_delta_y, location.into(), ctx),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_double_tap(
    state: MapleCanvasZoomState,
    location: MapleCanvasPoint,
    behavior: u32,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    let behavior = match behavior {
        MAPLE_CANVAS_DOUBLE_TAP_TOGGLE_FIT_AND_100 => DoubleTapBehavior::ToggleFitAnd100,
        MAPLE_CANVAS_DOUBLE_TAP_RESET_TO_FIT => DoubleTapBehavior::ResetToFit,
        _ => DoubleTapBehavior::ResetToFit,
    };
    zoom_transition(
        "maple_canvas_zoom_double_tap",
        state,
        context,
        |model, ctx| model.double_tap(location.into(), behavior, ctx),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_reset_to_fit(
    state: MapleCanvasZoomState,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_reset_to_fit",
        state,
        context,
        |model, ctx| model.reset_to_fit(ctx),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_to_scale(
    state: MapleCanvasZoomState,
    scale: f64,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_to_scale",
        state,
        context,
        |model, ctx| model.zoom_to_scale(scale, ctx),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_to_fill(
    state: MapleCanvasZoomState,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition("maple_canvas_zoom_to_fill", state, context, |model, ctx| {
        model.zoom_to_fill(ctx)
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_advance_stop(
    state: MapleCanvasZoomState,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_advance_stop",
        state,
        context,
        |model, ctx| model.advance_stop(ctx),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_step_in(
    state: MapleCanvasZoomState,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition("maple_canvas_zoom_step_in", state, context, |model, ctx| {
        model.step_zoom_in(ctx)
    })
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_step_out(
    state: MapleCanvasZoomState,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_step_out",
        state,
        context,
        |model, ctx| model.step_zoom_out(ctx),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_reclamp_pan(
    state: MapleCanvasZoomState,
    context: MapleCanvasZoomContext,
) -> MapleCanvasZoomState {
    zoom_transition(
        "maple_canvas_zoom_reclamp_pan",
        state,
        context,
        |model, ctx| model.reclamp_pan(ctx),
    )
}

#[no_mangle]
pub extern "C" fn maple_canvas_zoom_current_stop(state: MapleCanvasZoomState) -> u32 {
    crate::error::catch_panic(
        "maple_canvas_zoom_current_stop",
        MAPLE_CANVAS_ZOOM_STOP_NONE,
        || stop_code(CanvasZoomModel::from(state).current_stop()),
    )
}

/// `MAPLE_CANVAS_DRAG_INTENT_*`.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_drag_intent(
    state: MapleCanvasZoomState,
    context: MapleCanvasZoomContext,
) -> u32 {
    crate::error::catch_panic(
        "maple_canvas_zoom_drag_intent",
        MAPLE_CANVAS_DRAG_INTENT_EDITING,
        || match CanvasZoomModel::from(state).drag_intent(&context.into()) {
            DragIntent::Editing => MAPLE_CANVAS_DRAG_INTENT_EDITING,
            DragIntent::Pan => MAPLE_CANVAS_DRAG_INTENT_PAN,
        },
    )
}

/// `MAPLE_CANVAS_WHEEL_INTENT_*`.
#[no_mangle]
pub extern "C" fn maple_canvas_zoom_wheel_intent(
    state: MapleCanvasZoomState,
    command_held: u8,
    context: MapleCanvasZoomContext,
) -> u32 {
    crate::error::catch_panic(
        "maple_canvas_zoom_wheel_intent",
        MAPLE_CANVAS_WHEEL_INTENT_EDITING,
        || match CanvasZoomModel::from(state).wheel_intent(command_held != 0, &context.into()) {
            WheelIntent::Zoom => MAPLE_CANVAS_WHEEL_INTENT_ZOOM,
            WheelIntent::Pan => MAPLE_CANVAS_WHEEL_INTENT_PAN,
            WheelIntent::Editing => MAPLE_CANVAS_WHEEL_INTENT_EDITING,
        },
    )
}

#[cfg(test)]
#[path = "canvas_zoom_tests.rs"]
mod tests;
