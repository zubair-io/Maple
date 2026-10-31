//! Refinement read from the frame store in bands of matches (#5563).
//!
//! An edge's matches are grouped by the frame-A row band their seed falls
//! in and the frame-B row band their B seed falls in ([`BAND_ROWS`]), so a
//! band's two windows each span about one band of rows however scattered
//! the edge's B seeds are. For each band, only two rectangles are read: the
//! union in frame A of every template the band samples, and the union in
//! frame B of every search window. Each match then runs the same kernel as
//! [`super::refine_correspondences`] against those windows, bounding taps
//! by the full frame as before, so every refined coordinate is bit-identical
//! while at most one band's windows are resident.

use std::collections::BTreeMap;

use crate::error::PanoError;
use crate::frame_store::{FrameRect, FrameRows, SourceWindow};
use crate::twoview::PixelCorrespondence;

use super::sample::IDENTITY_WARP;
use super::{outcome_of, radii, refine_views, warp, RefineGeometry, RefineOptions, RefineOutcome};

/// Full-resolution rows of each frame whose seeds are refined against one
/// pair of windows.
const BAND_ROWS: f64 = 512.0;

/// Pixels kept beyond each footprint's bilinear stencil, so float drift in
/// the patch-grid walk can never step outside the window.
const SLACK_PX: i64 = 2;

/// Inclusive pixel bounds `(x0, y0, x1, y1)`.
type Bounds = (i64, i64, i64, i64);

/// [`super::refine_correspondences`] for frames `a` and `b` of `frames`,
/// reading one band of windows at a time instead of the whole frames.
/// An `Err` carries the index of the frame whose read failed.
#[allow(clippy::too_many_arguments)] // the frame-store twin of refine_correspondences
pub(crate) fn refine_from_frames(
    frames: &dyn FrameRows,
    a: usize,
    b: usize,
    scale_a: (f64, f64),
    scale_b: (f64, f64),
    geometry: Option<&RefineGeometry<'_>>,
    matches: &[PixelCorrespondence],
    opts: &RefineOptions,
) -> Result<RefineOutcome, (usize, PanoError)> {
    let pair = Pair {
        frames,
        a,
        b,
        dims_a: frames.frame_dims(a).map_err(|e| (a, e))?,
        dims_b: frames.frame_dims(b).map_err(|e| (b, e))?,
        scale_a,
        scale_b,
        geometry,
        opts,
    };
    let row_band = |y: f64, scale: f64| (y * scale / BAND_ROWS).floor() as i64;
    let bands = matches.iter().enumerate().fold(
        BTreeMap::<(i64, i64), Vec<usize>>::new(),
        |mut bands, (k, m)| {
            let key = (row_band(m.a.1, scale_a.1), row_band(m.b.1, scale_b.1));
            bands.entry(key).or_default().push(k);
            bands
        },
    );
    let refined = bands
        .values()
        .map(|members| pair.refine_band(&members.iter().map(|&k| matches[k]).collect::<Vec<_>>()))
        .collect::<Result<Vec<_>, _>>()?;
    let by_index: BTreeMap<usize, _> = bands
        .values()
        .flatten()
        .copied()
        .zip(refined.into_iter().flatten())
        .collect();
    Ok(outcome_of(by_index.into_values().collect()))
}

struct Pair<'a> {
    frames: &'a dyn FrameRows,
    a: usize,
    b: usize,
    dims_a: (u32, u32),
    dims_b: (u32, u32),
    scale_a: (f64, f64),
    scale_b: (f64, f64),
    geometry: Option<&'a RefineGeometry<'a>>,
    opts: &'a RefineOptions,
}

impl Pair<'_> {
    fn refine_band(
        &self,
        band: &[PixelCorrespondence],
    ) -> Result<Vec<(PixelCorrespondence, bool)>, (usize, PanoError)> {
        let (patch_radius, search_radius) = radii(self.scale_b, self.opts);
        let (rect_a, rect_b) = band
            .iter()
            .filter_map(|m| {
                let a_full = (m.a.0 * self.scale_a.0, m.a.1 * self.scale_a.1);
                let b_seed = (m.b.0 * self.scale_b.0, m.b.1 * self.scale_b.1);
                let finite = [a_full.0, a_full.1, b_seed.0, b_seed.1]
                    .iter()
                    .all(|v| v.is_finite());
                finite.then(|| {
                    let jinv = self
                        .geometry
                        .and_then(|g| warp::local_warp_inverse(g, a_full))
                        .unwrap_or(IDENTITY_WARP);
                    (
                        grid_bounds(a_full, patch_radius, &jinv),
                        grid_bounds(b_seed, patch_radius + search_radius, &IDENTITY_WARP),
                    )
                })
            })
            .fold((None, None), |(ua, ub), (fa, fb)| {
                (Some(union(ua, fa)), Some(union(ub, fb)))
            });
        let read = |idx, rect: Option<Bounds>, dims| {
            SourceWindow::read(self.frames, idx, rect.and_then(|r| clip(r, dims)), dims)
                .map_err(|e| (idx, e))
        };
        let window_a = read(self.a, rect_a, self.dims_a)?;
        let window_b = read(self.b, rect_b, self.dims_b)?;
        Ok(refine_views(
            window_a.view(),
            window_b.view(),
            self.scale_a,
            self.scale_b,
            self.geometry,
            band,
            self.opts,
        ))
    }
}

/// Pixels a `(2·half + 1)²` grid at `center + m·(i, j)` reads with its
/// bilinear stencils (`⌊p − ½⌋ ..= ⌊p − ½⌋ + 1` per axis), plus slack.
fn grid_bounds(center: (f64, f64), half: i64, m: &[f64; 4]) -> Bounds {
    let h = half as f64;
    let corners = [(-h, -h), (h, -h), (-h, h), (h, h)].map(|(i, j)| {
        (
            center.0 + m[0] * i + m[1] * j,
            center.1 + m[2] * i + m[3] * j,
        )
    });
    let lo = |c: fn(&(f64, f64)) -> f64| {
        ((corners.iter().map(c).fold(f64::INFINITY, f64::min) - 0.5).floor() as i64)
            .saturating_sub(SLACK_PX)
    };
    let hi = |c: fn(&(f64, f64)) -> f64| {
        ((corners.iter().map(c).fold(f64::NEG_INFINITY, f64::max) - 0.5).floor() as i64)
            .saturating_add(1 + SLACK_PX)
    };
    (lo(|p| p.0), lo(|p| p.1), hi(|p| p.0), hi(|p| p.1))
}

fn union(acc: Option<Bounds>, b: Bounds) -> Bounds {
    acc.map_or(b, |a| {
        (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))
    })
}

fn clip((x0, y0, x1, y1): Bounds, (w, h): (u32, u32)) -> Option<FrameRect> {
    let (x0, y0) = (x0.max(0), y0.max(0));
    let (x1, y1) = (x1.min(i64::from(w) - 1), y1.min(i64::from(h) - 1));
    (x0 <= x1 && y0 <= y1).then(|| FrameRect {
        x0: x0 as u32,
        y0: y0 as u32,
        width: (x1 - x0 + 1) as u32,
        height: (y1 - y0 + 1) as u32,
    })
}

#[cfg(test)]
#[path = "windowed_tests.rs"]
mod tests;
