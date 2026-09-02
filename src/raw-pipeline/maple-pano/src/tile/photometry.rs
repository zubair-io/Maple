//! Photometric correction solve for the tile composite (#350).
//!
//! Two layers, both solved in the log domain from one strided canvas scan:
//!
//! **Layer A — gains + shared ramp.** Models each frame's recorded value
//! as `v_i = L · exp(a_i + b·(ξ−½) + c·(η−½))` where `(ξ, η)` are
//! frame-local normalized coordinates, `a_i` is the per-frame log-gain
//! and `(b, c)` is ONE slope shared by all frames (same camera, same sun
//! — the low-sun BRDF hotspot and any decentered falloff are fixed in
//! frame coordinates). Solving the slope jointly with the gains is what
//! stops the scalar-gain failure mode seen on pano_03: with scalars only,
//! a constant within-frame slope makes every consecutive overlap read
//! "next frame is dimmer", and the least squares integrates that bias
//! over the chain into a huge cross-strip gain ramp (measured 19× / 4.2
//! EV on a strip whose frames are actually equally bright). The slope is
//! identifiable because pairs exist at several baselines (i→i+1, i→i+2,
//! …): gain differences must be consistent across baselines while slope
//! terms scale with the frame-local offset.
//!
//! **Layer B — residual exposure fields (screened Poisson).** Whatever
//! the gain+ramp model cannot express (cloud shadows, genuine light
//! changes, non-linear falloff) remains as per-pair log residuals. Those
//! are aggregated on a coarse canvas grid and solved as one smooth
//! per-frame log-correction field per frame: data terms tie overlapping
//! frames' fields to the measured residual per cell, a gradient penalty
//! keeps each field smooth, and a weak anchor fixes the gauge — a
//! screened-Poisson system, solved with conjugate gradients. Fields are
//! bilinearly upsampled at composite time, so memory stays at the coarse
//! grid.
//!
//! Both corrections are applied per pixel in `warp_to_tile_region`:
//! `out = v · gain · exp(−(b·(ξ−½) + c·(η−½) + field(canvas)))`.
//!
//! Determinism: sampling walks a fixed strided grid (parallelized over
//! row bands, merged in band order), all maps are `BTreeMap`, and the CG
//! iteration count/termination is data-driven only — byte-stable across
//! runs.

use std::collections::BTreeMap;

use crate::error::PanoError;
use crate::gain::{solve_dense, GainMode, GainOptions};

use super::frame_cache::TileFrameCache;
use super::placement::{TileCanvasSpec, TilePose};
use super::sampling::sample_pairs;

/// Per-frame photometric correction, applied at warp time.
#[derive(Debug, Clone)]
pub(super) struct FramePhotometry {
    /// Multiplicative per-channel gain (`exp(−a_i)`), geomean-normalized.
    pub gain: [f32; 3],
    /// Shared log-domain slope over the frame-local normalized x (ξ−½).
    pub slope_x: f32,
    /// Shared log-domain slope over the frame-local normalized y (η−½).
    pub slope_y: f32,
    /// Layer-B residual log-correction field (canvas-anchored), if solved.
    pub field: Option<CoarseField>,
}

impl FramePhotometry {
    pub fn neutral() -> Self {
        Self {
            gain: [1.0; 3],
            slope_x: 0.0,
            slope_y: 0.0,
            field: None,
        }
    }
}

/// A coarse per-frame log-correction plane over the frame's canvas
/// window. `values[cy * w + cx]` corresponds to the global canvas cell
/// `(cx0 + cx, cy0 + cy)`; cell centers sit at `(c + 0.5) · cell_px`.
#[derive(Debug, Clone)]
pub(super) struct CoarseField {
    pub cell_px: f64,
    pub cx0: usize,
    pub cy0: usize,
    pub w: usize,
    pub h: usize,
    pub values: Vec<f32>,
}

impl CoarseField {
    /// Edge-clamped bilinear sample at a canvas position (pixels).
    pub fn eval(&self, canvas_x: f64, canvas_y: f64) -> f32 {
        let gx = (canvas_x / self.cell_px - 0.5 - self.cx0 as f64).clamp(0.0, self.w as f64 - 1.0);
        let gy = (canvas_y / self.cell_px - 0.5 - self.cy0 as f64).clamp(0.0, self.h as f64 - 1.0);
        let x0 = gx.floor() as usize;
        let y0 = gy.floor() as usize;
        let x1 = (x0 + 1).min(self.w - 1);
        let y1 = (y0 + 1).min(self.h - 1);
        let fx = (gx - x0 as f64) as f32;
        let fy = (gy - y0 as f64) as f32;
        let v00 = self.values[y0 * self.w + x0];
        let v10 = self.values[y0 * self.w + x1];
        let v01 = self.values[y1 * self.w + x0];
        let v11 = self.values[y1 * self.w + x1];
        (v00 * (1.0 - fx) + v10 * fx) * (1.0 - fy) + (v01 * (1.0 - fx) + v11 * fx) * fy
    }
}

