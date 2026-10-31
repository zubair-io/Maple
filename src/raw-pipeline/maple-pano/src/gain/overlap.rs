//! Corresponding scene-linear samples between overlapping frames, and
//! each frame's usable signal window.
//!
//! This is the shared measurement layer of the photometric solve: the
//! batch and streaming paths both reduce to an [`OverlapSet`], which
//! [`super::fit::fit_pairs`] and [`super::solve`] consume. Every sample
//! keeps its source-pixel position in both frames for the blind vignette
//! estimate ([`super::vignette`]).

use std::ops::Range;

use crate::camera::Camera;
use crate::frame_store::SourceView;
use crate::ingest::PlanarImage;
use crate::math::Vec3;

use super::bilinear_valid;

/// ICE's display-domain sample window `[0.025, 0.95)`, decoded from sRGB
/// to linear light and taken as fractions of each frame's own white
/// level (`0.025 / 12.92` and `((0.95 + 0.055) / 1.055)^2.4`).
const FLOOR_FRACTION: f32 = 0.025 / 12.92;
const CLIP_FRACTION: f32 = 0.89;

/// Quantile of per-pixel peak channel taken as the frame's white level.
/// High enough to land on a clipped plateau covering ≥0.5% of the
/// frame; on an unclipped frame it is the brightest content, where
/// trimming the top of the window costs only a sliver of samples.
const WHITE_QUANTILE: f64 = 0.995;

/// Per-direction sample cap per pair. Bounds memory on the streaming
/// path and stays well above the 3000-sample edge-weight saturation.
pub(crate) const DIRECTION_SAMPLE_CAP: usize = 4096;

/// A frame's usable signal range in its own linear units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SignalWindow {
    pub white: f32,
}

impl SignalWindow {
    pub fn measure(image: &PlanarImage, stride: u32) -> Self {
        let view = SourceView::whole(image);
        Self::from_peaks(
            grid_values(view, stride, 0..image.height())
                .filter_map(|(_, v)| finite_peak(v))
                .collect(),
        )
    }

    /// The window of a frame whose finite grid-point peaks are `peaks`, in
    /// grid order.
    pub fn from_peaks(mut peaks: Vec<f32>) -> Self {
        if peaks.is_empty() {
            return Self { white: 0.0 };
        }
        let k = ((peaks.len() - 1) as f64 * WHITE_QUANTILE).round() as usize;
        let (_, white, _) = peaks.select_nth_unstable_by(k, f32::total_cmp);
        Self {
            white: white.max(0.0),
        }
    }

    pub fn floor(&self) -> f32 {
        self.white * FLOOR_FRACTION
    }

    pub fn clip(&self) -> f32 {
        self.white * CLIP_FRACTION
    }

    /// No channel near clip: highlight recovery synthesizes clipped
    /// channels from the others, so every channel of such a pixel is
    /// suspect.
    pub fn unclipped(&self, v: [f32; 3]) -> bool {
        v.iter().all(|c| *c < self.clip())
    }
}

/// One geometrically corresponding point of the `(i, j)` overlap:
/// values and source-pixel positions in frame `i` and frame `j`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct OverlapSample {
    pub value_i: [f32; 3],
    pub value_j: [f32; 3],
    pub pos_i: [f32; 2],
    pub pos_j: [f32; 2],
}

impl OverlapSample {
    pub fn swapped(self) -> Self {
        Self {
            value_i: self.value_j,
            value_j: self.value_i,
            pos_i: self.pos_j,
            pos_j: self.pos_i,
        }
    }
}

/// All samples of one overlapping pair, `i < j`.
#[derive(Debug, Clone)]
pub(crate) struct PairSamples {
    pub i: usize,
    pub j: usize,
    pub samples: Vec<OverlapSample>,
}

/// Everything the photometric solve measures from the frames.
#[derive(Debug, Clone)]
pub(crate) struct OverlapSet {
    pub windows: Vec<SignalWindow>,
    pub pairs: Vec<PairSamples>,
}

impl OverlapSet {
    /// Median frame white: the scale that makes fit residuals, the
    /// noise floor and bias limits comparable across scenes.
    pub fn reference_white(&self) -> f64 {
        let mut whites: Vec<f32> = self
            .windows
            .iter()
            .map(|w| w.white)
            .filter(|w| *w > 0.0)
            .collect();
        if whites.is_empty() {
            return 1.0;
        }
        let mid = whites.len() / 2;
        let (_, median, _) = whites.select_nth_unstable_by(mid, f32::total_cmp);
        *median as f64
    }
}

/// A source grid point that lands inside the destination camera,
/// awaiting the destination's pixels.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PendingPoint {
    pub pos_src: [f32; 2],
    pub value_src: [f32; 3],
    pub pos_dst: [f32; 2],
}

/// A grid point's peak channel, `None` when it is not finite.
pub(crate) fn finite_peak(v: [f32; 3]) -> Option<f32> {
    Some(v[0].max(v[1]).max(v[2])).filter(|p| p.is_finite())
}

