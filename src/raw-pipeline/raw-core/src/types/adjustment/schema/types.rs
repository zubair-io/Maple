//! `FieldKind` and `FieldSpec` type definitions — split out of `schema/mod.rs`
//! to stay under the 600-LOC hard budget (#1181).

/// Kind of value carried by an `AdjustmentModel` field, for codegen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldKind {
    /// 32-bit float scalar with a `[min, max]` range and an f32 default.
    F32,
    /// Tagged enum. The `enum_name` slot on [`FieldSpec`] is populated for
    /// this variant; the `range` / `default_f32` slots are meaningless.
    Enum,
}

/// Codegen-facing description of a single `AdjustmentModel` field.
///
/// For `F32` fields: `range` is `(min, max)`, `default_f32` is the
/// raw-core default. For `Enum` fields: `enum_name` is the Rust enum's
/// short type name (e.g. `"HighlightRecoveryMode"`) and the numeric slots
/// are unused (set to `(0.0, 0.0)` / `0.0`).
#[derive(Clone, Copy, Debug)]
pub struct FieldSpec {
    /// Rust identifier on `AdjustmentModel` (snake_case).
    pub name: &'static str,
    /// Field kind: scalar or tagged enum.
    pub kind: FieldKind,
    /// `(min, max)` for `F32`; unused for `Enum`.
    pub range: (f32, f32),
    /// Raw-core default for `F32`; unused for `Enum`.
    pub default_f32: f32,
    /// Short Rust type name for `Enum`; empty for `F32`.
    pub enum_name: &'static str,
    /// Human-readable doc comment, single line.
    pub doc: &'static str,
}
