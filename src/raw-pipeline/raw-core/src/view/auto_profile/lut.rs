//! Per-image color LUT: a smooth Nᶟ RGB→RGB grid applied by trilinear interpolation.
//! Value-keyed (no atan2 / ÷L) + smooth ⇒ spatially coherent (cannot blotch).
//!
//! In the render path this layers **after** the #550 per-channel curve: the fit
//! entry points are handed the already-curved display buffer, so the sampled
//! pairs are `(curve(maple), jpeg)` and the grid carries only the cross-channel
//! residual the separable curve can't (`fit_lut_from_pairs` seeds identity and
//! adds a confidence-weighted delta, so a tiny residual ⇒ near-identity LUT ⇒
//! `strength = 0` reproduces the pure #550 curve exactly).
use rayon::prelude::*;

// The fit entry points live in the sibling `lut_fit.rs` (600-LOC budget split);
// re-exported here so callers keep addressing them as `lut::fit_lut_from_*`.
pub use super::lut_fit::{fit_lut_from_pairs, fit_lut_from_preview};

/// Grid layout matches `bake.rs`: index = ((b*N + g)*N + r)*3 + c, values in [0,1].
#[derive(Clone, Debug, PartialEq)]
pub struct ColorLut {
    pub size: usize,
    pub data: Vec<f32>,
}

impl ColorLut {
    /// Identity LUT of `size` nodes per axis (clamped to ≥2).
    pub fn identity(size: usize) -> Self {
        let n = size.max(2);
        let mut data = vec![0.0f32; n * n * n * 3];
        let denom = (n - 1) as f32;
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = r as f32 / denom;
                    data[i + 1] = g as f32 / denom;
                    data[i + 2] = b as f32 / denom;
                }
            }
        }
        Self { size: n, data }
    }

    #[inline]
    fn node(&self, r: usize, g: usize, b: usize) -> [f32; 3] {
        let n = self.size;
        let i = ((b * n + g) * n + r) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }

    /// Tetrahedral lookup of one RGB triplet (inputs clamped to [0,1]).
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = self.size;
        let last = (n - 1) as f32;
        let mut lo = [0usize; 3];
        let mut f = [0f32; 3];
        for c in 0..3 {
            let p = rgb[c].clamp(0.0, 1.0) * last;
            let l = p.floor().min(last - 1.0);
            lo[c] = l as usize;
            f[c] = p - l;
        }

        let fx = f[0];
        let fy = f[1];
        let fz = f[2];

        let mut out = [0.0f32; 3];
        let c000 = self.node(lo[0], lo[1], lo[2]);
        let c100 = self.node(lo[0] + 1, lo[1], lo[2]);
        let c010 = self.node(lo[0], lo[1] + 1, lo[2]);
        let c110 = self.node(lo[0] + 1, lo[1] + 1, lo[2]);
        let c001 = self.node(lo[0], lo[1], lo[2] + 1);
        let c101 = self.node(lo[0] + 1, lo[1], lo[2] + 1);
        let c011 = self.node(lo[0], lo[1] + 1, lo[2] + 1);
        let c111 = self.node(lo[0] + 1, lo[1] + 1, lo[2] + 1);

        for c in 0..3 {
            out[c] = if fx >= fy {
                if fy >= fz {
                    c000[c] * (1.0 - fx) + c100[c] * (fx - fy) + c110[c] * (fy - fz) + c111[c] * fz
                } else if fx >= fz {
                    c000[c] * (1.0 - fx) + c100[c] * (fx - fz) + c101[c] * (fz - fy) + c111[c] * fy
                } else {
                    c000[c] * (1.0 - fz) + c001[c] * (fz - fx) + c101[c] * (fx - fy) + c111[c] * fy
                }
            } else {
                if fx >= fz {
                    c000[c] * (1.0 - fy) + c010[c] * (fy - fx) + c110[c] * (fx - fz) + c111[c] * fz
                } else if fy >= fz {
                    c000[c] * (1.0 - fy) + c010[c] * (fy - fz) + c011[c] * (fz - fx) + c111[c] * fx
                } else {
                    c000[c] * (1.0 - fz) + c001[c] * (fz - fy) + c011[c] * (fy - fx) + c111[c] * fx
                }
            };
        }
        out
    }

    /// Apply in place to an interleaved RGB f32 buffer (DisplayEncodedSrgb, [0,1]).
    pub fn apply(&self, rgb: &mut [f32]) {
        rgb.par_chunks_mut(3).for_each(|p| {
            let o = self.sample([p[0], p[1], p[2]]);
            p[0] = o[0];
            p[1] = o[1];
            p[2] = o[2];
        });
    }

    /// Apply with a residual strength `k`: `p' = p + k·(sample(p) − p)`.
    ///
    /// Strength is an APPLY-time knob since #1085 — the fit always produces
    /// (and the cache stores) the full-strength LUT, so `MAPLE_AUTO_LUT_STRENGTH`
    /// can never be baked into a cached artifact. Because trilinear sampling is
    /// linear in the node values and the identity grid reproduces its input,
    /// this lerp equals sampling a `with_strength(k)`-scaled LUT (up to float
    /// rounding, and up to the node clamp at the gamut corners for `k < 1`).
    /// `k == 1.0` routes through [`ColorLut::apply`] (bit-identical to the
    /// pre-#1085 full-strength apply); `k == 0.0` is an exact no-op.
    pub fn apply_with_strength(&self, rgb: &mut [f32], k: f32) {
        if k == 0.0 {
            return;
        }
        if k == 1.0 {
            self.apply(rgb);
            return;
        }
        rgb.par_chunks_mut(3).for_each(|p| {
            let o = self.sample([p[0], p[1], p[2]]);
            p[0] += k * (o[0] - p[0]);
            p[1] += k * (o[1] - p[1]);
            p[2] += k * (o[2] - p[2]);
        });
    }

    /// A copy with the residual scaled toward identity by `k`:
    /// `node' = clamp01(id + k·(node − id))`. `k == 1.0` is a plain clone.
    /// Used by the GPU fit entries to honour `MAPLE_AUTO_LUT_STRENGTH` on the
    /// RETURNED artifact while the cache keeps the canonical full-strength LUT
    /// (#1085).
    pub fn with_strength(&self, k: f32) -> ColorLut {
        if k == 1.0 {
            return self.clone();
        }
        let id = ColorLut::identity(self.size);
        let mut out = self.clone();
        for (o, i) in out.data.iter_mut().zip(&id.data) {
            *o = (i + k * (*o - i)).clamp(0.0, 1.0);
        }
        out
    }
}