/// Summary of the solved correction, for the stitch report.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct PhotometrySummary {
    pub slope_x: f32,
    pub slope_y: f32,
    pub field_mean_abs_ev: f64,
    pub field_max_abs_ev: f64,
}

/// Solver knobs. Constructed from [`GainOptions`] so `composite_tile`'s
/// public signature is unchanged.
#[derive(Debug, Clone)]
pub(super) struct PhotometryOptions {
    pub stride: usize,
    pub min_pair_samples: usize,
    pub per_channel: bool,
    /// Solve the shared per-frame slope (layer A ramp). Off → scalar-only.
    pub ramp: bool,
    /// Solve the layer-B residual fields.
    pub field: bool,
    pub field_cell_px: usize,
    /// Smoothness weight relative to the mean per-cell data weight.
    pub field_lambda: f64,
    pub field_cg_iters: usize,
}

impl PhotometryOptions {
    /// Derive the photometric knobs from the caller's [`GainOptions`].
    ///
    /// `sigma_n` / `sigma_g` are deliberately NOT threaded through:
    /// they parameterize the old single-scalar solve's data-vs-prior
    /// balance, which this solve replaces. Their roles here are the
    /// gauge/ridge weights in [`solve_gain_slope`] and `field_lambda`,
    /// all expressed relative to the measured data mass so they stay
    /// scale-free — a fixed sigma in linear intensity units would not.
    /// Nothing exposes them on the tile path today (the composite is
    /// called with `GainOptions::default()`); wire them in only if a
    /// real caller needs to tune this solve, per YAGNI.
    pub fn from_gain(g: &GainOptions) -> Self {
        Self {
            stride: g.sample_stride.max(1) as usize,
            min_pair_samples: g.min_overlap_samples.max(1),
            per_channel: matches!(g.mode, GainMode::PerChannel),
            ramp: true,
            field: true,
            field_cell_px: 128,
            // Screened-Poisson transfer length ≈ sqrt(λ/w) cells: 1.0 keeps
            // the field responsive at the ~1-cell scale while the per-cell
            // MEAN data (not texture) is all it ever sees.
            field_lambda: 1.0,
            field_cg_iters: 300,
        }
    }
}

/// Skip samples darker than this (scene-linear): log-ratios of near-zero
/// values are noise-dominated.
pub(super) const MIN_LUM: f64 = 1e-5;

#[derive(Debug, Clone, Default)]
pub(super) struct CellAcc {
    pub(super) n: f64,
    pub(super) s_lnr: f64,
    pub(super) s_dxi: f64,
    pub(super) s_deta: f64,
}

#[derive(Debug, Clone, Default)]
pub(super) struct PairAcc {
    pub(super) n: f64,
    pub(super) s_lnr_lum: f64,
    pub(super) s_lnr_ch: [f64; 3],
    /// Per-channel sample counts. A sample only enters `s_lnr_ch[c]`
    /// when BOTH frames are above `MIN_LUM` in that channel, so this can
    /// be smaller than `n` (dark or clipped channels) — dividing the
    /// channel sum by `n` would bias the mean toward 0.
    pub(super) n_ch: [f64; 3],
    pub(super) s_dxi: f64,
    pub(super) s_deta: f64,
    pub(super) cells: BTreeMap<u32, CellAcc>,
}

pub(super) type PairMap = BTreeMap<(usize, usize), PairAcc>;

