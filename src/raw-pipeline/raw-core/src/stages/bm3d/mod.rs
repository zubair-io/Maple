//! BM3D deep denoise (#1105, tone/zoom design spec § 3.2).
//!
//! **Clean-room** implementation of the two-stage BM3D structure
//! published in Dabov et al. 2007 ("Image denoising by sparse 3-D
//! transform-domain collaborative filtering"), written from the paper's
//! published math as restated by the design spec — no code, constants, or
//! tables from the Tampere reference implementation (non-commercial
//! license), IPOL (GPL), or RapidRAW (AGPL) were consulted. A patent
//! review of US9123103B2's claims is a release gate before enabling or
//! marketing this stage (issue #1105 checklist).
//!
//! ## Shape
//!
//! Input-referred pipeline stage, immediately after the § 3.1 chroma
//! pre-filter inside the decode product (before capture sharpening /
//! auto-exposure / all user adjustments) — denoising is a capture-domain
//! operation and the placement composes it into the cached decoded
//! buffer, so per-slider-tick cost is zero.
//!
//! - Opponent channels `Y / C1 / C2` (same linear decomposition as the
//!   pre-filter); **joint block-matching** — one match list computed on
//!   luma and reused by all three channels (the CBM3D structure).
//! - Chroma is thresholded harder than luma: `σ_C = 1.8 × σ_Y`, keeping
//!   residual noise luminant (consistent with the tier-1 pre-filter).
//! - 8×8 blocks, orthonormal 2-D DCT-II patch transform + orthonormal
//!   1-D Walsh–Hadamard across the group; reference stride 6 (clamped so
//!   the grid covers every pixel); 19×19 search window; group ≤ 16
//!   (power of two for the WHT).
//! - Pass 1 hard-thresholds the 3-D spectrum at `λσ`; pass 2 re-matches
//!   on the basic estimate and applies empirical Wiener shrinkage
//!   `B²/(B²+σ²)` to the noisy spectrum.
//! - A final high-frequency re-injection (`unfiltered − Gaussian-blurred`
//!   luma, scaled by strength) guards against plastic skin.
//!
//! ## Clean-room parameterization (documented deviations)
//!
//! - Patches are **mean-subtracted** before the 2-D DCT and the per-patch
//!   means are filtered as a separate group-axis vector **relative to the
//!   reference patch's mean** (at the tighter mean-noise sigma `σ/8`).
//!   Inter-patch brightness is still denoised, the patch DC is never
//!   shrunk toward zero, and — together with the delta aggregation in
//!   [`pipeline`] — uniform fields become **bit-exact identity**, which
//!   is the synthetic-grey gate.
//! - σ maps from the single strength parameter, anchored to the image's
//!   median luma so the response is invariant to the per-camera post-DCP
//!   scale (the stage runs before auto-exposure): `σ_Y = K · (s/100) ·
//!   (median_Y + pedestal)`.
//! - Patch matching uses mean-relative SSD (gradient-robust, consistent
//!   with the transform above); no Kaiser aggregation window (uniform
//!   patch weighting) — simpler, with the per-group `1/(1+retained)` /
//!   `1/ΣW²` weights carrying the adaptivity.
//!
//! ## Determinism
//!
//! Byte-identical across thread counts and platforms: no atomic float
//! accumulation anywhere — parallel work writes to indexed slots and the
//! aggregation replays serially in scan order (see [`pipeline`] docs).
//! Pinned by a 1-vs-N-thread byte-equality test.
//!
//! `strength < 1e-3` (the shipped default 0) skips the stage entirely.
//! Never runs on the tile path (the reference grid is anchored at the
//! buffer origin, so tile-relative grids would seam) — the tile FFI
//! entries reject `deepDenoise > 0` exactly like dehaze.

mod matching;
mod pipeline;
mod transforms;

#[cfg(test)]
mod tests;

use rayon::prelude::*;

use crate::cancel::CancelToken;
use crate::image::{ColorSpace, Image};
use pipeline::{run_pass, PassKind};

