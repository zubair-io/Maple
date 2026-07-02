//! Apply path for fitted [`ProfileCurve`]s.
//!
//! Split out of `mod.rs` to keep that file under the 600-LOC hard
//! budget. Pure functions; no I/O.

use super::curve::{self, ProfileCurve, IDENTITY_MATRIX};
use crate::view::encode::srgb_gamma;

#[inline]
pub fn srgb_gamma_decode(y: f32) -> f32 {
    if y <= 0.04045 {
        y / 12.92
    } else {
        ((y + 0.055) / 1.055).powf(2.4)
    }
}

/// Soft-knee compression: identity for `x ≤ KNEE`, smooth roll-off
/// to asymptote 1.0 above. The knee at 0.95 keeps midtones bit-
/// identical to the prior clamp behavior — only HDR highlights are
/// compressed. Earlier full Reinhard (`x/(1+x)`) compressed even
/// midtones (`0.5 → 0.333`), which measurably regressed sRGB fixtures
/// (test_0003 3.67→4.16, test_0007 1.78→1.96). Soft-knee preserves
/// the test_0017 HDR fix without the midtone tax.
///
/// Apply-side mirror: every input pixel must pass through
/// `compress_input` before evaluating the curve so domain matches fit.
#[inline]
pub fn compress_input(x: f32) -> f32 {
    let x = x.max(0.0);
    const KNEE: f32 = 0.95;
    if x <= KNEE {
        x
    } else {
        // Smooth asymptote: knee + (1-knee) * (1 - 1/(1 + (x-knee)/(1-knee)))
        let over = (x - KNEE) / (1.0 - KNEE);
        KNEE + (1.0 - KNEE) * (over / (1.0 + over))
    }
}

/// Apply a `ProfileCurve` to a packed RGB f32 buffer in place.
///
/// Buffer layout: row-major `[R, G, B, R, G, B, ...]`. Each pixel is
/// passed through [`compress_input`] (negatives clamp to 0; soft-knee
/// asymptote above `KNEE=0.95`) before evaluating the per-channel curve,
/// then the optional `matrix` applies a cross-channel 3×3 correction.
///
/// The matrix + Oklab corrections below are only active when the curve
/// carries non-identity values; the #550 display-space fit
/// ([`super::fit_display::fit_curve_from_raw_display`]) sets them to
/// identity / zero (AgX owns chroma + cross-channel coupling now), so the
/// hot loop short-circuits to the per-channel curve alone. `compress_input`
/// is likewise inert in `[0, 1]` display space — it only bites the
/// scene-linear HDR values the curve previously consumed before AgX.
pub fn apply_curve(rgb: &mut [f32], curve: &ProfileCurve) {
    use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
    let m = &curve.matrix;
    let identity = m == &IDENTITY_MATRIX;

    let sig_r = curve.lightness_offset;
    let sig_g = curve.chroma_offset[0];
    let sig_b = curve.chroma_offset[1];
    let has_base_curve = sig_r >= 0.1 && sig_g >= 0.1 && sig_b >= 0.1;

    let chroma_boost = curve.chroma_boost;
    let (chroma_off, l_off) = if has_base_curve {
        ([0.0, 0.0], 0.0)
    } else {
        (curve.chroma_offset, curve.lightness_offset)
    };

    let l_band = curve.lightness_band_offsets;
    let ab_band = curve.ab_band_offsets;
    let any_l_band = l_band.iter().any(|v| v.abs() > 1e-4);
    let any_ab_band = ab_band
        .iter()
        .any(|v| v[0].abs() > 1e-4 || v[1].abs() > 1e-4);
    let apply_chroma = (chroma_boost - 1.0).abs() > 1e-4
        || chroma_off[0].abs() > 1e-4
        || chroma_off[1].abs() > 1e-4
        || l_off.abs() > 1e-4
        || any_l_band
        || any_ab_band;
    for chunk in rgb.chunks_exact_mut(3) {
        let r0 = if has_base_curve {
            let r_lin = srgb_gamma_decode(chunk[0]);
            srgb_gamma(r_lin / (r_lin + sig_r))
        } else {
            compress_input(chunk[0])
        };
        let g0 = if has_base_curve {
            let g_lin = srgb_gamma_decode(chunk[1]);
            srgb_gamma(g_lin / (g_lin + sig_g))
        } else {
            compress_input(chunk[1])
        };
        let b0 = if has_base_curve {
            let b_lin = srgb_gamma_decode(chunk[2]);
            srgb_gamma(b_lin / (b_lin + sig_b))
        } else {
            compress_input(chunk[2])
        };
        let (r1, g1, b1) = if identity {
            (r0, g0, b0)
        } else {
            // Apply matrix in display-linear space BEFORE curves
            let r_lin = srgb_gamma_decode(r0);
            let g_lin = srgb_gamma_decode(g0);
            let b_lin = srgb_gamma_decode(b0);
            let r_adapt = m[0][0] * r_lin + m[0][1] * g_lin + m[0][2] * b_lin;
            let g_adapt = m[1][0] * r_lin + m[1][1] * g_lin + m[1][2] * b_lin;
            let b_adapt = m[2][0] * r_lin + m[2][1] * g_lin + m[2][2] * b_lin;
            (
                srgb_gamma(r_adapt),
                srgb_gamma(g_adapt),
                srgb_gamma(b_adapt),
            )
        };
        let mut r2 = curve::eval_channel(&curve.r, r1);
        let mut g2 = curve::eval_channel(&curve.g, g1);
        let mut b2 = curve::eval_channel(&curve.b, b1);
        if apply_chroma {
            // Oklab: scale chroma around neutral, then offset (a, b)
            // to correct residual hue cast (test_0010 yellow-green).
            // Both preserve L. Offset applies AFTER scale so it's a
            // true centroid shift not amplified by the boost.
            let lab = rec2020_to_oklab([r2, g2, b2]);
            // Bin by Rec.709 luma on the post-curve+matrix RGB to match
            // the fit-time binning. Oklab L was misaligned (different
            // scale: Oklab L 0.79 ≈ Rec.709 luma 0.5). Piecewise-linear
            // interp over 5 anchors at Y=0/0.25/0.5/0.75/1.0.
            let y_post = (0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2).clamp(0.0, 1.0);
            let scaled_pos = y_post * 4.0;
            let lo = scaled_pos.floor() as usize;
            let hi = (lo + 1).min(4);
            let t = scaled_pos - lo as f32;
            let band_l_corr = l_band[lo] * (1.0 - t) + l_band[hi] * t;
            let band_a_corr = ab_band[lo][0] * (1.0 - t) + ab_band[hi][0] * t;
            let band_b_corr = ab_band[lo][1] * (1.0 - t) + ab_band[hi][1] * t;
            let scaled = [
                lab[0] + l_off + band_l_corr,
                lab[1] * chroma_boost + chroma_off[0] + band_a_corr,
                lab[2] * chroma_boost + chroma_off[1] + band_b_corr,
            ];
            let back = oklab_to_rec2020(scaled);
            r2 = back[0];
            g2 = back[1];
            b2 = back[2];
        }
        chunk[0] = r2;
        chunk[1] = g2;
        chunk[2] = b2;
    }
}
