//! Memory-bounded streaming photometry solve (#1254, #4517).
//!
//! Reads each source frame exactly once and keeps at most one
//! full-resolution frame resident. While frame `k` is resident its
//! signal window is measured, its grid points that land in later
//! frames `j > k` are recorded (value, position in both frames — thinned
//! to [`super::overlap::DIRECTION_SAMPLE_CAP`] per pair), and the points
//! earlier frames left pending for `k` are resolved against its pixels.
//! The resulting [`OverlapSet`] goes through the same fit and solve as
//! [`super::solve_photometry`].
//!
//! Only the forward direction per pair is sampled (the reverse would need
//! frame `i` read again), so a pair carries half the batch path's
//! samples — still above the edge-weight saturation on real overlaps.

use crate::camera::Camera;
use crate::error::PanoError;
use crate::frame_store::FrameRows;

use super::falloff::{solve_with_falloff, PhotometrySolution};
use super::lens::LensGroups;
use super::overlap::{pending_points, resolve_points, OverlapSet, PairSamples, PendingPoint};
use super::{frames_may_overlap, validate_options, GainOptions, SignalWindow};

/// Solve per-frame photometry from `frames`, one read per frame,
/// estimating the falloff of every lens group in `lenses` (#4522).
pub fn solve_photometry_streaming(
    frames: &dyn FrameRows,
    cameras: &[Camera],
    lenses: &LensGroups,
    opts: &GainOptions,
) -> Result<PhotometrySolution, PanoError> {
    let set = collect_overlap_set_streaming(frames, cameras, opts)?;
    solve_with_falloff(&set, cameras, lenses, opts.mode)
}

pub(crate) fn collect_overlap_set_streaming(
    frames: &dyn FrameRows,
    cameras: &[Camera],
    opts: &GainOptions,
) -> Result<OverlapSet, PanoError> {
    let n = frames.frame_count();
    if n != cameras.len() {
        return Err(PanoError::InvalidOptions(format!(
            "solve_photometry_streaming: {} frames vs {} cameras",
            n,
            cameras.len()
        )));
    }
    validate_options(opts, "solve_photometry_streaming")?;

    let mut pending_for_dst: Vec<Vec<(usize, Vec<PendingPoint>)>> = vec![Vec::new(); n];
    let mut windows = Vec::with_capacity(n);
    let mut pairs = Vec::new();
    for k in 0..n {
        let img = frames.read_frame(k)?;
        windows.push(SignalWindow::measure(&img, opts.sample_stride));
        for j in (k + 1)..n {
            if frames_may_overlap(&cameras[k], &cameras[j]) {
                let points = pending_points(&img, &cameras[k], &cameras[j], opts.sample_stride);
                if !points.is_empty() {
                    pending_for_dst[j].push((k, points));
                }
            }
        }
        pairs.extend(
            std::mem::take(&mut pending_for_dst[k])
                .into_iter()
                .map(|(i, points)| PairSamples {
                    i,
                    j: k,
                    samples: resolve_points(&points, &img),
                })
                .filter(|p| p.samples.len() >= opts.min_overlap_samples.max(1)),
        );
    }
    Ok(OverlapSet { windows, pairs })
}
