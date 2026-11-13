//! Gamut-preserving Auto for Display-P3 output (#4741).
//!
//! The Auto tail (curve, then residual LUT) is fitted and evaluated only on
//! sRGB-encoded display values. A P3 render therefore runs the unchanged tail on
//! the pixel the sRGB render would have produced, then hands back the
//! colourfulness the sRGB gamut compression removed, re-expressed in P3:
//!
//! 1. `S` = sRGB-compressed pixel, `P` = Neutral's P3-compressed pixel.
//! 2. `r = C(P) / C(S)` (Oklab chroma). Both compressions scale chroma only, at
//!    constant lightness and hue, so `r >= 1` and `r = 1` wherever sRGB left the
//!    pixel alone.
//! 3. The tail runs on `gamma(S)`, always inside `[0, 1]^3`: nothing is clamped.
//! 4. The tail output's Oklab `a, b` are multiplied by `r` and converted to P3.
//!    A result that leaves the P3 cube (the tail raised chroma past the hull) has
//!    its chroma clipped to the hull at constant lightness and hue: continuous at
//!    the hull, where re-running the soft knee would squeeze the already
//!    compressed `P` a second time.
//!
//! An identity tail reproduces Neutral P3 bit for bit; `r = 1` pixels are a plain
//! 3x3 colour-management of the sRGB render.

use super::*;
use crate::color::matrices::M_SRGB_TO_P3;
use crate::color::oklab_gamut_clip::clip_chroma_to_unit_cube_oklab;
use crate::view::agx_inverse::srgb_gamma_inv;

type Rgb = [f32; 3];

const CHROMA_FLOOR: f32 = 1e-5;

fn compress_srgb(linear: Rgb) -> Rgb {
    compress_to_unit_cube_oklab(linear, srgb_linear_to_oklab, oklab_to_srgb_linear)
}

fn compress_p3(linear: Rgb) -> Rgb {
    compress_to_unit_cube_oklab(linear, p3_linear_to_oklab, oklab_to_p3_linear)
}

fn clip_to_p3_hull(linear: Rgb) -> Rgb {
    clip_chroma_to_unit_cube_oklab(linear, p3_linear_to_oklab, oklab_to_p3_linear)
}

fn gamma_encode(linear: Rgb) -> Rgb {
    linear.map(srgb_gamma)
}

fn gamma_decode(encoded: Rgb) -> Rgb {
    encoded.map(srgb_gamma_inv)
}

fn same_bits(a: Rgb, b: Rgb) -> bool {
    a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

fn oklab_chroma(lab: Rgb) -> f32 {
    lab[1].hypot(lab[2])
}

/// How much chroma P3 keeps that sRGB gave up; `1.0` for neutrals and anything
/// non-finite.
fn headroom_ratio(srgb_chroma: f32, p3_chroma: f32) -> f32 {
    let ratio = p3_chroma / srgb_chroma;
    if srgb_chroma > CHROMA_FLOOR && ratio.is_finite() {
        ratio.max(1.0)
    } else {
        1.0
    }
}

/// One pixel of the P3 Auto render: linear display Rec.2020 in, P3-gamma-encoded
/// out. `tail` maps an sRGB-encoded triple to the Auto-adjusted sRGB-encoded one.
pub(crate) fn p3_auto_pixel(rec2020: Rgb, tail: &impl Fn(Rgb) -> Rgb) -> Rgb {
    let srgb_uncompressed = M_REC2020_TO_SRGB.mul_vec(rec2020);
    let srgb = compress_srgb(srgb_uncompressed);
    let tail_in = gamma_encode(srgb);
    let tail_out = tail(tail_in);
    let neutral_p3 = || compress_p3(M_REC2020_TO_P3.mul_vec(rec2020));
    if same_bits(tail_out, tail_in) {
        return gamma_encode(neutral_p3());
    }
    let tail_linear = gamma_decode(tail_out);
    if same_bits(srgb, srgb_uncompressed) {
        return gamma_encode(M_SRGB_TO_P3.mul_vec(tail_linear));
    }
    let ratio = headroom_ratio(
        oklab_chroma(srgb_linear_to_oklab(srgb)),
        oklab_chroma(p3_linear_to_oklab(neutral_p3())),
    );
    let [l, a, b] = srgb_linear_to_oklab(tail_linear);
    gamma_encode(clip_to_p3_hull(oklab_to_p3_linear([
        l,
        a * ratio,
        b * ratio,
    ])))
}

/// Display-linear Rec.2020 → P3-encoded display values with the Auto tail
/// applied gamut-preservingly. Leaves the buffer tagged like
/// [`srgb_gamma_encode`] does.
pub fn rec2020_to_p3_auto_encoded(img: &mut Image, tail: impl Fn(Rgb) -> Rgb + Sync) {
    img.assert_space(ColorSpace::DisplayLinearRec2020);
    img.pixels
        .par_iter_mut()
        .for_each(|p| *p = p3_auto_pixel(*p, &tail));
    img.space = ColorSpace::DisplayEncodedSrgb;
}

#[cfg(test)]
#[path = "encode_p3_auto_tests.rs"]
mod tests;
