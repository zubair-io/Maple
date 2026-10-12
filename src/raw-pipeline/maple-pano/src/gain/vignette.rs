//! Blind per-lens vignette estimation (#4522), the fallback for frames
//! whose ingest flattened no lens falloff (no OpcodeList3 gain map and no
//! bundled lens profile, #4516).
//!
//! Every frame shot through one lens shares a radial falloff whose
//! correction is `V(r) = (1 + q·r²)²`, `q = k² ≥ 0`, with `r²` normalised
//! elliptically about the frame centre (`r² = 2` at a corner). `k` is
//! estimated jointly with per-frame log-gains from the overlap set: a
//! corresponding pair satisfies
//! `ln I_j − ln I_i = (x_i − x_j) + (L_i − L_j)`, `L = ln V(r)`, so only the
//! radius *difference* of the same scene point in two frames informs `k`
//! while the log-gains absorb exposure. Gauss–Newton with Tikhonov
//! damping, Huber reweighting, `k ∈ [0, 1.5]` seeded at 0.2 (at `k = 0` the
//! Jacobian vanishes, so a zero seed could never leave it).
//!
//! Once `q` is known the overlap samples are flattened and the regular
//! affine fit and gain solve run on them; the warp divides the same
//! falloff out of every source tap ([`super::FramePhotometry::apply_at`]).

use raw_core::FalloffCorrection;

use super::overlap::{OverlapSample, OverlapSet, PairSamples};
use super::{fit::fit_pairs, solve::solve_from_fits, solve_dense, FramePhotometry, GainMode};
use crate::camera::Camera;
use crate::error::PanoError;
use crate::ingest::FrameMeta;

const K_SEED: f64 = 0.2;
const K_MAX: f64 = 1.5;
const ITERATIONS: usize = 10;
const TIKHONOV: f64 = 1e-4;
const HUBER_K: f64 = 1.5;
const MAD_TO_SIGMA: f64 = 1.4826;
/// Huber limit floor in log units (~1.5%), so a noise-free overlap does
/// not collapse the scale and down-weight every sample.
const HUBER_FLOOR: f64 = 0.015;
/// A lens group needs this many usable correspondences before its `q`
/// is trusted; below it the group keeps `q = 0`.
const MIN_GROUP_OBSERVATIONS: usize = 256;

/// Elliptically normalised squared radius of a source position about the
/// frame centre.
#[inline]
pub(crate) fn radius_squared(x: f64, y: f64, width: f64, height: f64) -> f64 {
    let u = (x - 0.5 * width) / (0.5 * width);
    let v = (y - 0.5 * height) / (0.5 * height);
    u * u + v * v
}

/// The correction multiplier `V = (1 + q·r²)²`.
#[inline]
pub(crate) fn falloff_gain(q: f64, r2: f64) -> f64 {
    (1.0 + q * r2).powi(2)
}

/// Lens identity of each frame that still carries its falloff, as an
/// index into `labels`. Frames whose ingest corrected falloff are `None`
/// and never take part in the estimate.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LensGroups {
    pub labels: Vec<String>,
    pub of_frame: Vec<Option<usize>>,
}

#[derive(Debug, Clone, PartialEq)]
struct LensKey {
    make: String,
    model: String,
    focal_decimm: Option<i64>,
    dims: (u32, u32),
}

impl LensKey {
    fn of(meta: &FrameMeta) -> Option<Self> {
        (meta.falloff_correction == FalloffCorrection::None).then(|| Self {
            make: meta.camera_make.trim().to_string(),
            model: meta.camera_model.trim().to_string(),
            focal_decimm: meta
                .priors
                .focal_mm
                .filter(|f| f.is_finite() && *f > 0.0)
                .map(|f| (f as f64 * 10.0).round() as i64),
            // Elliptical r² is invariant under a 90° turn, so portrait and
            // landscape frames of one lens share a group.
            dims: (
                meta.full_width.min(meta.full_height),
                meta.full_width.max(meta.full_height),
            ),
        })
    }

