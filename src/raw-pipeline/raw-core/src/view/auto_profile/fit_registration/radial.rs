//! Bounded radial refinement of an accepted affine registration (#5046).
//!
//! Lens correction leaves a radial residual between the RAW render and the
//! camera JPEG that no affine map expresses. The term is accepted only on
//! geometric evidence — never on colour: fitted on each half of the frame
//! (top, bottom, left, right), it must lower the opposite half's alignment
//! loss against an affine fit on the same half for at least one opposite
//! pair, and every half that holds — plus the full-frame fit — must agree on
//! the term, which keystone or projective misfit does not.
use super::{
    optimizer::{self, Pixels},
    Gray, Warp,
};
use rayon::prelude::*;

#[derive(Clone, Copy, PartialEq)]
enum Half {
    Holds(f64),
    Abstains,
    Vetoes,
}

/// Minimum fractional held-out loss reduction over the affine fit.
const HOLD_OUT_GAIN: f64 = 0.02;
/// Maximum spread of the holding halves' and full-frame radial terms, relative.
const FOLD_AGREEMENT: f64 = 0.5;

pub(super) fn refine(source: &Gray, target: &Gray, affine: Warp) -> Option<Warp> {
    let edge = source.width.max(source.height);
    let (src, dst) = (source.normalized(edge), target.normalized(edge));
    let halves: Vec<Half> = Pixels::HALVES
        .par_iter()
        .map(|&fit| {
            let held_out = fit.opposite();
            let fits = optimizer::stage(&src, &dst, affine, false, fit, held_out)
                .zip(optimizer::stage(&src, &dst, affine, true, fit, held_out));
            fits.map_or(Half::Abstains, |(linear, radial)| {
                if radial.loss < linear.loss * (1. - HOLD_OUT_GAIN) {
                    Half::Holds(radial.warp.radial)
                } else if radial.loss > linear.loss {
                    Half::Vetoes
                } else {
                    Half::Abstains
                }
            })
        })
        .collect();
    // A texture-poor half (sky) may abstain, but a half the term makes worse
    // vetoes it, and one opposite pair must hold.
    let pair_holds = |pair: &[Half]| pair.iter().all(|h| matches!(h, Half::Holds(_)));
    if halves.contains(&Half::Vetoes) || !halves.chunks(2).any(pair_holds) {
        return None;
    }
    let fitted = optimizer::stage(&src, &dst, affine, true, Pixels::All, Pixels::All)?.warp;
    let terms: Vec<f64> = halves
        .iter()
        .filter_map(|h| match h {
            Half::Holds(k) => Some(*k),
            _ => None,
        })
        .chain([fitted.radial])
        .collect();
    let (low, high) = terms
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), &k| {
            (l.min(k), h.max(k))
        });
    let largest = low.abs().max(high.abs());
    let agree = low * high > 0. && high - low <= FOLD_AGREEMENT * largest;
    (agree && unfolded(fitted)).then_some(fitted)
}

fn unfolded(warp: Warp) -> bool {
    (0..=32).all(|j| {
        (0..=32).all(|i| {
            let [a, b, c, d] = warp.jacobian(i as f64 / 32., j as f64 / 32.);
            a * d - b * c > 0.
        })
    })
}
