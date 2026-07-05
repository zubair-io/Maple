//! Canonical, platform-agnostic schema types for the raw-core public API.
//!
//! This module holds the structs and enums that Swift and TypeScript mirror
//! by hand today and which future codegen (#118 / #119) will emit from.
//! Importantly, the `types` module itself has no direct I/O dependencies —
//! `xmp.rs` (which pulls in `quick-xml`) imports *from* `types`, never the
//! other way around — so the schema definitions stay isolated from
//! parsing/serialization concerns even though the surrounding crate links
//! `quick-xml` for other modules.

pub mod adjustment;
pub mod inpaint;
pub mod local_adjustment;

pub use adjustment::{
    AdjustmentModel, Crop, FieldKind, FieldSpec, HighlightRecoveryMode, Profile, ToneCurve,
    ToneCurveMode, ToneCurvePoint, WbMethod, WbScaleVersion, WhiteBalancePreset, ADJUSTMENT_SCHEMA,
};
pub use inpaint::{BakeGrade, InpaintPatch, Removal};
pub use local_adjustment::{LocalAdjustment, Mask, PartialAdjustments, Point2};
