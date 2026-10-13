//! Rotation-path photometry with the blind vignette fallback (#4522):
//! estimate each uncorrected lens group's falloff from the overlap set,
//! flatten the samples, then run the regular affine fit and gain solve.
//! The warp divides the same falloff out of every source tap
//! ([`super::FramePhotometry::apply_at`]).

use super::fit::fit_pairs;
use super::lens::{LensFalloff, LensGroups};
use super::overlap::{OverlapSample, OverlapSet, PairSamples};
use super::solve::solve_from_fits;
use super::vignette::{estimate_falloff, falloff_gain, radius_squared, Correspondence};
use super::{FramePhotometry, GainMode};
use crate::camera::Camera;
use crate::error::PanoError;

/// Per-frame photometry plus the falloff estimated per lens group (empty
/// when every frame was corrected at ingest).
#[derive(Debug, Clone)]
pub struct PhotometrySolution {
    pub frames: Vec<FramePhotometry>,
    pub falloff: Vec<LensFalloff>,
}

/// Fit and solve photometry over `set`, estimating and removing the
/// falloff of uncorrected lens groups first. Report frame indices are
/// positions in `set`.
pub(crate) fn solve_with_falloff(
    set: &OverlapSet,
    cameras: &[Camera],
    lenses: &LensGroups,
    mode: GainMode,
) -> Result<PhotometrySolution, PanoError> {
    if lenses.of_frame.len() != set.windows.len() {
        return Err(PanoError::InvalidOptions(format!(
            "photometry: {} lens assignments for {} frames",
            lenses.of_frame.len(),
            set.windows.len()
        )));
    }
    if !lenses.any() {
        return Ok(PhotometrySolution {
            frames: solve_from_fits(set, &fit_pairs(set, mode), mode)?,
            falloff: Vec::new(),
        });
    }
    let dims: Vec<(f64, f64)> = cameras
        .iter()
        .map(|c| (c.width as f64, c.height as f64))
        .collect();
    let fits = estimate_falloff(
        &correspondences(set, &dims),
        &lenses.of_frame,
        lenses.labels.len(),
    );
    let q_of_frame = lenses.q_of_frame(&fits);
    let flat = flatten(set, &dims, &q_of_frame);
    let frames = solve_from_fits(&flat, &fit_pairs(&flat, mode), mode)?
        .into_iter()
        .zip(&q_of_frame)
        .map(|(p, q)| FramePhotometry {
            falloff_q: *q as f32,
            ..p
        })
        .collect();
    let all: Vec<usize> = (0..lenses.of_frame.len()).collect();
    Ok(PhotometrySolution {
        frames,
        falloff: lenses.report(&fits, &all),
    })
}

/// Usable samples (inside both signal windows) as channel-mean log ratios.
fn correspondences(set: &OverlapSet, dims: &[(f64, f64)]) -> Vec<Correspondence> {
    let mean = |v: [f32; 3]| (v[0] + v[1] + v[2]) / 3.0;
    set.pairs
        .iter()
        .flat_map(|p| {
            let (wi, wj) = (set.windows[p.i], set.windows[p.j]);
            let ((w_i, h_i), (w_j, h_j)) = (dims[p.i], dims[p.j]);
            p.samples.iter().filter_map(move |s| {
                let (a, b) = (mean(s.value_i), mean(s.value_j));
                let usable = wi.unclipped(s.value_i)
                    && wj.unclipped(s.value_j)
                    && a >= wi.floor()
                    && b >= wj.floor()
                    && a > 0.0
                    && b > 0.0;
                usable.then(|| Correspondence {
                    i: p.i,
                    j: p.j,
                    r2_i: radius_squared(s.pos_i[0] as f64, s.pos_i[1] as f64, w_i, h_i),
                    r2_j: radius_squared(s.pos_j[0] as f64, s.pos_j[1] as f64, w_j, h_j),
                    log_ratio: (b as f64 / a as f64).ln(),
                })
            })
        })
        .collect()
}

/// Divide each frame's falloff out of its overlap samples. Signal windows
/// stay as measured: a corrected value pushed past clip is dropped by the
/// fit, which only costs samples.
fn flatten(set: &OverlapSet, dims: &[(f64, f64)], q_of_frame: &[f64]) -> OverlapSet {
    let gain = |f: usize, pos: [f32; 2]| {
        let (w, h) = dims[f];
        falloff_gain(
            q_of_frame[f],
            radius_squared(pos[0] as f64, pos[1] as f64, w, h),
        ) as f32
    };
    OverlapSet {
        windows: set.windows.clone(),
        pairs: set
            .pairs
            .iter()
            .map(|p| PairSamples {
                i: p.i,
                j: p.j,
                samples: p
                    .samples
                    .iter()
                    .map(|s| OverlapSample {
                        value_i: s.value_i.map(|v| v * gain(p.i, s.pos_i)),
                        value_j: s.value_j.map(|v| v * gain(p.j, s.pos_j)),
                        ..*s
                    })
                    .collect(),
            })
            .collect(),
    }
}
