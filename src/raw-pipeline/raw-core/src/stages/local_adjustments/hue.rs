//! Per-pixel Oklab hue rotation for the local `hue` control (#3269).
//!
//! Rotates the `(a, b)` chroma vector by `delta_rad`, preserving `L` and the
//! chroma magnitude, then applies the SAME soft-knee gamut handling the
//! saturation stage uses (`saturation::{bisect_gamut_hull, soft_compress}`):
//! the Rec.2020 hull is not hue-invariant, so a rotation alone can push a
//! channel negative even though chroma never grew (the #1748 lesson from the
//! HSL stage). No `.max(c_in)` floor on the compressed chroma — see
//! `hsl.rs`'s note on why that floor re-emits the negative channel.

use crate::color::oklab::{oklab_to_rec2020, rec2020_to_oklab};
use crate::stages::saturation::{bisect_gamut_hull, soft_compress, GAMUT_EPS};

/// Rotate `rgb`'s Oklab hue by `delta_rad`. Near-neutral input (chroma below
/// `1e-6`) passes through bit-identically — hue is undefined there and the
/// unit chroma vector would be ill-conditioned.
#[inline]
pub(crate) fn rotate_pixel(rgb: [f32; 3], delta_rad: f32) -> [f32; 3] {
    let lab = rec2020_to_oklab(rgb);
    let (l, a, b) = (lab[0], lab[1], lab[2]);
    let c = (a * a + b * b).sqrt();
    if c < 1e-6 {
        return rgb;
    }
    let (a_hat, b_hat) = (a / c, b / c);
    let (sin_dh, cos_dh) = delta_rad.sin_cos();
    let rot_a = a_hat * cos_dh - b_hat * sin_dh;
    let rot_b = a_hat * sin_dh + b_hat * cos_dh;
    let target = oklab_to_rec2020([l, rot_a * c, rot_b * c]);
    if target[0].min(target[1]).min(target[2]) >= -GAMUT_EPS {
        return target;
    }
    let c_hull = bisect_gamut_hull(l, rot_a, rot_b, c);
    let c_out = soft_compress(c, c_hull);
    oklab_to_rec2020([l, rot_a * c_out, rot_b * c_out])
}
