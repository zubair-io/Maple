//! Canonical, platform-agnostic schema types for the raw-core public API.
//!
//! This module holds the structs and enums that Swift and TypeScript mirror
//! by hand today and which future codegen (#118 / #119) will emit from.
//! Importantly, this module has no I/O dependencies — `xmp.rs` (which pulls
//! in `quick-xml`) imports *from* `types`, never the other way around — so
//! the codegen step can load the schema without dragging in heavy
//! dependencies.

pub mod adjustment;

pub use adjustment::{
    AdjustmentModel, FieldKind, FieldSpec, HighlightRecoveryMode, WhiteBalancePreset,
    ADJUSTMENT_SCHEMA,
};
