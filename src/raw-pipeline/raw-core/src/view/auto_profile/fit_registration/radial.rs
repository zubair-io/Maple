//! Bounded radial refinement of an accepted affine registration (#5000).
//!
//! Lens correction leaves a radial residual between the RAW render and the
//! camera JPEG that no affine map expresses. The term is accepted only on
//! geometric evidence — never on colour: fitted on each half of a spatial
//! checkerboard, it must lower the other half's alignment loss against an
//! affine fit on the same half, and both halves must agree on the term.
use super::{
    optimizer::{self, Pixels},
    Gray, Warp,
};

/// Minimum fractional held-out loss reduction over the affine fit.
const HOLD_OUT_GAIN: f64 = 0.02;
/// Maximum disagreement between the two folds' radial terms, relative.
const FOLD_AGREEMENT: f64 = 0.5;

pub(super) fn refine(source: &Gray, target: &Gray, affine: Warp) -> Option<Warp> {
    let edge = source.width.max(source.height);
    let (src, dst) = (source.normalized(edge), target.normalized(edge));
    let folds = [0, 1].map(|fold| {
        let (fit, held_out) = (Pixels::Fold(fold), Pixels::Fold(1 - fold));
        let linear = optimizer::stage(&src, &dst, affine, false, fit, held_out)?;
        let radial = optimizer::stage(&src, &dst, affine, true, fit, held_out)?;
        (radial.loss < linear.loss * (1. - HOLD_OUT_GAIN)).then_some(radial.warp.radial)
    });
    let [Some(first), Some(second)] = folds else {
        return None;
    };
    if first * second <= 0.
        || (first - second).abs() > FOLD_AGREEMENT * first.abs().max(second.abs())
    {
        return None;
    }
    let fitted = optimizer::stage(&src, &dst, affine, true, Pixels::All, Pixels::All)?.warp;
    unfolded(fitted).then_some(fitted)
}

fn unfolded(warp: Warp) -> bool {
    (0..=32).all(|j| {
        (0..=32).all(|i| {
            let [a, b, c, d] = warp.jacobian(i as f64 / 32., j as f64 / 32.);
            a * d - b * c > 0.
        })
    })
}
