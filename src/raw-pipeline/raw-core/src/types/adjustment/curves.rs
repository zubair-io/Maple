//! Tone-curve types attached to `AdjustmentModel`.
//!
//! Maple supports two families of user-authored tone curves (see
//! `docs/maple-paper.md` § 3 "Tone curves"):
//!
//! 1. **Parametric** — four region sliders (`parametric_highlights`,
//!    `parametric_lights`, `parametric_darks`, `parametric_shadows`). Modeled
//!    as f32 scalars on the `AdjustmentModel` directly; the curve evaluator
//!    in `stages::tone_curves` synthesises a piecewise-cubic from those four
//!    plus the canonical PV2012 region split points (¼, ½, ¾ in the curve's
//!    `[0, 1]` authoring domain). Identity when all four are zero.
//!
//! 2. **Per-channel point curves** — four [`ToneCurve`] values
//!    (`tone_curve_luma`, `tone_curve_red`, `tone_curve_green`,
//!    `tone_curve_blue`). Each holds a `Vec` of `(x, y)` control points in
//!    the curve editor's `[0, 1]` authoring domain. The stage maps the
//!    authoring domain to scene-linear `[0, ref_max]` (where `ref_max = 4.0`
//!    covers two stops above diffuse white, per the paper § 4.6) and
//!    evaluates a monotonic-cubic spline (Fritsch–Carlson) between the
//!    control points. The identity curve is the empty `Vec` — interpreted
//!    as "pass-through" so a fresh `AdjustmentModel::default()` is
//!    bit-identical to today's pipeline output.
//!
//! The four `tone_curve_*` FIELDS are described in the
//! [`crate::types::ADJUSTMENT_SCHEMA`] table by the `FieldKind::ToneCurve`
//! variant (#366), so codegen emits the Swift `FieldName` cases and the TS
//! interface members + identity defaults. The [`ToneCurve`] TYPE itself is
//! hand-written on each platform (`ToneCurve.swift` on Apple,
//! `models/adjustment-model.ts` on Web) — the same generated-fields /
//! hand-written-type split the nested [`crate::types::Crop`] uses.

/// A single control point on a [`ToneCurve`]. The pair `(x, y)` lives in
/// the curve editor's `[0, 1]` authoring domain regardless of which family
/// the curve belongs to — the stage that consumes the curve owns the
/// authoring-to-scene-linear mapping. Stored as a tuple (not a struct) to
/// keep the type FFI-trivial and the serialization shape obvious.
pub type ToneCurvePoint = (f32, f32);

/// A user-authored point curve. Control points live in `[0, 1]` x `[0, 1]`
/// in the curve editor's authoring domain and are sorted by `x` at use
/// time (the evaluator does not assume input order).
///
/// **The empty curve is identity**, i.e. `ToneCurve::default()` and any
/// curve created via `ToneCurve::new(vec![])` short-circuits the evaluator
/// to a pass-through. This is the load-bearing invariant for the
/// "baseline pipeline is bit-identical when no user curves are authored"
/// guarantee.
///
/// XMP serialization is `[0, 255]` × `[0, 255]` per the PV2012 spec
/// (see `docs/xmp-canonical-format.md` § "Tone curves"); the round-trip
/// to `[0, 1]` happens at the parser / serializer boundary, not on
/// `ToneCurve` itself. This keeps the in-memory representation independent
/// of the on-wire encoding and matches the way Maple already stores other
/// `crs:`-mirrored fields (e.g. `temperature` in Kelvin, not in the
/// reference renderer's preset string).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToneCurve {
    /// Control points `(x, y)` in `[0, 1]` × `[0, 1]`. May be empty —
    /// empty means "identity / pass-through" and is the canonical default.
    pub points: Vec<ToneCurvePoint>,
}

impl ToneCurve {
    /// Construct from an owned `Vec` of points. No validation here — the
    /// stage clamps + sorts at use time so callers (parsers, codegen,
    /// hand-construction in tests) can build a `ToneCurve` from any
    /// ordering without risking an early-error path.
    pub fn new(points: Vec<ToneCurvePoint>) -> Self {
        Self { points }
    }

    /// `true` when the curve is the identity / pass-through curve. Used by
    /// the evaluator stage's short-circuit on the hot path: a model with
    /// `tone_curve_*` set to the default `ToneCurve::default()` runs the
    /// stage as a pure no-op. See `stages::tone_curves::apply`.
    pub fn is_identity(&self) -> bool {
        self.points.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_identity() {
        let c = ToneCurve::default();
        assert!(c.is_identity());
        assert!(c.points.is_empty());
    }

    #[test]
    fn new_with_empty_vec_is_identity() {
        let c = ToneCurve::new(vec![]);
        assert!(c.is_identity());
    }

    #[test]
    fn new_with_points_is_not_identity() {
        let c = ToneCurve::new(vec![(0.0, 0.0), (0.5, 0.5), (1.0, 1.0)]);
        assert!(!c.is_identity());
        assert_eq!(c.points.len(), 3);
    }

    /// A single-point curve still counts as non-identity. The stage's
    /// behavior on a single point is "constant output at the point's `y`
    /// value"; the model layer does not police that — it just stores what
    /// the user authored.
    #[test]
    fn single_point_is_not_identity() {
        let c = ToneCurve::new(vec![(0.5, 0.7)]);
        assert!(!c.is_identity());
    }
}
