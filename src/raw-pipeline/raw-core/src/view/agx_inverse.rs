//! Inverse AgX view transform: display-linear Rec.2020 → scene-linear Rec.2020.
//!
//! Exact for in-gamut midtones; bounded-error (clamped) at the AgX toe/shoulder.
//! Assumes in-gamut chroma — the forward Oklab gamut-compress is many-to-one at
//! the gamut wall and is treated as identity here (design doc §3b). This is the
//! novel, load-bearing piece behind synthetic-raw inpainting: it turns a model's
//! display-referred output back into scene-linear values that grade like sensor
//! data.
//!
//! Forward reference (`view::agx::agx_pixel`):
//!   inset = INSET·scene → n = max(inset) → sn = sigmoid_curve(n)
//!   → sig = inset·(sn/n) → sig' = sig + w(sn)·(sn − sig)   (#1624 path-to-white)
//!   → out = OUTSET·sig' → oklab_gamut_compress(out)
//! The path-to-white lerp leaves the max channel at `sn`, so `sn` is read
//! straight off the inverted outset and the lerp inverts exactly:
//! `sig = (sig' − w·sn) / (1 − w)` — down to the point where that divisor
//! stops being numerically safe, below which the pixel inverts as the neutral
//! it had already become. See [`P2W_INVERSE_MIN_RESIDUAL`].
//! where `sigmoid_curve(x) = sample_lut(MID_NORM + (log_encode(x) - MID_NORM)·slope)`
//! and `OUTSET = inv(INSET)`.

use crate::color::matrices::M_REC2020_TO_SRGB;
use crate::view::agx::{
    lut, path_to_white_weight, AGX_INSET_MATRIX, AGX_LUT_SIZE, AGX_MAX_EV, AGX_MID_GRAY,
    AGX_MIN_EV, AGX_OUTSET_MATRIX, MID_NORM,
};

/// Below this, the forward ratio-preserving sigmoid collapsed the pixel to a
/// neutral floor and the `sn/n` scale is undefined — invert to black.
const RATIO_FLOOR: f32 = 1e-6;

/// Smallest `1 - w` the #1624 path-to-white inverse will divide by.
///
/// Undoing the forward lerp is `sig = (sig' - w·sn) / (1 - w)`, so the divisor
/// is an error amplifier of `1 / (1 - w)` acting on `sig'`, which carries f32
/// round-off of about `2^-24`. The amplified relative error on the recovered
/// chroma therefore grows without bound as `w → 1`:
///
/// ```text
///   sn        w             1 - w      recovered-chroma rel. err
///   0.99      0.934444      6.6e-02    9.1e-07
///   0.999     0.993344      6.7e-03    9.0e-06
///   0.9999    0.999333      6.7e-04    8.9e-05
///   0.99999   0.999933      6.7e-05    8.9e-04
///   0.999999  0.999993      6.7e-06    8.9e-03
/// ```
///
/// Snapping to the neutral instead is not an approximation of convenience —
/// it is the correct limit. At `w` this close to 1 the forward pass has shed
/// all but `1 - w` of the pixel's chroma, so the chroma the division is trying
/// to recover was genuinely destroyed and the inverse is ill-posed. The
/// question is only which error is smaller, and below this threshold the
/// snap's error (bounded by `1 - w`, i.e. 1e-3 of the original chroma) is an
/// order of magnitude *larger* than the amplified noise, while above it the
/// noise wins and diverges. 1e-3 is where they cross: it caps the amplified
/// error at ~6e-5 — comfortably inside the 1e-4 CPU↔GPU parity bar — and only
/// engages for pixels whose sigmoided max exceeds 0.99985, which is already
/// display white for every bit depth we render.
const P2W_INVERSE_MIN_RESIDUAL: f32 = 1e-3;

