//! The canvas zoom binding's numbers that Kotlin and C++ share (#5714): the
//! state length, the transition ops, the queries and the badge stop codes.
//! This file is their only definition. Each is a plain literal, so
//! `android-codegen` (run by `tools/codegen.sh`) reads it and emits
//! `generated/CanvasZoomAbi.kt` and `cpp/generated/canvas_zoom_abi.h`; the
//! codegen-drift gate keeps those copies current.

/// Slots in the state array Kotlin owns; `canvas_zoom.rs` lays them out.
pub(crate) const STATE_LEN: usize = 26;

pub(crate) const OP_PINCH_CHANGED: u32 = 0;
pub(crate) const OP_PINCH_ENDED: u32 = 1;
pub(crate) const OP_DRAG_CHANGED: u32 = 2;
pub(crate) const OP_DRAG_ENDED: u32 = 3;
pub(crate) const OP_REBASE_DRAG: u32 = 4;
pub(crate) const OP_DOUBLE_TAP: u32 = 5;
pub(crate) const OP_ADVANCE_STOP: u32 = 6;
pub(crate) const OP_RECLAMP: u32 = 7;
pub(crate) const OP_ADOPT_IMAGE: u32 = 8;
pub(crate) const OP_REBASE_PINCH: u32 = 9;
pub(crate) const OP_REFRAME_IMAGE: u32 = 10;
pub(crate) const OP_SETTLE: u32 = 11;

pub(crate) const QUERY_EFFECTIVE_SCALE: u32 = 0;
pub(crate) const QUERY_FIT_SCALE: u32 = 1;
pub(crate) const QUERY_NEXT_STOP: u32 = 2;

pub(crate) const STOP_FIT: u32 = 0;
pub(crate) const STOP_FILL: u32 = 1;
pub(crate) const STOP_ACTUAL_SIZE: u32 = 2;