/// Solve the full photometric correction for a placed frame set.
///
/// `full_dims` is indexed by the *original* input frame index (same
/// space as `cache` and `poses[i].frame_idx`) — #3197: frames are
/// decoded on demand through `cache` rather than requiring the whole set
/// pre-decoded and resident.
pub(super) fn solve_photometry(
    cache: &TileFrameCache,
    full_dims: &[(u32, u32)],
    poses: &[TilePose],
    canvas: &TileCanvasSpec,
    opts: &PhotometryOptions,
) -> Result<(Vec<FramePhotometry>, PhotometrySummary), PanoError> {
    let n = poses.len();
    if n == 0 {
        return Ok((Vec::new(), PhotometrySummary::default()));
    }
    if n == 1 {
        return Ok((
            vec![FramePhotometry::neutral()],
            PhotometrySummary::default(),
        ));
    }
    if opts.stride == 0 || opts.field_cell_px == 0 {
        return Err(PanoError::InvalidOptions(
            "solve_photometry: stride and field_cell_px must be positive".into(),
        ));
    }
    // Validate once, here, so a mismatched full_dims/poses pair surfaces
    // as a typed error instead of a panic deep inside a rayon worker
    // thread in sample_pairs/frame_window.
    if let Some(pose) = poses.iter().find(|p| p.frame_idx >= full_dims.len()) {
        return Err(PanoError::InvalidOptions(format!(
            "solve_photometry: pose frame_idx {} out of range for {} full_dims entries",
            pose.frame_idx,
            full_dims.len()
        )));
    }

    let pairs = sample_pairs(cache, full_dims, poses, canvas, opts)?;

    // ── Layer A: gains + shared slope ────────────────────────────────────
    let (a_lum, slope_x, slope_y) = solve_gain_slope(n, &pairs, opts);
    let gains = if opts.per_channel {
        let mut per_ch = [vec![0.0_f64; n], vec![0.0_f64; n], vec![0.0_f64; n]];
        for (ch, out) in per_ch.iter_mut().enumerate() {
            *out = solve_channel_gains(n, &pairs, opts, slope_x, slope_y, ch);
        }
        (0..n)
            .map(|i| {
                [
                    (-per_ch[0][i]).exp() as f32,
                    (-per_ch[1][i]).exp() as f32,
                    (-per_ch[2][i]).exp() as f32,
                ]
            })
            .collect::<Vec<_>>()
    } else {
        a_lum
            .iter()
            .map(|a| {
                let g = (-a).exp() as f32;
                [g, g, g]
            })
            .collect::<Vec<_>>()
    };

    // ── Layer B: residual fields ─────────────────────────────────────────
    let fields = if opts.field {
        super::exposure_field::solve_fields(
            full_dims, poses, canvas, opts, &pairs, &a_lum, slope_x, slope_y,
        )
    } else {
        vec![None; n]
    };

    let (mean_ev, max_ev) = field_stats(&fields);
    let summary = PhotometrySummary {
        slope_x: slope_x as f32,
        slope_y: slope_y as f32,
        field_mean_abs_ev: mean_ev,
        field_max_abs_ev: max_ev,
    };

    let photometry = gains
        .into_iter()
        .zip(fields)
        .map(|(gain, field)| FramePhotometry {
            gain,
            slope_x: slope_x as f32,
            slope_y: slope_y as f32,
            field,
        })
        .collect();
    Ok((photometry, summary))
}

