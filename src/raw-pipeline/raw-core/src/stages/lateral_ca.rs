//! Profile-free lateral chromatic-aberration correction (#3411).
//!
//! Pre-demosaic, raw-domain — it runs between [`super::hot_pixel`] and
//! `demosaic`, on the linearized mosaic, which is where RawTherapee's "auto
//! CA correction" and darktable's raw "chromatic aberrations" module both
//! sit. Lateral CA is a per-channel radial magnification error: red and
//! blue land at a slightly larger or smaller radius than green, so a
//! high-contrast edge near a frame corner picks up a coloured seam. Nothing
//! here reads a lens profile, which is the whole point — the DNG
//! `WarpRectilinear` path (#376) only fires on a DNG whose vendor encoded
//! the coefficients, and no CR2 / RAF / ARW / NEF ever does.
//!
//! ## The estimate, in one paragraph
//!
//! Over a coarse grid of blocks, each block asks one question: how far
//! along its own radial direction would red have to move to line up with
//! green? That is the classic Lucas–Kanade one-parameter fit. Writing `u`
//! for the block's outward radial unit vector, `gG` for green's derivative
//! along `u`, and `s` for the least-squares gain that puts red on green's
//! scale inside this block, a displacement `d` satisfies `s·R − G ≈ d·gG`
//! per pixel, so `d = Σ gG·(s·R − G) / Σ gG²`. Blocks with too little edge
//! energy, or an implausible answer, are dropped. The surviving `(radius,
//! d)` pairs are fitted with an odd radial polynomial `d(ρ) = a₁ρ + a₃ρ³`
//! — odd because the displacement is zero at the optical centre and flips
//! sign through it — weighted by each block's edge energy, then refitted
//! once with the worst outliers removed. The whole estimate then repeats
//! against the partially-corrected plane, which is what buys sub-pixel
//! accuracy past a pixel of displacement: one linearisation is only good
//! for shifts well under one pixel.
//!
//! ## The correction
//!
//! Each red site is rewritten as `R(p) + (plane_R(p − d·u) − plane_R(p))`
//! — the ORIGINAL sample plus the change the interpolated plane sees over
//! the displacement. Blue likewise. That delta form matters twice over: at
//! `d = 0` it adds exactly `+0.0`, so a frame the estimator finds nothing
//! on stays bit-identical, and on X-Trans — whose red and blue lattices are
//! irregular, so the plane is an approximation rather than the sample
//! itself — a real sample is never replaced by its own interpolation, only
//! nudged.
//!
//! Green is the reference and is never touched, so the stage cannot shift
//! the image as a whole.
//!
//! ## Skips
//!
//! - `AutoLateralCa::Off` (the default) returns before reading a pixel.
//! - A RAW whose `OpcodeList3` already carries per-plane `WarpRectilinear`
//!   coefficients is skipped by the caller
//!   (`RawImage::lens_correction_ca_inert()` is false there), so the two
//!   corrections can never stack.
//! - A fit that collects too few usable blocks, or lands a corner
//!   displacement below [`MIN_USEFUL_SHIFT_PX`], leaves the mosaic
//!   untouched rather than resampling for nothing.
//!
//! Tile-safety: the estimate is frame-anchored (the radial field is defined
//! against the full mosaic's centre), so this stage is deliberately NOT run
//! on the tile path — the same treatment `dehaze` and `deep_denoise` get.

use rayon::prelude::*;

use crate::cancel::CancelToken;
use crate::image::{CfaPattern, ColorSpace, Image};
use crate::types::adjustment::AutoLateralCa;

#[path = "lateral_ca/planes.rs"]
mod planes;
use planes::{ChannelSampler, GreenPlane, RadialFrame};

/// Blocks sampled across the frame, per axis. 32 × 24 = 768 candidates —
/// dense enough that the radial fit still sees every ring after outlier
/// rejection, cheap enough that estimation is a rounding error against the
/// resample pass.
const GRID_X: usize = 32;
const GRID_Y: usize = 24;

/// Side of the sample window taken at each grid cell's centre, in pixels.
/// Clamped down when a cell is smaller than this.
const BLOCK_PX: usize = 48;

/// Outer estimation passes. Pass 1 linearises around zero displacement;
/// pass 2 re-estimates the residual against the plane already shifted by
/// pass 1's polynomial.
const REFINE_PASSES: usize = 2;