/// Patch edge length.
pub(crate) const BLOCK: usize = 8;
/// Reference-patch grid stride.
pub(crate) const STRIDE: usize = 6;
/// Half-extent of the (19×19) block-matching search window.
pub(crate) const SEARCH_HALF: usize = 9;
/// Maximum group size (power of two for the group-axis WHT).
pub(crate) const GROUP_MAX: usize = 16;
/// Hard-threshold multiplier on σ (pass 1).
pub(crate) const LAMBDA_HT: f32 = 2.7;
/// Match ceiling: mean-relative per-pixel SSD ≤ `T_MATCH_SQ · σ_Y²`.
/// 2.5² — two flat patches under iid noise differ by ~2σ² per pixel, so
/// this keeps genuinely similar content while rejecting structure.
const T_MATCH_SQ: f32 = 6.25;
/// Strength→σ slope: at strength 100, σ_Y = 20 % of the median-luma
/// anchor. Initial calibration value (the stage ships default-off; the
/// engaged response is gated by the identity/monotonicity tests and the
/// slider-matrix harness when cases are added).
const SIGMA_K: f32 = 0.2;
/// Chroma σ multiplier (spec § 3.2: ≈1.8× luma).
const CHROMA_SIGMA_RATIO: f32 = 1.8;
/// Anchor pedestal so a near-black frame still gets a non-zero σ.
const ANCHOR_PEDESTAL: f32 = 1e-3;
/// High-frequency re-injection gain at strength 100.
const HF_K: f32 = 0.15;
/// Rec.2020 luma weights (same constants as the sibling stages).
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Progress sink: `(pass_name, fraction_done)`. The pipeline wires this
/// to the `MAPLE_PROFILE` stderr log via [`env_progress`]; richer UI
/// progress (determinate editor indicator) is the editor-UI phase's job —
/// see #1108.
pub type Progress<'a> = Option<&'a (dyn Fn(&'static str, f32) + Sync)>;

/// `MAPLE_PROFILE`-gated progress logger (native only — wasm has neither
/// env vars nor a useful stderr). Same env contract as
/// `pipeline::stage`'s timing output.
#[cfg(not(target_arch = "wasm32"))]
pub fn env_progress() -> Progress<'static> {
    fn log_line(pass: &'static str, frac: f32) {
        eprintln!("[raw-core] deep_denoise {pass:<10} {:>3.0}%", frac * 100.0);
    }
    if std::env::var_os("MAPLE_PROFILE").is_some() {
        Some(&log_line)
    } else {
        None
    }
}

#[cfg(target_arch = "wasm32")]
pub fn env_progress() -> Progress<'static> {
    None
}

/// Non-cancellable wrapper — see [`apply_cancellable`].
pub fn apply(img: &mut Image, strength: f32, progress: Progress<'_>) {
    apply_cancellable(img, strength, CancelToken::never(), progress);
}