/// `MAPLE_AUTO_LUT_STRENGTH` (default `1.0`) — the verify-harness knob that
/// blends the residual toward identity (`0` ⇒ exactly the #550 curve, the
/// accuracy floor). Read at APPLY/RETURN time, never at fit time (#1085).
///
/// Invalid values (non-finite, or outside `[0.0, 2.0]`) are rejected with a
/// warning and replaced by the default `1.0`.
pub fn lut_strength_from_env() -> f32 {
    let Some(env_val) = std::env::var("MAPLE_AUTO_LUT_STRENGTH").ok() else {
        return 1.0;
    };
    let strength = env_val.parse::<f32>().unwrap_or(1.0);
    if strength.is_finite() && (0.0..=2.0).contains(&strength) {
        strength
    } else {
        eprintln!(
            "MAPLE_AUTO_LUT_STRENGTH={env_val} out of range [0,2] or non-finite — using 1.0"
        );
        1.0
    }
}

/// `MAPLE_DISABLE_AUTO_LUT` — when set, the residual-LUT stage is skipped
/// ENTIRELY: no pair sampling, no fit, no cache insert, nothing applied or
/// returned (#1085; pre-fix only the apply was gated, so the fit still ran
/// and its result was cached).
pub fn lut_disabled_by_env() -> bool {
    std::env::var_os("MAPLE_DISABLE_AUTO_LUT").is_some()
}

// Tests live in the sibling `lut_tests.rs` so this file stays under the
// 600-LOC budget (same `#[path]` split pattern as `stages/nlm.rs`).
#[cfg(test)]
#[path = "lut_tests.rs"]
mod tests;
