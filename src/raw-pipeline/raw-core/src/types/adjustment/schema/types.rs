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
    /// User-authored point curve ([`crate::types::ToneCurve`]) — an ordered
    /// list of `(x, y)` control points in the curve editor's `[0, 1]`
    /// authoring domain (#366). The `range` / `default_f32` / `enum_name`
    /// slots are unused: the only curve type is `ToneCurve` and its
    /// canonical default is the identity (empty) curve on every platform.
    ///
    /// Codegen emits the *field references* for this kind (the Swift
    /// `FieldName` case, the TS interface member, and the TS default-factory
    /// entry); the `ToneCurve` value type itself is hand-written on each
    /// platform — `ToneCurve.swift` on Apple, `models/adjustment-model.ts`
    /// on Web — the same split the hand-written `Crop` type uses.
    ToneCurve,
}

/// Codegen-facing description of a single `AdjustmentModel` field.
///
/// For `F32` fields: `range` is `(min, max)`, `default_f32` is the
/// raw-core default. For `Enum` fields: `enum_name` is the Rust enum's
/// short type name (e.g. `"HighlightRecoveryMode"`) and the numeric slots
/// are unused (set to `(0.0, 0.0)` / `0.0`). For `ToneCurve` fields every
/// slot but `name` / `kind` / `doc` is unused — the type is always
/// `ToneCurve` and the default is always the identity curve.
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