/// Valid points of the strided grid on frame rows `rows`, in raster order,
/// with their values; `view` holds at least those rows.
pub(crate) fn grid_values(
    view: SourceView<'_>,
    stride: u32,
    rows: Range<u32>,
) -> impl Iterator<Item = ((u32, u32), [f32; 3])> + '_ {
    let stride = stride.max(1);
    let (w, _) = view.frame_dims();
    let px = view.pixels();
    let first = rows.start.saturating_sub(stride / 2).div_ceil(stride) * stride + stride / 2;
    (first..rows.end)
        .step_by(stride as usize)
        .flat_map(move |y| {
            (stride / 2..w as u32)
                .step_by(stride as usize)
                .map(move |x| (x, y))
        })
        .filter_map(move |(x, y)| {
            view.valid_index(i64::from(x), i64::from(y))
                .map(|i| ((x, y), [px.r[i], px.g[i], px.b[i]]))
        })
}

/// The world direction through the centre of grid pixel `(x, y)` of `c_src`.
pub(crate) fn grid_dir((x, y): (u32, u32), c_src: &Camera) -> Option<Vec3> {
    c_src.pixel_to_world_dir(x as f64 + 0.5, y as f64 + 0.5)
}

/// The grid point at `(x, y)` with value `value_src`, looking along `dir`
/// (its [`grid_dir`]), if it reprojects inside `c_dst`.
pub(crate) fn pending_point(
    (x, y): (u32, u32),
    value_src: [f32; 3],
    dir: Vec3,
    c_dst: &Camera,
) -> Option<PendingPoint> {
    let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
    let (qx, qy) = c_dst.world_dir_to_pixel(dir)?;
    let inside =
        (0.0..=c_dst.width as f64).contains(&qx) && (0.0..=c_dst.height as f64).contains(&qy);
    inside.then_some(PendingPoint {
        pos_src: [px as f32, py as f32],
        value_src,
        pos_dst: [qx as f32, qy as f32],
    })
}

/// Thin a grid-ordered point list on the grid lattice to at most
/// [`DIRECTION_SAMPLE_CAP`] points, so the spatial spread is preserved.
pub(crate) fn thin_points(all: Vec<PendingPoint>, stride: u32) -> Vec<PendingPoint> {
    if all.len() <= DIRECTION_SAMPLE_CAP {
        return all;
    }
    let lattice = thinning_lattice(all.len());
    // The filter collects in place, so without the shrink the thinned
    // list would keep the unthinned list's capacity while it waits.
    let mut kept: Vec<PendingPoint> = all
        .into_iter()
        .filter(|p| on_lattice(p, stride, lattice))
        .collect();
    kept.shrink_to_fit();
    kept
}

/// The lattice [`thin_points`] keeps for a list of `count` points.
pub(crate) fn thinning_lattice(count: usize) -> u32 {
    (count as f64 / DIRECTION_SAMPLE_CAP as f64).sqrt().ceil() as u32
}

/// Whether `lattice` divides both of a point's grid indices.
pub(crate) fn on_lattice(p: &PendingPoint, stride: u32, lattice: u32) -> bool {
    let (gx, gy) = grid_index(p, stride);
    gx % lattice == 0 && gy % lattice == 0
}

/// A point's column and row on its source grid.
pub(crate) fn grid_index(p: &PendingPoint, stride: u32) -> (u32, u32) {
    let stride = stride.max(1);
    (p.pos_src[0] as u32 / stride, p.pos_src[1] as u32 / stride)
}

/// Walk `src`'s strided grid and keep the points that reproject inside
/// `c_dst`, thinned by [`thin_points`].
pub(crate) fn pending_points(
    src: &PlanarImage,
    c_src: &Camera,
    c_dst: &Camera,
    stride: u32,
) -> Vec<PendingPoint> {
    let all = grid_values(SourceView::whole(src), stride, 0..src.height())
        .filter_map(|(pos, v)| pending_point(pos, v, grid_dir(pos, c_src)?, c_dst))
        .collect();
    thin_points(all, stride)
}

/// Frame row holding the top of `p`'s bilinear stencil in a frame `h` rows
/// tall, clamped into the frame; a view holding that row and the next
/// serves every tap [`resolve_point`] reads.
pub(crate) fn stencil_row(p: &PendingPoint, h: u32) -> u32 {
    ((p.pos_dst[1] as f64 - 0.5).floor() as i64).clamp(0, i64::from(h) - 1) as u32
}

/// Sample `dst` at a pending point; the source plays frame `i`.
pub(crate) fn resolve_point(p: &PendingPoint, dst: SourceView<'_>) -> Option<OverlapSample> {
    let value_j = bilinear_valid(dst, p.pos_dst[0] as f64, p.pos_dst[1] as f64)?;
    Some(OverlapSample {
        value_i: p.value_src,
        value_j,
        pos_i: p.pos_src,
        pos_j: p.pos_dst,
    })
}

/// Sample `dst` at each pending point; the source plays frame `i`.
pub(crate) fn resolve_points(points: &[PendingPoint], dst: &PlanarImage) -> Vec<OverlapSample> {
    points
        .iter()
        .filter_map(|p| resolve_point(p, SourceView::whole(dst)))
        .collect()
}

/// Both sampling directions of a resident `(i, j)` pair.
pub(crate) fn pair_samples(
    fi: &PlanarImage,
    ci: &Camera,
    fj: &PlanarImage,
    cj: &Camera,
    stride: u32,
) -> Vec<OverlapSample> {
    let forward = resolve_points(&pending_points(fi, ci, cj, stride), fj);
    let reverse = resolve_points(&pending_points(fj, cj, ci, stride), fi);
    forward
        .into_iter()
        .chain(reverse.into_iter().map(OverlapSample::swapped))
        .collect()
}
