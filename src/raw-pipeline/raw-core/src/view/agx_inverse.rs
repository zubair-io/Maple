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
//!   → sig = inset·(sn/n) → out = OUTSET·sig → oklab_gamut_compress(out)
//! where `sigmoid_curve(x) = sample_lut(MID_NORM + (log_encode(x) - MID_NORM)·slope)`
//! and `OUTSET = inv(INSET)`.

use crate::color::matrices::M_REC2020_TO_SRGB;
use crate::view::agx::{
    self, lut, AGX_INSET_MATRIX, AGX_LUT_SIZE, AGX_MAX_EV, AGX_MID_GRAY, AGX_MIN_EV,
    AGX_OUTSET_MATRIX, MID_NORM,
};

/// Below this, the forward ratio-preserving sigmoid collapsed the pixel to a
/// neutral floor and the `sn/n` scale is undefined — invert to black.
const RATIO_FLOOR: f32 = 1e-6;

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
    let frac = if denom > 1e-12 { (y - l[lo]) / denom } else { 0.0 };
    ((lo as f32) + frac) / ((AGX_LUT_SIZE - 1) as f32)
}

/// Invert AgX for a single display-linear Rec.2020 pixel back to scene-linear
/// Rec.2020, given the same `slope` the forward pass used
/// (`slope = 1 + (contrast/100)*0.5`). In-gamut assumption: the forward
/// `oklab_gamut_compress` is treated as identity (it is for in-gamut pixels).
pub fn inverse_agx_pixel(display: [f32; 3], slope: f32) -> [f32; 3] {
    // 1) Undo the outset matrix (inv(OUTSET) == INSET).
    let sig = matrix_mul(&AGX_INSET_MATRIX, display);
    // 2) Ratio-preserving forward => max channel of `sig` equals sigmoid(norm).
    let sn = sig[0].max(sig[1]).max(sig[2]);
    if sn <= RATIO_FLOOR {
        return [0.0, 0.0, 0.0];
    }
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
                assert!(rel < 0.02, "neutral {} ch{} rel err {} (back={:?})", v, c, rel, back);
            }
        }
    }

    #[test]
    fn roundtrip_midtone_color_preserves_hue_and_value() {
        // In-gamut colored mid-tones round-trip within a few percent.
        let cases = [[0.22f32, 0.14, 0.09], [0.10, 0.18, 0.12], [0.12, 0.13, 0.25]];
        for scene in cases {
            let disp = forward(scene, 0.0);
            let back = inverse_agx_pixel(disp, 1.0);
            for c in 0..3 {
                let rel = (back[c] - scene[c]).abs() / scene[c].max(1e-3);
                assert!(rel < 0.05, "color {:?} ch{} rel err {} (back={:?})", scene, c, rel, back);
            }
        }
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
