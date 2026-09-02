//! Display-referred (post-AgX) tone curves — ticket #2232.
//!
//! A second tone-curve family alongside `stages::tone_curves`, storing
//! Adobe's `crs:ToneCurvePV2012*` (see `docs/xmp-canonical-format.md` §
//! "Tone curves"). The two families are different quantities and run at
//! different points in the pipeline:
//!
//! - `stages::tone_curves` (`papp:SceneLinearToneCurve*`) applies PRE-AgX,
//!   in unbounded scene-linear light, luma-coupled for hue preservation.
//! - This stage applies POST-AgX, in display-linear `[0, 1]` — the exact
//!   range AgX's own Oklab gamut compression guarantees
//!   (`ColorSpace::DisplayLinearRec2020`, per `docs/pipeline.md` § "The
//!   view transform and output", step 1). No rescale is needed: the
//!   curve's `[0, 1]` authoring domain IS the display domain.
//!
//! Position in the pipeline: immediately after `agx`, before `color_grade`
//! (`pipeline::render::render_display_scene` and the per-tick
//! `pipeline::scene_linear_chain`). Both families can carry an authored
//! curve on the same image at once — a Lightroom import keeps its
//! display-referred curve on read-modify-write, while a Maple-only edit
//! typically uses the scene-linear family.
//!
//! Application model: Adobe Camera Raw applies its master (`ToneCurvePV2012`)
//! curve to R, G and B INDEPENDENTLY, evaluating the *same* curve function on
//! each channel — this is the standard photographic "RGB curves" behaviour,
//! not luma-coupled the way Maple's own `tone_curve_luma` is. Reproducing
//! that (rather than inventing a hue-preserving variant) is what "renders in
//! Maple the way it renders in Lightroom" (the ticket's definition of done)
//! requires: a strong PV2012 curve desaturates highlights/shadows slightly,
//! and that IS the target rendering, not a defect. The three per-channel
//! curves (`display_tone_curve_{red,green,blue}`) then apply on top,
//! independently per lane — PV2012 has no ratio-preserving concept the way
//! `tone_curve_mode` does for the scene-linear family.
//!
//! Identity guarantee: this stage is a strict no-op when all four curves are
//! identity (empty). The default `AdjustmentModel` satisfies that, so adding
//! this stage does not perturb the parity harness against the pre-#2232
//! baseline.
//!
//! Curve evaluation reuses `stages::tone_curves`'s Fritsch–Carlson
//! monotonic-cubic-Hermite machinery (`prepare_curve` / `eval_curve_unit`) —
//! the same interpolant, just evaluated directly on `[0, 1]` rather than
//! rescaled to scene `[0, REF_MAX]`. See that module's docs for why
//! monotonic-cubic (not natural-cubic / Catmull-Rom) is load-bearing for a
//! tone curve.

use crate::{
    image::{ColorSpace, Image},
    stages::tone_curves::{eval_curve_unit, prepare_curve, PreparedCurve},
    xmp::AdjustmentModel,
};

/// Apply the display-referred point curves. Must run POST-AgX — the stage
/// asserts `DisplayLinearRec2020` (AgX's own output tag), matching
/// `color_grade::apply`'s assertion at the same chain position.
///
/// Sequencing per channel: the master curve first (evaluated identically on
/// R, G, B — NOT luma-coupled), then that channel's own curve on the
/// result. Each half short-circuits to pass-through when its curve is
/// identity (`eval_curve_unit` on an empty-knot `PreparedCurve` returns `v`
/// unchanged), so a model with only `display_tone_curve_red` authored still
/// leaves G and B touched only by their (absent) own curves.
pub fn apply(img: &mut Image, model: &AdjustmentModel) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);

    let identity = model.display_tone_curve_luma.is_identity()
        && model.display_tone_curve_red.is_identity()
        && model.display_tone_curve_green.is_identity()
        && model.display_tone_curve_blue.is_identity();
    if identity {
        return;
    }

    // Prepare once — the knots and their Fritsch–Carlson tangents are
    // computed here, not per-pixel. An identity curve prepares to a 0-knot
    // `PreparedCurve`, which `eval_curve_unit` treats as pass-through, so
    // preparing all four unconditionally (rather than branching per-curve)
    // keeps the per-pixel loop uniform with no extra allocation.
    let master = prepare_curve(&model.display_tone_curve_luma);
    let red = prepare_curve(&model.display_tone_curve_red);
    let green = prepare_curve(&model.display_tone_curve_green);
    let blue = prepare_curve(&model.display_tone_curve_blue);

    for p in &mut img.pixels {
        p[0] = eval_channel(&master, &red, p[0]);
        p[1] = eval_channel(&master, &green, p[1]);
        p[2] = eval_channel(&master, &blue, p[2]);
    }
}

/// One channel lane: the master curve, then this channel's own curve, both
/// via [`eval_curve_unit`] (identity curves pass their input straight
/// through). Split out so the per-pixel loop above reads as three identical
/// lines and so [`eval_channel`] itself is unit-testable in isolation.
#[inline]
fn eval_channel(master: &PreparedCurve, channel: &PreparedCurve, v: f32) -> f32 {
    eval_curve_unit(channel, eval_curve_unit(master, v))
}

#[cfg(test)]
mod tests;
