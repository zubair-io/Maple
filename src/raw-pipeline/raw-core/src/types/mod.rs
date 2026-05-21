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

pub use adjustment::{
    AdjustmentModel, FieldKind, FieldSpec, HighlightRecoveryMode, WhiteBalancePreset,
    ADJUSTMENT_SCHEMA,
};