/// A block is used only if its green edge energy `Σ gG²` clears this, in
/// normalised [0, 1] sensor units squared. Flat sky contributes noise, not
/// signal, and would drag the fit toward zero.
const MIN_EDGE_ENERGY: f32 = 1e-3;

/// Any per-block displacement past this is a mis-registration, not CA —
/// lateral CA on the worst consumer glass stays inside a couple of pixels
/// at the corner. Dropped before the fit.
const MAX_BLOCK_SHIFT_PX: f32 = 4.0;

/// The fitted polynomial is clamped to this at evaluation time, so an
/// extrapolation past the sampled radius can never fling a site across the
/// frame.
const MAX_FITTED_SHIFT_PX: f32 = 6.0;

/// Blocks that must survive rejection before a fit is trusted at all.
const MIN_BLOCKS: usize = 24;

/// Pixels in a block that must contribute before it is scored.
const MIN_BLOCK_PIXELS: usize = 16;

/// Corner displacement below which the channel is left alone — resampling
/// for a twentieth of a pixel costs a pass over the mosaic and buys nothing
/// measurable.
const MIN_USEFUL_SHIFT_PX: f32 = 0.05;

/// After the first weighted fit, blocks whose residual exceeds this
/// multiple of the weighted residual RMS are dropped and the fit repeats.
const OUTLIER_SIGMA: f32 = 2.0;

/// An odd radial displacement polynomial, `d(ρ) = a1·ρ + a3·ρ³`, with `ρ`
/// the distance from the frame centre normalised by the corner distance.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RadialFit {
    pub a1: f32,
    pub a3: f32,
}

impl RadialFit {
    /// Displacement in pixels at normalised radius `rho`, clamped to
    /// [`MAX_FITTED_SHIFT_PX`].
    #[inline]
    pub fn eval(self, rho: f32) -> f32 {
        let d = self.a1 * rho + self.a3 * rho * rho * rho;
        d.clamp(-MAX_FITTED_SHIFT_PX, MAX_FITTED_SHIFT_PX)
    }

    /// Whether this fit moves anything worth a resample pass, judged at the
    /// corner (`rho = 1`) where lateral CA is largest.
    #[inline]
    fn is_useful(self) -> bool {
        self.eval(1.0).abs() >= MIN_USEFUL_SHIFT_PX
    }
}

/// One block's contribution to the radial fit: the radius it was measured
/// at, the displacement measured there, and the edge energy that
/// measurement rests on (which is also the fit weight).
#[derive(Clone, Copy)]
struct Sample {
    rho: f32,
    d: f32,
    weight: f32,
}

/// Measure one block's radial displacement of `channel` against `green`.
///
/// `prior` is the displacement earlier refine passes already applied, so
/// pass 2 linearises around the partially-corrected plane. `None` when the
/// block carries too little edge energy, straddles the centre, or produces
/// an implausible answer.
fn measure_block(
    green: &GreenPlane,
    channel: &ChannelSampler,
    frame: RadialFrame,
    prior: RadialFit,
    (x0, y0): (usize, usize),
    size: usize,
) -> Option<Sample> {
    let x_end = (x0 + size).min(green.width - 1);
    let y_end = (y0 + size).min(green.height - 1);
    // Pass A: the per-block gain that puts the channel on green's scale.
    // Without it a red plane sitting at half green's level reads as a large
    // fake displacement wherever green has any gradient at all.
    let (mut sum_rg, mut sum_rr, mut sum_rho, mut n) = (0.0f64, 0.0f64, 0.0f64, 0usize);
    for y in y0.max(1)..y_end {
        for x in x0.max(1)..x_end {
            let Some((ux, uy, rho)) = frame.at(x as f32 + 0.5, y as f32 + 0.5) else {
                continue;
            };
            let shift = prior.eval(rho);
            let r = channel.sample(x as f32 - shift * ux, y as f32 - shift * uy);
            let g = green.at(x, y);
            sum_rg += (r * g) as f64;
            sum_rr += (r * r) as f64;
            sum_rho += rho as f64;
            n += 1;
        }
    }
    if n < MIN_BLOCK_PIXELS || sum_rr <= 0.0 {
        return None;
    }
    let gain = (sum_rg / sum_rr) as f32;
    if !gain.is_finite() || gain <= 0.0 {
        return None;
    }
    // Pass B: the Lucas–Kanade fit itself.
    let (mut sum_gd, mut sum_gg) = (0.0f64, 0.0f64);
    for y in y0.max(1)..y_end {
        for x in x0.max(1)..x_end {
            let Some((ux, uy, rho)) = frame.at(x as f32 + 0.5, y as f32 + 0.5) else {
                continue;
            };
            let shift = prior.eval(rho);
            let r = channel.sample(x as f32 - shift * ux, y as f32 - shift * uy);
            let grad = green.directional_derivative(x, y, ux, uy);
            sum_gd += (grad * (gain * r - green.at(x, y))) as f64;
            sum_gg += (grad * grad) as f64;
        }
    }
    if sum_gg <= MIN_EDGE_ENERGY as f64 {
        return None;
    }
    let d = (sum_gd / sum_gg) as f32;
    if !d.is_finite() || d.abs() > MAX_BLOCK_SHIFT_PX {
        return None;
    }
    Some(Sample {
        rho: (sum_rho / n as f64) as f32,
        d,
        weight: sum_gg as f32,
    })
}

