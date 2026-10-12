//! Photometric compensation: per-frame gain plus a small additive bias,
//! solved in **linear** scene light from robust pairwise overlap fits
//! (M2-CPU, #1155; robust photometry #4517; stitching spec §5.5).
//!
//! ## Pipeline
//!
//! 1. [`overlap`]: geometrically corresponding samples for every
//!    overlapping pair (each frame's strided grid reprojected into the
//!    other), and each frame's signal window — samples near the frame's
//!    own white level or below its noise floor are unusable.
//! 2. [`fit`]: a robust affine fit `I_j ≈ a_ij·I_i + d_ij` per pair and
//!    channel slot (IRLS, Huber at 1.5σ, MAD scale), so clipped,
//!    moving or misaligned content does not bias the slope.
//! 3. [`solve`]: log-gain least squares over the pair graph with a weak
//!    prior, gauged to geometric mean 1; then a bias per frame under
//!    those gains with a strong zero-shrinkage prior and a tight clamp,
//!    absorbing only black-level and flare offsets.
//!
//! 4. [`vignette`]: for frames whose ingest corrected no lens falloff, a
//!    shared per-lens radial falloff is estimated jointly with log-gains
//!    and divided out of the samples before steps 2–3 (#4522).
//!
//! The result is folded into the warp ([`crate::warp::warp_to_canvas`]
//! applies `gain·V(r)·v + bias`). On the rotation strategy a coarse
//! per-view [`ExposureField`] then absorbs the smooth residual the global
//! model leaves (#4521, [`field`]).

mod field;
mod field_solve;
pub(crate) mod fit;
pub(crate) mod overlap;
pub(crate) mod solve;
mod streaming;
pub use field::{
    solve_exposure_field, solve_exposure_field_streaming, ExposureField, ExposureFieldSummary,
    CORRIDOR_MARGIN_NODES, MAX_NODES_PER_VIEW,
};
pub(crate) mod vignette;
pub use streaming::solve_photometry_streaming;
pub use vignette::{LensFalloff, LensGroups, PhotometrySolution};

use fit::fit_pairs;
use overlap::{OverlapSet, PairSamples, SignalWindow};
use solve::solve_from_fits;

use rayon::prelude::*;

use crate::camera::Camera;
use crate::error::PanoError;
use crate::ingest::PlanarImage;

/// Gain model (spec §5.5: "per-image scalar gain (optionally
/// per-channel)").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GainMode {
    /// One gain and bias per frame, fit on mean linear intensity
    /// `(R + G + B) / 3`.
    #[default]
    Scalar,
    /// Independent gain and bias per channel.
    PerChannel,
}

/// Options for [`solve_photometry`].
#[derive(Debug, Clone)]
pub struct GainOptions {
    pub mode: GainMode,
    /// Sample-grid stride in source pixels (both axes).
    pub sample_stride: u32,
    /// Pairs with fewer corresponding samples than this are ignored.
    pub min_overlap_samples: usize,
}

impl Default for GainOptions {
    fn default() -> Self {
        Self {
            mode: GainMode::Scalar,
            sample_stride: 4,
            min_overlap_samples: 64,
        }
    }
}

/// Per-frame photometric correction applied in the warp:
/// `corrected = gain · V(r) · value + bias`, per channel, in linear light,
/// where `V(r) = (1 + falloff_q·r²)²` is the blind lens-falloff correction
/// (`falloff_q = 0` for frames corrected at ingest).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FramePhotometry {
    pub gain: [f32; 3],
    pub bias: [f32; 3],
    pub falloff_q: f32,
}

impl FramePhotometry {
    pub const IDENTITY: Self = Self {
        gain: [1.0; 3],
        bias: [0.0; 3],
        falloff_q: 0.0,
    };

    /// Correct a value sampled at source position `(x, y)` of a
    /// `width × height` frame.
    #[inline]
    pub fn apply_at(&self, v: [f32; 3], x: f64, y: f64, width: f64, height: f64) -> [f32; 3] {
        if self.falloff_q == 0.0 {
            return self.apply(v);
        }
        let r2 = vignette::radius_squared(x, y, width, height);
        let falloff = vignette::falloff_gain(self.falloff_q as f64, r2) as f32;
        self.apply(v.map(|c| c * falloff))
    }

    #[inline]
    pub fn apply(&self, v: [f32; 3]) -> [f32; 3] {
        [
            v[0] * self.gain[0] + self.bias[0],
            v[1] * self.gain[1] + self.bias[1],
            v[2] * self.gain[2] + self.bias[2],
        ]
    }
}

impl Default for FramePhotometry {
    fn default() -> Self {
        Self::IDENTITY
    }
}

pub(crate) fn validate_options(opts: &GainOptions, who: &str) -> Result<(), PanoError> {
    if opts.sample_stride == 0 {
        return Err(PanoError::InvalidOptions(format!(
            "{who}: sample_stride must be positive"
        )));
    }
    Ok(())
}

/// Solve per-frame photometry with every frame resident.
///
/// Frames and cameras correspond by index; every frame's dimensions
/// must match its camera's.
pub fn solve_photometry(
    frames: &[PlanarImage],
    cameras: &[Camera],
    opts: &GainOptions,
) -> Result<Vec<FramePhotometry>, PanoError> {
    let set = collect_overlap_set(frames, cameras, opts)?;
    solve_from_fits(&set, &fit_pairs(&set, opts.mode), opts.mode)
}

