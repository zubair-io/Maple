//! Corresponding scene-linear samples between overlapping frames, and
//! each frame's usable signal window.
//!
//! This is the shared measurement layer of the photometric solve: the
//! batch and streaming paths both reduce to an [`OverlapSet`], which
//! [`super::fit::fit_pairs`] and [`super::solve`] consume.

use crate::camera::Camera;
use crate::ingest::PlanarImage;

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
        let w = image.width();
        let mut peaks: Vec<f32> = grid(image, stride)
            .map(|(x, y)| {
                let i = (y * w + x) as usize;
                image.r[i].max(image.g[i]).max(image.b[i])
            })
            .filter(|v| v.is_finite())
            .collect();
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
/// its values in frame `i` and frame `j`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct OverlapSample {
    pub value_i: [f32; 3],
    pub value_j: [f32; 3],
}

impl OverlapSample {
    pub fn swapped(self) -> Self {
        Self {
            value_i: self.value_j,
            value_j: self.value_i,
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

fn grid(image: &PlanarImage, stride: u32) -> impl Iterator<Item = (u32, u32)> + '_ {
    let stride = stride.max(1);
    let w = image.width();
    (stride / 2..image.height())
        .step_by(stride as usize)
        .flat_map(move |y| {
            (stride / 2..w)
                .step_by(stride as usize)
                .map(move |x| (x, y))
        })
        .filter(|&(x, y)| image.validity.get(x, y))
}

/// Walk `src`'s strided grid and keep the points that reproject inside
/// `c_dst`, thinned on the grid lattice to at most
/// [`DIRECTION_SAMPLE_CAP`] points so the spatial spread is preserved.
pub(crate) fn pending_points(
    src: &PlanarImage,
    c_src: &Camera,
    c_dst: &Camera,
    stride: u32,
) -> Vec<PendingPoint> {
    let stride = stride.max(1);
    let w = src.width();
    let all: Vec<PendingPoint> = grid(src, stride)
        .filter_map(|(x, y)| {
            let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
            let (qx, qy) = c_dst.world_dir_to_pixel(c_src.pixel_to_world_dir(px, py)?)?;
            let inside = (0.0..=c_dst.width as f64).contains(&qx)
                && (0.0..=c_dst.height as f64).contains(&qy);
            let i = (y * w + x) as usize;
            inside.then_some(PendingPoint {
                pos_src: [px as f32, py as f32],
                value_src: [src.r[i], src.g[i], src.b[i]],
                pos_dst: [qx as f32, qy as f32],
            })
        })
        .collect();
    if all.len() <= DIRECTION_SAMPLE_CAP {
        return all;
    }
    let lattice = (all.len() as f64 / DIRECTION_SAMPLE_CAP as f64)
        .sqrt()
        .ceil() as u32;
    all.into_iter()
        .filter(|p| {
            let gx = p.pos_src[0] as u32 / stride;
            let gy = p.pos_src[1] as u32 / stride;
            gx % lattice == 0 && gy % lattice == 0
        })
        .collect()
}

/// Sample `dst` at each pending point; the source plays frame `i`.
pub(crate) fn resolve_points(points: &[PendingPoint], dst: &PlanarImage) -> Vec<OverlapSample> {
    points
        .iter()
        .filter_map(|p| {
            let value_j = bilinear_valid(dst, p.pos_dst[0] as f64, p.pos_dst[1] as f64)?;
            Some(OverlapSample {
                value_i: p.value_src,
                value_j,
            })
        })
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