/// Weighted least squares of `d(ρ) = a1·ρ + a3·ρ³` over `set`. `None` when
/// the normal equations are singular or too few samples were supplied.
fn solve_radial(set: &[&Sample]) -> Option<RadialFit> {
    if set.len() < MIN_BLOCKS {
        return None;
    }
    let (mut m11, mut m12, mut m22) = (0.0f64, 0.0f64, 0.0f64);
    let (mut b1, mut b2) = (0.0f64, 0.0f64);
    for s in set {
        let (p1, p3, w) = (
            s.rho as f64,
            (s.rho * s.rho * s.rho) as f64,
            s.weight as f64,
        );
        m11 += w * p1 * p1;
        m12 += w * p1 * p3;
        m22 += w * p3 * p3;
        b1 += w * p1 * s.d as f64;
        b2 += w * p3 * s.d as f64;
    }
    let det = m11 * m22 - m12 * m12;
    if det.abs() < 1e-12 {
        return None;
    }
    let a1 = ((b1 * m22 - b2 * m12) / det) as f32;
    let a3 = ((m11 * b2 - m12 * b1) / det) as f32;
    (a1.is_finite() && a3.is_finite()).then_some(RadialFit { a1, a3 })
}

/// [`solve_radial`], then one refit with residual outliers past
/// [`OUTLIER_SIGMA`] dropped — a specular highlight or a moving subject
/// otherwise pulls the whole polynomial with it.
fn fit_radial(samples: &[Sample]) -> Option<RadialFit> {
    let all: Vec<&Sample> = samples.iter().collect();
    let first = solve_radial(&all)?;
    let (mut wsum, mut wres) = (0.0f64, 0.0f64);
    for s in &all {
        let r = (s.d - first.eval(s.rho)) as f64;
        wres += s.weight as f64 * r * r;
        wsum += s.weight as f64;
    }
    if wsum <= 0.0 {
        return Some(first);
    }
    let rms = (wres / wsum).sqrt() as f32;
    if rms <= 0.0 {
        return Some(first);
    }
    let kept: Vec<&Sample> = all
        .into_iter()
        .filter(|s| (s.d - first.eval(s.rho)).abs() <= OUTLIER_SIGMA * rms)
        .collect();
    Some(solve_radial(&kept).unwrap_or(first))
}

/// Estimate one channel's radial displacement polynomial against green.
fn estimate_channel(
    green: &GreenPlane,
    channel: &ChannelSampler,
    frame: RadialFrame,
    cancel: CancelToken<'_>,
) -> Option<RadialFit> {
    let cell_w = green.width / GRID_X;
    let cell_h = green.height / GRID_Y;
    if cell_w < 8 || cell_h < 8 {
        return None;
    }
    let size = BLOCK_PX.min(cell_w).min(cell_h);
    let mut fit = RadialFit::default();
    for _ in 0..REFINE_PASSES {
        if cancel.is_cancelled() {
            return None;
        }
        let samples: Vec<Sample> = (0..GRID_X * GRID_Y)
            .into_par_iter()
            .filter_map(|i| {
                let (gx, gy) = (i % GRID_X, i / GRID_X);
                let origin = (
                    gx * cell_w + (cell_w - size) / 2,
                    gy * cell_h + (cell_h - size) / 2,
                );
                measure_block(green, channel, frame, fit, origin, size)
            })
            .collect();
        let Some(residual) = fit_radial(&samples) else {
            // Nothing usable this pass: a pass-1 failure means no fit at
            // all, a pass-2 failure keeps pass 1's answer.
            return (fit != RadialFit::default()).then_some(fit);
        };
        fit = RadialFit {
            a1: fit.a1 + residual.a1,
            a3: fit.a3 + residual.a3,
        };
    }
    Some(fit)
}