/// Apply BM3D deep denoise. `strength` is the `papp:DeepDenoise` slider
/// value in `[0, 100]`; `< 1e-3` (the default 0) is an exact
/// bit-identical skip. A cancel mid-run discards all partial work — the
/// image is only rewritten after both passes complete (the develop
/// chain's post-stage check then surfaces `Error::Cancelled`).
pub fn apply_cancellable(
    img: &mut Image,
    strength: f32,
    cancel: CancelToken<'_>,
    progress: Progress<'_>,
) {
    img.assert_space(ColorSpace::SceneLinearRec2020);
    if strength < 1e-3 {
        return;
    }
    let w = img.width as usize;
    let h = img.height as usize;
    if w < BLOCK || h < BLOCK {
        return; // no 8×8 patch fits — nothing meaningful to denoise
    }
    let s = strength.min(100.0) / 100.0;

    // Opponent planes.
    let y: Vec<f32> = img
        .pixels
        .par_iter()
        .map(|p| LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2])
        .collect();
    let c1: Vec<f32> = img
        .pixels
        .par_iter()
        .zip(y.par_iter())
        .map(|(p, &yy)| p[0] - yy)
        .collect();
    let c2: Vec<f32> = img
        .pixels
        .par_iter()
        .zip(y.par_iter())
        .map(|(p, &yy)| p[2] - yy)
        .collect();

    // Median-luma anchor on a subsampled grid — deterministic, robust.
    let mut sample: Vec<f32> = y.iter().step_by(8).copied().collect();
    sample.sort_unstable_by(|a, b| a.total_cmp(b));
    let anchor = sample[sample.len() / 2] + ANCHOR_PEDESTAL;

    let sigma_y = SIGMA_K * s * anchor;
    let sigmas = [
        sigma_y,
        CHROMA_SIGMA_RATIO * sigma_y,
        CHROMA_SIGMA_RATIO * sigma_y,
    ];
    let tau_sq = T_MATCH_SQ * sigma_y * sigma_y;

    let noisy = [y, c1, c2];
    let cancelled = || cancel.is_cancelled();

    // Pass 1 — hard threshold → basic estimate.
    let Some(basic) = run_pass(
        &noisy,
        w,
        h,
        sigmas,
        tau_sq,
        PassKind::Hard,
        "pass 1/2",
        progress,
        &cancelled,
    ) else {
        return; // cancelled — leave img untouched
    };
    // Pass 2 — Wiener, guided by the basic estimate.
    let Some(mut fin) = run_pass(
        &noisy,
        w,
        h,
        sigmas,
        tau_sq,
        PassKind::Wiener { basic: &basic },
        "pass 2/2",
        progress,
        &cancelled,
    ) else {
        return;
    };
    drop(basic);

    // High-frequency re-injection (spec § 3.2): unfiltered minus
    // Gaussian-blurred luma, scaled by strength — computed in delta form
    // so a uniform field contributes exactly 0.0.
    let hf = highpass_luma_delta(&noisy[0], w, h);
    fin[0]
        .par_iter_mut()
        .zip(hf.par_iter())
        .for_each(|(v, &d)| *v += HF_K * s * d);

    if cancel.is_cancelled() {
        return;
    }

    // Reconstruct RGB in delta form (exact-zero friendly):
    //   R' = R + δY + δC1,  B' = B + δY + δC2,
    //   G' = G + (δY − wR·δR − wB·δB)/wG   so that Y(out) tracks Y'.
    let (ny, nc1, nc2) = (&noisy[0], &noisy[1], &noisy[2]);
    let (fy, fc1, fc2) = (&fin[0], &fin[1], &fin[2]);
    img.pixels.par_iter_mut().enumerate().for_each(|(i, p)| {
        let dy = fy[i] - ny[i];
        let d1 = fc1[i] - nc1[i];
        let d2 = fc2[i] - nc2[i];
        let dr = dy + d1;
        let db = dy + d2;
        let dg = (dy - LUMA_REC2020[0] * dr - LUMA_REC2020[2] * db) / LUMA_REC2020[1];
        p[0] += dr;
        p[1] += dg;
        p[2] += db;
    });
}

/// `orig − gaussian(orig)` for the luma plane, computed so that a uniform
/// field yields exactly 0.0: each separable blur pass is evaluated as
/// `v + Σwᵢ(vᵢ − v)/Σwᵢ` (the correction term is an exact zero when all
/// neighbors equal the center). 5-tap σ≈1.5 kernel.
fn highpass_luma_delta(y: &[f32], w: usize, h: usize) -> Vec<f32> {
    // exp(-d²/(2·1.5²)) for d = 0..2.
    const KW: [f32; 3] = [1.0, 0.800_737_4, 0.411_112_3];

    // Horizontal pass.
    let mut tmp = vec![0f32; w * h];
    tmp.par_chunks_mut(w).enumerate().for_each(|(row, out)| {
        for x in 0..w {
            let idx = row * w + x;
            let v = y[idx];
            let mut numer = 0f32;
            let mut denom = KW[0];
            for d in 1..=2usize {
                if x >= d {
                    numer += KW[d] * (y[idx - d] - v);
                    denom += KW[d];
                }
                if x + d < w {
                    numer += KW[d] * (y[idx + d] - v);
                    denom += KW[d];
                }
            }
            out[x] = v + numer / denom;
        }
    });
    // Vertical pass + highpass, row-parallel over the output.
    let mut out = vec![0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(yy, orow)| {
        for x in 0..w {
            let idx = yy * w + x;
            let v = tmp[idx];
            let mut numer = 0f32;
            let mut denom = KW[0];
            for d in 1..=2usize {
                if yy >= d {
                    numer += KW[d] * (tmp[idx - d * w] - v);
                    denom += KW[d];
                }
                if yy + d < h {
                    numer += KW[d] * (tmp[idx + d * w] - v);
                    denom += KW[d];
                }
            }
            let blurred = v + numer / denom;
            orow[x] = y[idx] - blurred;
        }
    });
    out
}