#[inline]
fn matrix_mul(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// Reverse the monotone forward sigmoid LUT: given display value `y`, return
/// the normalized-log position `x ∈ [0, 1]` with `sample_lut(x) ≈ y`.
///
/// `y` is clamped to `[lut[0], lut[last]]`. The toe/shoulder are flat, so the
/// inverse is ill-conditioned there (sub-LSB display steps → large scene-linear
/// steps); the clamp is the bounded-error guard (design doc §3b). Mirrors the
/// forward `sample_lut` index convention (`x · (AGX_LUT_SIZE - 1)`).
fn inv_lut(y: f32) -> f32 {
    let l = lut();
    let y = y.clamp(l[0], l[AGX_LUT_SIZE - 1]);
    // Binary search the bracketing indices (LUT is monotone nondecreasing).
    let (mut lo, mut hi) = (0usize, AGX_LUT_SIZE - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if l[mid] <= y {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let denom = l[hi] - l[lo];
    let frac = if denom > 1e-12 {
        (y - l[lo]) / denom
    } else {
        0.0
    };
    ((lo as f32) + frac) / ((AGX_LUT_SIZE - 1) as f32)
}

/// Invert AgX for a single display-linear Rec.2020 pixel back to scene-linear
/// Rec.2020, given the same `slope` the forward pass used
/// (`slope = 1 + (contrast/100)*0.5`). In-gamut assumption: the forward
/// `oklab_gamut_compress` is treated as identity (it is for in-gamut pixels).
pub fn inverse_agx_pixel(display: [f32; 3], slope: f32) -> [f32; 3] {
    // 1) Undo the outset matrix (inv(OUTSET) == INSET).
    let sig_p2w = matrix_mul(&AGX_INSET_MATRIX, display);
    // 2) Ratio-preserving forward => max channel of `sig` equals sigmoid(norm),
    //    and the #1624 path-to-white lerp keeps that max fixed, so `sn` is
    //    read off directly; then undo the lerp on the other channels.
    let sn = sig_p2w[0].max(sig_p2w[1]).max(sig_p2w[2]);
    if sn <= RATIO_FLOOR {
        return [0.0, 0.0, 0.0];
    }
    let w = path_to_white_weight(sn);
    let residual = 1.0 - w;
    let sig = if residual < P2W_INVERSE_MIN_RESIDUAL {
        [sn, sn, sn]
    } else {
        [
            (sig_p2w[0] - w * sn) / residual,
            (sig_p2w[1] - w * sn) / residual,
            (sig_p2w[2] - w * sn) / residual,
        ]
    };
    // 3) Reverse the sigmoid LUT, 4) undo the contrast slope, 5) undo log encode.
    let modulated = inv_lut(sn);
    let norm = (modulated - MID_NORM) / slope + MID_NORM;
    let log_v = norm * (AGX_MAX_EV - AGX_MIN_EV) + AGX_MIN_EV;
    let n = AGX_MID_GRAY * log_v.exp2();
    // 6) Undo the ratio scale: inset = sig · (n / sn).
    let scale = n / sn;
    let inset = [sig[0] * scale, sig[1] * scale, sig[2] * scale];
    // 7) Undo the inset matrix (inv(INSET) == OUTSET).
    matrix_mul(&AGX_OUTSET_MATRIX, inset)
}

/// Inverse of the IEC 61966-2-1 sRGB OETF (`view::encode::srgb_gamma`).
pub fn srgb_gamma_inv(y: f32) -> f32 {
    let y = y.clamp(0.0, 1.0);
    if y <= 0.040_449_936 {
        y / 12.92
    } else {
        ((y + 0.055) / 1.055).powf(2.4)
    }
}

/// 8-bit sRGB-encoded RGB → scene-linear Rec.2020, reversing the full view tail
/// (`AgX → rec2020_to_srgb → srgb_gamma → quantize`). In-gamut assumption: the
/// forward Oklab gamut-compress in `rec2020_to_srgb` is treated as identity (it
/// is for in-gamut pixels). Dither is zero-mean sub-LSB and is not modelled.
pub fn display_u8_to_scene_linear(rgb: [u8; 3], slope: f32) -> [f32; 3] {
    let srgb_lin = [
        srgb_gamma_inv(rgb[0] as f32 / 255.0),
        srgb_gamma_inv(rgb[1] as f32 / 255.0),
        srgb_gamma_inv(rgb[2] as f32 / 255.0),
    ];
    let m_inv = M_REC2020_TO_SRGB
        .inverse()
        .expect("M_REC2020_TO_SRGB is invertible");
    let display_rec2020 = m_inv.mul_vec(srgb_lin);
    inverse_agx_pixel(display_rec2020, slope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{ColorSpace, Image};
    use crate::view::agx;

    /// Forward AgX one pixel via the public stage, return display-linear RGB.
    fn forward(scene: [f32; 3], contrast: f32) -> [f32; 3] {
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = scene;
        agx::apply(&mut img, contrast);
        img.pixels[0]
    }

    #[test]
    fn roundtrip_neutral_axis_midtones() {
        // Neutral mid-tones must round-trip to a few-percent relative error.
        for &v in &[0.05f32, 0.10, 0.18, 0.35, 0.6] {
            let scene = [v, v, v];
            let disp = forward(scene, 0.0);
            let slope = 1.0 + (0.0 / 100.0) * 0.5;
            let back = inverse_agx_pixel(disp, slope);
            for c in 0..3 {
                let rel = (back[c] - scene[c]).abs() / scene[c];
                assert!(
                    rel < 0.02,
                    "neutral {} ch{} rel err {} (back={:?})",
                    v,
                    c,
                    rel,
                    back
                );
            }
        }
    }

    #[test]
    fn roundtrip_midtone_color_preserves_hue_and_value() {
        // In-gamut colored mid-tones round-trip within a few percent.
        let cases = [
            [0.22f32, 0.14, 0.09],
            [0.10, 0.18, 0.12],
            [0.12, 0.13, 0.25],
        ];
        for scene in cases {
            let disp = forward(scene, 0.0);
            let back = inverse_agx_pixel(disp, 1.0);
            for c in 0..3 {
                let rel = (back[c] - scene[c]).abs() / scene[c].max(1e-3);
                assert!(
                    rel < 0.05,
                    "color {:?} ch{} rel err {} (back={:?})",
                    scene,
                    c,
                    rel,
                    back
                );
            }
        }
    }

    /// #1624: a bright saturated colour above the path-to-white knee (where
    /// the forward lerp is active but not saturated) must still round-trip —
    /// the inverse undoes the lerp exactly, not just the sigmoid.
    #[test]
    fn roundtrip_bright_saturated_colour_through_path_to_white() {
        let scene = [3.0_f32, 0.9, 0.6];
        let disp = forward(scene, 0.0);
        // Precondition: the forward actually engaged the lerp (in-gamut,
        // so the gamut compress is identity and the round trip is exact).
        let sig = super::matrix_mul(&AGX_INSET_MATRIX, disp);
        let sn = sig[0].max(sig[1]).max(sig[2]);
        let w = path_to_white_weight(sn);
        assert!(
            w > 0.0 && w < 1.0,
            "fixture must engage path-to-white: w={w}"
        );
        let back = inverse_agx_pixel(disp, 1.0);
        for c in 0..3 {
            let rel = (back[c] - scene[c]).abs() / scene[c];
            assert!(
                rel < 0.05,
                "ch{c} rel err {rel} (back={back:?}, scene={scene:?})"
            );
        }
    }

    /// #1624 (Jules review): undoing the path-to-white lerp divides by
    /// `1 - w`, which amplifies f32 round-off without bound as `w → 1`. The
    /// [`P2W_INVERSE_MIN_RESIDUAL`] guard must keep the inverse finite and
    /// ordered right up against display white. The band is reached by
    /// near-NEUTRAL bright pixels, not by saturated ones: the inset matrix is
    /// per-channel desaturating, so a saturated display colour's `sn` tops out
    /// near 0.986 (`1 - w` ≈ 0.09) and never gets close to the divisor cliff.
    #[test]
    fn inverse_stays_stable_as_path_to_white_saturates() {
        // Very slightly tinted whites marching toward display white. The last
        // three entries put `1 - w` at 7.4e-4, 1.4e-4 and 7.5e-5 — inside the
        // guarded band, where the unguarded divide amplifies round-off by
        // 1e3–1e4 and reorders the ramp.
        let ramp = [0.9_f32, 0.99, 0.999, 0.9999, 0.99999, 1.0];
        let mut prev_luma = f32::NEG_INFINITY;
        for v in ramp {
            let display = [v, v * 0.99995, v * 0.9999];
            let back = inverse_agx_pixel(display, 1.0);
            for (c, value) in back.iter().enumerate() {
                assert!(
                    value.is_finite(),
                    "ch{c} not finite at v={v}: back={back:?}"
                );
            }
            // Brighter display in => brighter scene out, with no cliff.
            let luma = back[0].max(back[1]).max(back[2]);
            assert!(
                luma > prev_luma,
                "scene luma not monotone at v={v}: {luma} <= {prev_luma}"
            );
            prev_luma = luma;
        }
    }

    /// #1624 (Jules review): inside the guarded band the forward pass has
    /// already shed all but `1 - w` of the chroma, so the inverse returns the
    /// neutral the pixel had become rather than a noise-amplified
    /// reconstruction of chroma that no longer survives in the input.
    #[test]
    fn inverse_snaps_to_neutral_inside_the_guarded_band() {
        let display = [0.9999_f32, 0.9999 * 0.99995, 0.9999 * 0.9999];
        let sig_p2w = super::matrix_mul(&AGX_INSET_MATRIX, display);
        let sn = sig_p2w[0].max(sig_p2w[1]).max(sig_p2w[2]);
        let residual = 1.0 - path_to_white_weight(sn);
        assert!(
            residual < super::P2W_INVERSE_MIN_RESIDUAL,
            "fixture must land inside the guarded band: 1-w={residual}"
        );
        let back = inverse_agx_pixel(display, 1.0);
        let lo = back[0].min(back[1]).min(back[2]);
        let hi = back[0].max(back[1]).max(back[2]);
        assert!(
            (hi - lo) <= 1e-5 * hi.max(1.0),
            "expected a neutral inside the guarded band, got {back:?}"
        );
        // A pixel just OUTSIDE the band still inverts with its chroma intact —
        // the guard must not swallow ordinary bright colours.
        let outside = [0.999_f32, 0.999 * 0.99995, 0.999 * 0.9999];
        let sig_o = super::matrix_mul(&AGX_INSET_MATRIX, outside);
        let sn_o = sig_o[0].max(sig_o[1]).max(sig_o[2]);
        assert!(1.0 - path_to_white_weight(sn_o) > super::P2W_INVERSE_MIN_RESIDUAL);
        let back_o = inverse_agx_pixel(outside, 1.0);
        let spread =
            back_o[0].max(back_o[1]).max(back_o[2]) - back_o[0].min(back_o[1]).min(back_o[2]);
        assert!(
            spread > 1e-3,
            "chroma must survive outside the band, got {back_o:?}"
        );
    }

    #[test]
    fn roundtrip_under_contrast_slope() {
        // The inverse must use the same slope the forward used.
        let scene = [0.18f32, 0.12, 0.20];
        for &contrast in &[-50.0f32, 0.0, 50.0] {
            let disp = forward(scene, contrast);
            let slope = 1.0 + (contrast / 100.0) * 0.5;
            let back = inverse_agx_pixel(disp, slope);
            for c in 0..3 {
                let rel = (back[c] - scene[c]).abs() / scene[c];
                assert!(rel < 0.05, "contrast {} ch{} rel err {}", contrast, c, rel);
            }
        }
    }

    #[test]
    fn srgb_gamma_inverse_roundtrips() {
        use crate::view::encode::srgb_gamma;
        for i in 0..=255u32 {
            let lin = (i as f32) / 255.0;
            let enc = srgb_gamma(lin);
            let back = super::srgb_gamma_inv(enc);
            assert!((back - lin).abs() < 1e-3, "x={} back={}", lin, back);
        }
    }

    #[test]
    fn full_view_tail_roundtrips_midtone() {
        // scene -> AgX -> rec2020->srgb -> gamma -> u8 -> (inverse) -> scene.
        use crate::view::encode::{dither_and_quantize, rec2020_to_srgb, srgb_gamma_encode};
        let scene = [0.18f32, 0.13, 0.20];
        let mut img = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        img.pixels[0] = scene;
        agx::apply(&mut img, 0.0);
        rec2020_to_srgb(&mut img);
        srgb_gamma_encode(&mut img);
        let u8s = dither_and_quantize(&mut img); // [r, g, b]
        let back = super::display_u8_to_scene_linear([u8s[0], u8s[1], u8s[2]], 1.0);
        for c in 0..3 {
            let rel = (back[c] - scene[c]).abs() / scene[c];
            assert!(rel < 0.06, "ch{} rel {} back={:?}", c, rel, back);
        }
    }
}