/// Rewrite every site of `color` as `sample + (plane(p − d·u) − plane(p))`.
fn resample_channel(
    mosaic: &mut Image,
    cfa: CfaPattern,
    channel: &ChannelSampler,
    frame: RadialFrame,
    fit: RadialFit,
    color: u8,
) {
    let w = mosaic.width as usize;
    mosaic
        .pixels
        .par_chunks_mut(w)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, px) in row.iter_mut().enumerate() {
                if cfa.color_at(x as u32, y as u32) != color {
                    continue;
                }
                let Some((ux, uy, rho)) = frame.at(x as f32 + 0.5, y as f32 + 0.5) else {
                    continue;
                };
                let d = fit.eval(rho);
                let here = channel.sample(x as f32, y as f32);
                let there = channel.sample(x as f32 - d * ux, y as f32 - d * uy);
                px[color as usize] = (px[color as usize] + (there - here)).max(0.0);
            }
        });
}

/// Correct lateral chromatic aberration on a `CameraNativeMosaic` image.
///
/// `Off` (the default) is an exact bit-identical skip, as is a frame the
/// estimator finds no usable displacement on. Callers must not pass
/// [`CfaPattern::LinearRgb`] (no mosaic exists for it), and must skip the
/// call entirely when the RAW's `OpcodeList3` already carries per-plane
/// `WarpRectilinear` coefficients — see the module docs.
///
/// Returns the fitted red and blue polynomials for diagnostics and tests;
/// both are `RadialFit::default()` when nothing was applied.
pub fn apply(
    mosaic: &mut Image,
    cfa: CfaPattern,
    mode: AutoLateralCa,
    cancel: CancelToken<'_>,
) -> (RadialFit, RadialFit) {
    let none = (RadialFit::default(), RadialFit::default());
    if mode == AutoLateralCa::Off {
        return none;
    }
    // A HARD assert, not the usual `assert_space` (which is a
    // `debug_assert` and so vanishes in release). This stage reads and
    // writes through `CfaPattern::color_at`, which only means anything
    // while one channel lives at each site: run it on a demosaiced buffer
    // and it would quietly rewrite a third of the pixels using a lattice
    // that no longer exists — wrong output, no crash, on exactly the
    // release builds users have. The develop chain calls it between
    // `hot_pixel` and `demosaic` for that reason; this makes a future
    // re-ordering fail loudly instead. One enum compare per develop.
    assert_eq!(
        mosaic.space,
        ColorSpace::CameraNativeMosaic,
        "lateral_ca::apply is a raw-domain stage and must run BEFORE demosaic"
    );
    debug_assert_ne!(
        cfa,
        CfaPattern::LinearRgb,
        "lateral_ca::apply must not run on LinearRgb sources (no mosaic)"
    );
    let (w, h) = (mosaic.width as usize, mosaic.height as usize);
    if w < GRID_X * 8 || h < GRID_Y * 8 {
        return none;
    }
    let frame = RadialFrame::new(w, h);
    let green = GreenPlane::build(mosaic, cfa);
    let mut fits = [RadialFit::default(); 2];
    for (slot, color) in [(0usize, 0u8), (1, 2)] {
        if cancel.is_cancelled() {
            return none;
        }
        let Some(channel) = ChannelSampler::build(mosaic, cfa, color) else {
            continue;
        };
        let Some(fit) = estimate_channel(&green, &channel, frame, cancel) else {
            continue;
        };
        if !fit.is_useful() {
            continue;
        }
        resample_channel(mosaic, cfa, &channel, frame, fit, color);
        fits[slot] = fit;
    }
    (fits[0], fits[1])
}

#[cfg(test)]
#[path = "lateral_ca/tests.rs"]
mod tests;
