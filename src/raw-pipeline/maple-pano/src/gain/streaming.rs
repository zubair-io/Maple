//! Memory-bounded streaming photometry solve (#1254, #4517).
//!
//! Sweeps each stored frame once, top to bottom in row bands (#5566), so
//! no full-resolution frame is resident. While frame `k` is swept its
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
use crate::frame_store::{FrameRect, FrameRows, SourceWindow};

use super::falloff::{solve_with_falloff, PhotometrySolution};
use super::forward::ForwardPoints;
use super::lens::LensGroups;
use super::overlap::{
    finite_peak, grid_dir, grid_values, pending_point, resolve_point, stencil_row, OverlapSample,
    OverlapSet, PairSamples, PendingPoint,
};
use super::{frames_may_overlap, validate_options, GainOptions, SignalWindow};

/// Frame rows read per band.
const BAND_ROWS: u32 = 256;

/// Solve per-frame photometry from `frames`, one banded sweep per frame,
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
        let later: Vec<usize> = ((k + 1)..n)
            .filter(|&j| frames_may_overlap(&cameras[k], &cameras[j]))
            .collect();
        let pending = std::mem::take(&mut pending_for_dst[k]);
        let sweep = sweep_frame(frames, k, cameras, &later, &pending, opts.sample_stride)?;
        windows.push(SignalWindow::from_peaks(sweep.peaks));
        for (&j, points) in later.iter().zip(sweep.forward) {
            let points = points.finish();
            if !points.is_empty() {
                pending_for_dst[j].push((k, points));
            }
        }
        pairs.extend(
            pending
                .iter()
                .zip(sweep.resolved)
                .map(|((i, _), samples)| PairSamples {
                    i: *i,
                    j: k,
                    samples: samples.into_iter().flatten().collect(),
                })
                .filter(|p| p.samples.len() >= opts.min_overlap_samples.max(1)),
        );
    }
    Ok(OverlapSet { windows, pairs })
}

/// What one top-to-bottom pass over a frame's row bands measures.
struct Sweep {
    /// Finite grid-point peaks, in grid order.
    peaks: Vec<f32>,
    /// Per frame of `later`, the grid points reprojecting into it, pruned
    /// as they arrive and thinned once the sweep ends, when their count is
    /// known.
    forward: Vec<ForwardPoints>,
    /// Per earlier frame's pending list, each point's sample, index-aligned
    /// (`None` when no valid tap supports it).
    resolved: Vec<Vec<Option<OverlapSample>>>,
}

/// Read frame `k` in bands of [`BAND_ROWS`] rows plus the next row, which
/// every bilinear stencil starting in the band reaches, so no whole frame
/// is resident. Bands run top to bottom, so grid points come out in the
/// same raster order as a whole-frame walk.
fn sweep_frame(
    frames: &dyn FrameRows,
    k: usize,
    cameras: &[Camera],
    later: &[usize],
    pending: &[(usize, Vec<PendingPoint>)],
    stride: u32,
) -> Result<Sweep, PanoError> {
    let dims = frames.frame_dims(k)?;
    let (w, h) = dims;
    let mut sweep = Sweep {
        peaks: Vec::with_capacity(grid_len(w, stride) * grid_len(h, stride)),
        forward: later.iter().map(|_| ForwardPoints::new(stride)).collect(),
        resolved: pending.iter().map(|(_, p)| vec![None; p.len()]).collect(),
    };
    for y0 in (0..h).step_by(BAND_ROWS as usize) {
        let y1 = (y0 + BAND_ROWS).min(h);
        let rect = FrameRect {
            x0: 0,
            y0,
            width: w,
            height: (y1 + 1).min(h) - y0,
        };
        let window = SourceWindow::read(frames, k, Some(rect), dims)?;
        let view = window.view();
        for (pos, v) in grid_values(view, stride, y0..y1) {
            sweep.peaks.extend(finite_peak(v));
            if later.is_empty() {
                continue;
            }
            let Some(dir) = grid_dir(pos, &cameras[k]) else {
                continue;
            };
            for (out, &j) in sweep.forward.iter_mut().zip(later) {
                if let Some(p) = pending_point(pos, v, dir, &cameras[j]) {
                    out.push(p);
                }
            }
        }
        for ((_, points), out) in pending.iter().zip(&mut sweep.resolved) {
            for (p, slot) in points.iter().zip(out) {
                if (y0..y1).contains(&stencil_row(p, h)) {
                    *slot = resolve_point(p, view);
                }
            }
        }
    }
    Ok(sweep)
}