/// Layer-A joint solve: per-frame log-gains `a_i` (luminance) plus the
/// shared slope `(b, c)`. Gauge: Σa = 0 (strong row); tiny per-`a` ridge
/// keeps disconnected frames at 0; slope ridge keeps `(b, c)` at 0 when
/// the pair set carries no slope information.
///
/// ## The strip degeneracy and its prior
///
/// For a uniformly spaced translation strip the frame-local offset
/// `Δξ_ij` is exactly proportional to the hop distance `j − i`, so a
/// LINEAR gain ramp (`a_i = −δ·i`) reproduces the pairwise data of a
/// shared slope exactly — the two are collinear and no amount of
/// multi-baseline data separates them. A soft penalty on the linear
/// TREND of the gain chain (weight ~0.1× the data mass) resolves the
/// null direction toward the slope: a within-frame slope is camera-fixed
/// physics (low-sun BRDF hotspot, decentered falloff), while a smooth
/// 19× gain ramp across a constant-exposure strip is the pano_03
/// artifact this solve exists to prevent. Genuine exposure changes
/// remain representable: quantized AE steps have almost no linear trend,
/// and any non-uniform spacing breaks the collinearity so real data
/// overrides the soft prior.
fn solve_gain_slope(n: usize, pairs: &PairMap, opts: &PhotometryOptions) -> (Vec<f64>, f64, f64) {
    let m = if opts.ramp { n + 2 } else { n };
    let mut ata = vec![vec![0.0_f64; m]; m];
    let mut atb = vec![0.0_f64; m];
    let mut total_w = 0.0_f64;

    let mut add_row =
        |coeffs: &[(usize, f64)], rhs: f64, w: f64, ata: &mut Vec<Vec<f64>>, atb: &mut Vec<f64>| {
            for &(p, cp) in coeffs {
                for &(q, cq) in coeffs {
                    ata[p][q] += w * cp * cq;
                }
                atb[p] += w * cp * rhs;
            }
        };

    for (&(i, j), acc) in pairs.iter() {
        if (acc.n as usize) < opts.min_pair_samples {
            continue;
        }
        let w = acc.n;
        total_w += w;
        let mean = acc.s_lnr_lum / acc.n;
        let dxi = acc.s_dxi / acc.n;
        let deta = acc.s_deta / acc.n;
        let mut coeffs = vec![(i, 1.0), (j, -1.0)];
        if opts.ramp {
            coeffs.push((n, dxi));
            coeffs.push((n + 1, deta));
        }
        add_row(&coeffs, mean, w, &mut ata, &mut atb);
    }
    if total_w <= 0.0 {
        return (vec![0.0; n], 0.0, 0.0);
    }

    // Gauge: Σ a_i = 0.
    let gauge: Vec<(usize, f64)> = (0..n).map(|i| (i, 1.0)).collect();
    add_row(&gauge, 0.0, 1e3 * total_w, &mut ata, &mut atb);
    // Soft zero-trend prior on the gain chain (see the degeneracy note).
    if opts.ramp && n > 1 {
        let mid = (n as f64 - 1.0) / 2.0;
        let trend: Vec<(usize, f64)> = (0..n).map(|i| (i, (i as f64 - mid) / n as f64)).collect();
        add_row(&trend, 0.0, 0.1 * total_w, &mut ata, &mut atb);
    }
    // Ridges.
    for (idx, ridge) in ata.iter_mut().enumerate().take(m) {
        let w = if idx < n { 1e-6 } else { 1e-4 } * total_w;
        ridge[idx] += w;
    }

    let x = solve_dense(ata, atb).unwrap_or_else(|| vec![0.0; m]);
    let a = x[..n].to_vec();
    let (b, c) = if opts.ramp {
        (x[n], x[n + 1])
    } else {
        (0.0, 0.0)
    };
    (a, b, c)
}

/// Per-channel gain refinement with the shared slope held fixed.
fn solve_channel_gains(
    n: usize,
    pairs: &PairMap,
    opts: &PhotometryOptions,
    slope_x: f64,
    slope_y: f64,
    ch: usize,
) -> Vec<f64> {
    let mut ata = vec![vec![0.0_f64; n]; n];
    let mut atb = vec![0.0_f64; n];
    let mut total_w = 0.0_f64;
    for (&(i, j), acc) in pairs.iter() {
        if (acc.n as usize) < opts.min_pair_samples {
            continue;
        }
        // Weight and normalize by the CHANNEL's own sample count: a pair
        // whose samples are mostly dark in this channel carries less
        // information about its gain, and its mean must not be diluted by
        // luminance-only samples.
        if (acc.n_ch[ch] as usize) < opts.min_pair_samples {
            continue;
        }
        let w = acc.n_ch[ch];
        total_w += w;
        let mean = acc.s_lnr_ch[ch] / acc.n_ch[ch]
            - slope_x * (acc.s_dxi / acc.n)
            - slope_y * (acc.s_deta / acc.n);
        ata[i][i] += w;
        ata[j][j] += w;
        ata[i][j] -= w;
        ata[j][i] -= w;
        atb[i] += w * mean;
        atb[j] -= w * mean;
    }
    if total_w <= 0.0 {
        return vec![0.0; n];
    }
    let gw = 1e3 * total_w;
    for i in 0..n {
        for j in 0..n {
            ata[i][j] += gw;
        }
        ata[i][i] += 1e-6 * total_w;
    }
    solve_dense(ata, atb).unwrap_or_else(|| vec![0.0; n])
}

/// Mean/max |field| in EV over all solved field cells.
fn field_stats(fields: &[Option<CoarseField>]) -> (f64, f64) {
    let ln2 = std::f64::consts::LN_2;
    let mut sum = 0.0_f64;
    let mut count = 0usize;
    let mut max = 0.0_f64;
    for f in fields.iter().flatten() {
        for &v in &f.values {
            let ev = (v as f64 / ln2).abs();
            sum += ev;
            max = max.max(ev);
            count += 1;
        }
    }
    if count == 0 {
        (0.0, 0.0)
    } else {
        (sum / count as f64, max)
    }
}