/// Measure the overlap set of resident frames (both sampling
/// directions per pair).
pub(crate) fn collect_overlap_set(
    frames: &[PlanarImage],
    cameras: &[Camera],
    opts: &GainOptions,
) -> Result<OverlapSet, PanoError> {
    if frames.len() != cameras.len() {
        return Err(PanoError::InvalidOptions(format!(
            "solve_photometry: {} frames vs {} cameras",
            frames.len(),
            cameras.len()
        )));
    }
    if let Some((k, (f, c))) = frames
        .iter()
        .zip(cameras)
        .enumerate()
        .find(|(_, (f, c))| (f.width(), f.height()) != (c.width, c.height))
    {
        return Err(PanoError::InvalidOptions(format!(
            "solve_photometry: frame {k} is {}x{} but its camera is {}x{}",
            f.width(),
            f.height(),
            c.width,
            c.height
        )));
    }
    validate_options(opts, "solve_photometry")?;
    let n = frames.len();
    let windows = frames
        .par_iter()
        .map(|f| SignalWindow::measure(f, opts.sample_stride))
        .collect();
    let candidates: Vec<(usize, usize)> = (0..n)
        .flat_map(|i| ((i + 1)..n).map(move |j| (i, j)))
        .filter(|&(i, j)| frames_may_overlap(&cameras[i], &cameras[j]))
        .collect();
    let pairs = candidates
        .par_iter()
        .map(|&(i, j)| PairSamples {
            i,
            j,
            samples: overlap::pair_samples(
                &frames[i],
                &cameras[i],
                &frames[j],
                &cameras[j],
                opts.sample_stride,
            ),
        })
        .filter(|p| p.samples.len() >= opts.min_overlap_samples.max(1))
        .collect();
    Ok(OverlapSet { windows, pairs })
}

/// Cheap overlap pre-test: optical-axis separation must not exceed the
/// summed half-diagonal FOVs (with 10% slack for distortion).
pub(super) fn frames_may_overlap(a: &Camera, b: &Camera) -> bool {
    let axis = |c: &Camera| c.rotation.mul_vec(crate::math::Vec3::new(0.0, 0.0, 1.0));
    let half_diag = |c: &Camera| {
        let rx = c.width as f64 * 0.5;
        let ry = c.height as f64 * 0.5;
        ((rx * rx + ry * ry).sqrt() / c.focal_px).atan() * 1.1
    };
    let ang = axis(a).dot(axis(b)).clamp(-1.0, 1.0).acos();
    ang <= half_diag(a) + half_diag(b)
}

/// Validity-weighted bilinear tap (texel centers at half-integers).
/// `None` when no valid in-bounds tap carries weight.
pub(super) fn bilinear_valid(src: &PlanarImage, x_px: f64, y_px: f64) -> Option<[f32; 3]> {
    let w = src.width() as i64;
    let h = src.height() as i64;
    let x = x_px - 0.5;
    let y = y_px - 0.5;
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = x - x0;
    let fy = y - y0;
    let (x0, y0) = (x0 as i64, y0 as i64);
    let taps = [
        (x0, y0, (1.0 - fx) * (1.0 - fy)),
        (x0 + 1, y0, fx * (1.0 - fy)),
        (x0, y0 + 1, (1.0 - fx) * fy),
        (x0 + 1, y0 + 1, fx * fy),
    ];
    let mut acc = [0.0_f64; 3];
    let mut wsum = 0.0_f64;
    for (tx, ty, wgt) in taps {
        if tx < 0 || tx >= w || ty < 0 || ty >= h || wgt == 0.0 {
            continue;
        }
        if !src.validity.get(tx as u32, ty as u32) {
            continue;
        }
        let i = (ty * w + tx) as usize;
        acc[0] += wgt * src.r[i] as f64;
        acc[1] += wgt * src.g[i] as f64;
        acc[2] += wgt * src.b[i] as f64;
        wsum += wgt;
    }
    if wsum < 1e-9 {
        return None;
    }
    let inv = 1.0 / wsum;
    Some([
        (acc[0] * inv) as f32,
        (acc[1] * inv) as f32,
        (acc[2] * inv) as f32,
    ])
}

/// Dense linear solve via Gaussian elimination with partial pivoting
/// (the gain systems are tiny — one row per frame). `None` when the
/// matrix is numerically singular.
pub(crate) fn solve_dense(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for col in 0..n {
        // Pivot.
        let mut piv = col;
        for row in (col + 1)..n {
            if a[row][col].abs() > a[piv][col].abs() {
                piv = row;
            }
        }
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        b.swap(col, piv);
        // Eliminate below.
        let pivot = a[col][col];
        for row in (col + 1)..n {
            let factor = a[row][col] / pivot;
            if factor == 0.0 {
                continue;
            }
            for k in col..n {
                let v = a[col][k];
                a[row][k] -= factor * v;
            }
            b[row] -= factor * b[col];
        }
    }
    // Back substitution.
    let mut x = vec![0.0_f64; n];
    for col in (0..n).rev() {
        let mut s = b[col];
        for k in (col + 1)..n {
            s -= a[col][k] * x[k];
        }
        x[col] = s / a[col][col];
    }
    Some(x)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod photometry_tests;

#[cfg(test)]
mod field_tests;

#[cfg(test)]
mod vignette_tests;