/// Grid positions `stride/2, stride/2 + stride, …` below `len`.
fn grid_len(len: u32, stride: u32) -> usize {
    len.saturating_sub(stride / 2).div_ceil(stride) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame_store::InMemory;
    use crate::gain::overlap::{pending_points, resolve_points};
    use crate::gain::tests::frame_from_scene;
    use crate::prng::SplitMix64;
    use crate::render::{build_camera_set, CameraSetOptions, Pattern};

    /// The overlap set as the whole-frame sweep built it before #5566.
    fn whole_frame_overlap_set(
        frames: &[crate::ingest::PlanarImage],
        cameras: &[Camera],
        stride: u32,
        min_samples: usize,
    ) -> OverlapSet {
        let n = frames.len();
        let mut pending_for_dst: Vec<Vec<(usize, Vec<PendingPoint>)>> = vec![Vec::new(); n];
        let mut windows = Vec::new();
        let mut pairs = Vec::new();
        for (k, img) in frames.iter().enumerate() {
            windows.push(SignalWindow::measure(img, stride));
            for j in (k + 1)..n {
                if frames_may_overlap(&cameras[k], &cameras[j]) {
                    let points = pending_points(img, &cameras[k], &cameras[j], stride);
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
                        samples: resolve_points(&points, img),
                    })
                    .filter(|p| p.samples.len() >= min_samples.max(1)),
            );
        }
        OverlapSet { windows, pairs }
    }

    /// Banded reads build the same overlap set, sample for sample and in
    /// the same order, as whole frames, on frames several bands tall with
    /// invalid and non-finite pixels and thinned and unthinned pairs.
    #[test]
    fn banded_sweep_matches_whole_frame_sweep() {
        let opts = CameraSetOptions {
            count: 4,
            pattern: Pattern::Ring { full: false },
            fov_deg: 50.0,
            overlap: 0.4,
            pitch_deg: 0.0,
            jitter_deg: 4.0,
            k1: 0.0,
            k2: 0.0,
            width: 420,
            height: 700,
        };
        let cameras: Vec<Camera> = build_camera_set(&opts, &mut SplitMix64::new(11))
            .expect("valid")
            .iter()
            .map(|c| c.to_camera())
            .collect();
        let frames: Vec<_> = cameras
            .iter()
            .enumerate()
            .map(|(k, cam)| {
                let mut f = frame_from_scene(cam, [1.0 + 0.1 * k as f32, 1.0, 0.9]);
                for y in [0, 255, 256, 257, 511, 699] {
                    f.validity.set(13 + 7 * k as u32, y, false);
                }
                f.r[(300 * 420 + 40) as usize] = f32::NAN;
                f
            })
            .collect();
        for stride in [1, 4, 7] {
            let gain_opts = GainOptions {
                sample_stride: stride,
                ..GainOptions::default()
            };
            let banded =
                collect_overlap_set_streaming(&InMemory(&frames), &cameras, &gain_opts).unwrap();
            let whole =
                whole_frame_overlap_set(&frames, &cameras, stride, gain_opts.min_overlap_samples);
            assert!(whole.pairs.len() >= 3, "stride {stride}: too few pairs");
            assert_eq!(
                format!("{banded:?}"),
                format!("{whole:?}"),
                "stride {stride}"
            );
        }
    }
}
