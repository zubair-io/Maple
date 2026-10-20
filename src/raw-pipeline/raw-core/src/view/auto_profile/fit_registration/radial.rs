//! Bounded radial refinement of an accepted affine registration (#5046).
//!
//! Lens correction leaves a radial residual between the RAW render and the
//! camera JPEG that no affine map expresses. The term is accepted only on
//! geometric evidence — never on colour: fitted on each half of the frame
//! (top, bottom, left, right), it must lower the opposite half's alignment
//! loss against an affine fit on the same half, and all four halves must
//! agree on the term, which keystone or projective misfit does not.
use super::{
    optimizer::{self, Pixels},
    Gray, Warp,
};

/// Minimum fractional held-out loss reduction over the affine fit.
const HOLD_OUT_GAIN: f64 = 0.02;
/// Maximum spread of the four halves' radial terms, relative.
const FOLD_AGREEMENT: f64 = 0.5;

pub(super) fn refine(source: &Gray, target: &Gray, affine: Warp) -> Option<Warp> {
    let edge = source.width.max(source.height);
    let (src, dst) = (source.normalized(edge), target.normalized(edge));
    let halves = Pixels::HALVES.map(|fit| {
        let held_out = fit.opposite();
        let linear = optimizer::stage(&src, &dst, affine, false, fit, held_out)?;
        let radial = optimizer::stage(&src, &dst, affine, true, fit, held_out)?;
        (radial.loss < linear.loss * (1. - HOLD_OUT_GAIN)).then_some(radial.warp.radial)
    });
    let terms: Vec<f64> = halves.into_iter().collect::<Option<_>>()?;
    let (low, high) = terms
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), &k| {
            (l.min(k), h.max(k))
        });
    let largest = low.abs().max(high.abs());
    if low * high <= 0. || high - low > FOLD_AGREEMENT * largest {
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
