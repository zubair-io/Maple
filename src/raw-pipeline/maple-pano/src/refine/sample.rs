//! Sampling and peak-fit primitives for [`super`] (#1210). Split from
//! `refine/mod.rs` for the file-size budget: bilinear luma access, the
//! (optionally warped) patch grid, and the 3-point parabolic sub-pixel
//! fit. All conventions (continuous pixel coordinates, texel centers at
//! half-integers, fallback-on-OOB/invalid honesty) are the parent
//! module's.

use crate::ingest::PlanarImage;

/// Identity template warp (axis-aligned sampling) — used when no pair
/// geometry is supplied or the local Jacobian is unusable.
pub(super) const IDENTITY_WARP: [f64; 4] = [1.0, 0.0, 0.0, 1.0];

/// Rec.709 luma weights — a fixed scalar projection of the scene-linear
/// planes for matching (see the parent module docs).
const LUMA_R: f64 = 0.2126;
const LUMA_G: f64 = 0.7152;
const LUMA_B: f64 = 0.0722;

/// 3-point parabolic sub-pixel offset from samples at −1/0/+1 (the
/// `pano_metrics.py wrap_closure` pattern), clamped to ±0.5 — a true
/// interior peak cannot refine past the midpoint to a neighbor.
/// Neighbors at −∞ (flat-skipped candidates) or a degenerate curvature
/// yield 0 — integer-peak honesty over fabricated precision.
pub(super) fn parabolic_delta(y0: f64, y1: f64, y2: f64) -> f64 {
    if !(y0.is_finite() && y2.is_finite()) {
        return 0.0;
    }
    let denom = y0 - 2.0 * y1 + y2;
    if denom.abs() <= 1e-12 {
        return 0.0;
    }
    (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5)
}

/// Mean and sum of squared deviations of a sample vector.
pub(super) fn mean_ssd(values: &[f64]) -> (f64, f64) {
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let ssd = values.iter().map(|v| (v - mean) * (v - mean)).sum();
    (mean, ssd)
}

/// Luma grid of side `2·half + 1` around `center` (continuous pixel
/// coordinates), sampled at `center + m·(i, j)` for integer offsets
/// `(i, j)` — `m` row-major 2×2; the identity gives plain axis-aligned
/// sampling, a warp matrix samples the patch in the other frame's local
/// geometry ([`super::warp`]). `None` when any sample's bilinear stencil
/// leaves the exact-support domain or touches an invalid pixel — the
/// caller falls back rather than matching against clamped/undefined
/// content.
/// `sample_luma_grid` writing into a caller-owned buffer (cleared
/// first) — the refine hot loop runs per match, so per-call `Vec`
/// allocation is measurable churn at tens of thousands of matches
/// (PR #1213 review). `false` leaves `out` in an unspecified state.
pub(super) fn sample_luma_grid_into(
    img: &PlanarImage,
    center: (f64, f64),
    half: i64,
    m: &[f64; 4],
    out: &mut Vec<f64>,
) -> bool {
    let side = (2 * half + 1) as usize;
    out.clear();
    out.reserve(side * side);
    for j in -half..=half {
        let (fi0, fj) = (-half as f64, j as f64);
        let mut x = center.0 + m[0] * fi0 + m[1] * fj;
        let mut y = center.1 + m[2] * fi0 + m[3] * fj;
        for _ in -half..=half {
            let Some(v) = luma_bilinear(img, x, y) else {
                return false;
            };
            out.push(v);
            x += m[0];
            y += m[2];
        }
    }
    true
}

#[cfg(test)]
pub(super) fn sample_luma_grid(
    img: &PlanarImage,
    center: (f64, f64),
    half: i64,
    m: &[f64; 4],
) -> Option<Vec<f64>> {
    let mut out = Vec::new();
    sample_luma_grid_into(img, center, half, m, &mut out).then_some(out)
}

/// Bilinear luma at a continuous pixel coordinate (texel centers at
/// half-integers, crate convention). `None` outside `[0.5, dim − 0.5]`
/// per axis (where the 2×2 stencil is fully in-frame) or when any
/// stencil texel is invalid.
pub(super) fn luma_bilinear(img: &PlanarImage, x: f64, y: f64) -> Option<f64> {
    let (w, h) = (i64::from(img.width()), i64::from(img.height()));
    let (u, v) = (x - 0.5, y - 0.5);
    let (x0f, y0f) = (u.floor(), v.floor());
    let (x0, y0) = (x0f as i64, y0f as i64);
    if x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h {
        return None;
    }
    for (tx, ty) in [(x0, y0), (x0 + 1, y0), (x0, y0 + 1), (x0 + 1, y0 + 1)] {
        if !img.validity.get(tx as u32, ty as u32) {
            return None;
        }
    }
    let (fx, fy) = (u - x0f, v - y0f);
    let stride = img.width() as usize;
    let idx = (y0 as usize) * stride + x0 as usize;
    let luma = |i: usize| {
        LUMA_R * f64::from(img.r[i]) + LUMA_G * f64::from(img.g[i]) + LUMA_B * f64::from(img.b[i])
    };
    let top = luma(idx) * (1.0 - fx) + luma(idx + 1) * fx;
    let bot = luma(idx + stride) * (1.0 - fx) + luma(idx + stride + 1) * fx;
    Some(top * (1.0 - fy) + bot * fy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parabolic_delta_is_clamped_and_degenerate_safe() {
        assert_eq!(parabolic_delta(f64::NEG_INFINITY, 1.0, 0.5), 0.0);
        assert_eq!(parabolic_delta(0.5, 0.5, 0.5), 0.0); // flat curvature
        let d = parabolic_delta(0.2, 1.0, 0.9);
        assert!(d > 0.0 && d <= 0.5, "peak leans right: {d}");
        // Non-peak (malformed) samples would extrapolate past a neighbor —
        // the clamp keeps the offset inside the integer peak's half-cell.
        assert_eq!(parabolic_delta(0.0, 0.5, 2.0), -0.5);
    }
}