    fn label(&self) -> String {
        let body = format!("{} {}", self.make, self.model);
        let focal = self
            .focal_decimm
            .map(|d| format!(" {:.1}mm", d as f64 / 10.0))
            .unwrap_or_default();
        format!("{}{focal}", body.trim())
    }
}

impl LensGroups {
    pub fn from_metas<'a>(metas: impl IntoIterator<Item = &'a FrameMeta>) -> Self {
        let keys: Vec<Option<LensKey>> = metas.into_iter().map(LensKey::of).collect();
        let distinct = keys
            .iter()
            .flatten()
            .fold(Vec::<&LensKey>::new(), |acc, k| {
                if acc.contains(&k) {
                    acc
                } else {
                    acc.into_iter().chain(std::iter::once(k)).collect()
                }
            });
        Self {
            labels: distinct.iter().map(|k| k.label()).collect(),
            of_frame: keys
                .iter()
                .map(|k| {
                    k.as_ref()
                        .and_then(|k| distinct.iter().position(|d| *d == k))
                })
                .collect(),
        }
    }

    /// Every frame already falloff-corrected at ingest.
    pub fn ingest_corrected(frames: usize) -> Self {
        Self {
            labels: Vec::new(),
            of_frame: vec![None; frames],
        }
    }

    fn any(&self) -> bool {
        self.of_frame.iter().any(Option::is_some)
    }
}

/// The estimated falloff of one lens group, for the stitch report.
/// `frames` index the frames handed to the solve.
#[derive(Debug, Clone, PartialEq)]
pub struct LensFalloff {
    pub lens: String,
    pub frames: Vec<usize>,
    pub q: f32,
}

/// Per-frame photometry plus the falloff estimated per lens group (empty
/// when every frame was corrected at ingest).
#[derive(Debug, Clone)]
pub struct PhotometrySolution {
    pub frames: Vec<FramePhotometry>,
    pub falloff: Vec<LensFalloff>,
}

/// Fit and solve photometry over `set`, estimating and removing the
/// falloff of uncorrected lens groups first.
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
    let q = estimate_falloff(set, &dims, lenses);
    let q_of_frame: Vec<f64> = lenses
        .of_frame
        .iter()
        .map(|g| g.map_or(0.0, |g| q[g]))
        .collect();
    let flat = flatten(set, &dims, &q_of_frame);
    let frames = solve_from_fits(&flat, &fit_pairs(&flat, mode), mode)?
        .into_iter()
        .zip(&q_of_frame)
        .map(|(p, q)| FramePhotometry {
            falloff_q: *q as f32,
            ..p
        })
        .collect();
    let falloff = lenses
        .labels
        .iter()
        .zip(&q)
        .enumerate()
        .map(|(g, (lens, q))| LensFalloff {
            lens: lens.clone(),
            frames: (0..lenses.of_frame.len())
                .filter(|f| lenses.of_frame[*f] == Some(g))
                .collect(),
            q: *q as f32,
        })
        .collect();
    Ok(PhotometrySolution { frames, falloff })
}

#[derive(Debug, Clone, Copy)]
struct Observation {
    i: usize,
    j: usize,
    r2_i: f64,
    r2_j: f64,
    log_ratio: f64,
}

fn observations(set: &OverlapSet, dims: &[(f64, f64)]) -> Vec<Observation> {
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
                usable.then(|| Observation {
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

/// Unknowns are `[x_0 … x_{n−1}, k_0 … k_{G−1}]`.
struct Model<'a> {
    frames: usize,
    lenses: &'a LensGroups,
}

impl Model<'_> {
    /// Index of frame `f`'s `k`, its `L(r²)`, and `∂L/∂k`.
    fn lens_term(&self, params: &[f64], f: usize, r2: f64) -> Option<(usize, f64, f64)> {
        self.lenses.of_frame[f].map(|g| {
            let k = params[self.frames + g];
            let base = 1.0 + k * k * r2;
            (self.frames + g, 2.0 * base.ln(), 4.0 * k * r2 / base)
        })
    }

    /// Residual and model Jacobian row of one observation.
    fn linearize(&self, params: &[f64], o: &Observation) -> (f64, [(usize, f64); 4]) {
        let li = self.lens_term(params, o.i, o.r2_i);
        let lj = self.lens_term(params, o.j, o.r2_j);
        let model = params[o.i] - params[o.j] + li.map_or(0.0, |t| t.1) - lj.map_or(0.0, |t| t.1);
        let row = [
            (o.i, 1.0),
            (o.j, -1.0),
            li.map_or((0, 0.0), |t| (t.0, t.2)),
            lj.map_or((0, 0.0), |t| (t.0, -t.2)),
        ];
        (o.log_ratio - model, row)
    }

    fn residuals(&self, params: &[f64], obs: &[Observation]) -> Vec<f64> {
        obs.iter().map(|o| self.linearize(params, o).0).collect()
    }

    fn step(&self, params: &[f64], obs: &[Observation], weights: &[f64]) -> Option<Vec<f64>> {
        let m = params.len();
        let (a, b) = obs.iter().zip(weights).fold(
            (vec![vec![0.0_f64; m]; m], vec![0.0_f64; m]),
            |(mut a, mut b), (o, w)| {
                let (e, row) = self.linearize(params, o);
                let terms = || row.iter().filter(|t| t.1 != 0.0);
                for &(r, cr) in terms() {
                    b[r] += w * cr * e;
                    for &(c, cc) in terms() {
                        a[r][c] += w * cr * cc;
                    }
                }
                (a, b)
            },
        );
        let (a, b): (Vec<Vec<f64>>, Vec<f64>) = a
            .into_iter()
            .zip(b)
            .zip(params)
            .enumerate()
            .map(|(d, ((mut row, rhs), theta))| {
                row[d] += TIKHONOV;
                (row, rhs - TIKHONOV * theta)
            })
            .unzip();
        let delta = solve_dense(a, b)?;
        Some(
            params
                .iter()
                .zip(&delta)
                .enumerate()
                .map(|(d, (p, s))| {
                    if d < self.frames {
                        p + s
                    } else {
                        (p + s).clamp(0.0, K_MAX)
                    }
                })
                .collect(),
        )
    }
}

fn huber_weights(residuals: &[f64]) -> Vec<f64> {
    let mut magnitudes: Vec<f64> = residuals.iter().map(|r| r.abs()).collect();
    let mid = magnitudes.len() / 2;
    let (_, median, _) = magnitudes.select_nth_unstable_by(mid, f64::total_cmp);
    let limit = (HUBER_K * MAD_TO_SIGMA * *median).max(HUBER_FLOOR);
    residuals
        .iter()
        .map(|r| {
            if r.abs() <= limit {
                1.0
            } else {
                limit / r.abs()
            }
        })
        .collect()
}

/// `q` per lens group (0 for groups without enough support).
fn estimate_falloff(set: &OverlapSet, dims: &[(f64, f64)], lenses: &LensGroups) -> Vec<f64> {
    let groups = lenses.labels.len();
    let frames = set.windows.len();
    let obs = observations(set, dims);
    if obs.is_empty() {
        return vec![0.0; groups];
    }
    let support: Vec<usize> = (0..groups)
        .map(|g| {
            obs.iter()
                .filter(|o| lenses.of_frame[o.i] == Some(g) || lenses.of_frame[o.j] == Some(g))
                .count()
        })
        .collect();
    let model = Model { frames, lenses };
    let seed: Vec<f64> = std::iter::repeat_n(0.0, frames)
        .chain(std::iter::repeat_n(K_SEED, groups))
        .collect();
    let (params, _) =
        (0..ITERATIONS).fold(
            (seed, vec![1.0; obs.len()]),
            |(params, weights), _| match model.step(&params, &obs, &weights) {
                Some(next) => {
                    let weights = huber_weights(&model.residuals(&next, &obs));
                    (next, weights)
                }
                None => (params, weights),
            },
        );
    params[frames..]
        .iter()
        .zip(&support)
        .map(|(k, n)| {
            if *n >= MIN_GROUP_OBSERVATIONS {
                k * k
            } else {
                0.0
            }
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
