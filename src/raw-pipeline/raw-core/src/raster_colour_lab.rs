//! The colour ops sharp performs in a perceptual space (#3503).
//!
//! `tint(colour)` mirrors sharp's `Tint` (`lib/operations.cc`): every pixel
//! is first reduced to luminance, then each grey level is looked up in a Lab
//! table whose L* is the grey's own L* and whose a*/b* are the tint
//! colour's a*/b* scaled by a luminance-dependent weight that peaks at
//! mid-grey and falls to zero at black and white. `modulate` scales L* by
//! `brightness`, adds `lightness` to it, scales C* by `saturation` and
//! rotates h by `hue` — `sharp::Modulate`, which is a `vips_linear` in LCh
//! space. Both leave the alpha channel unchanged.

use crate::raster::RasterImage;
use crate::raster_colour::REC709_LUMA;
use crate::raster_lab::{lab_to_lch, lab_to_srgb, lch_to_lab, srgb_to_lab};

/// Rewrite the colour samples of every pixel, leaving alpha untouched.
fn map_colour(src: &RasterImage, f: impl Fn([u8; 3]) -> [u8; 3]) -> RasterImage {
    let c = src.channels as usize;
    let data = src
        .data
        .chunks_exact(c)
        .flat_map(|px| {
            let mapped = f([px[0], px[1], px[2]]);
            mapped.into_iter().chain(px.get(3).copied())
        })
        .collect();
    RasterImage {
        width: src.width,
        height: src.height,
        channels: src.channels,
        data,
        orientation: src.orientation,
    }
}

/// Rec.709 luma of the encoded samples, rounded and clamped — the same
/// reduction `RasterImage::greyscale` performs. sharp's `Tint` mixes to
/// luminance before placing each grey on the Lab table.
fn luma(px: [u8; 3]) -> u8 {
    let y = (0..3).map(|i| px[i] as f64 * REC709_LUMA[i]).sum::<f64>();
    y.round().clamp(0.0, 255.0) as u8
}

impl RasterImage {
    /// sharp's `Tint`: reduce each pixel to luminance, then look it up in a
    /// 256-entry Lab table whose L* is the grey's own L* and whose a*/b*
    /// are the tint colour's a*/b* scaled by `w = 1 - 4*(l - 0.5)^2`
    /// (`l = L*/100`) — full tint chroma at mid-grey, zero at black and
    /// white. The table depends only on the tint colour, so it is built
    /// once per call and every pixel is mapped through it.
    pub fn tint(&self, rgb: [u8; 3]) -> Self {
        let tint_lab = srgb_to_lab(rgb);
        let lut: [[u8; 3]; 256] = std::array::from_fn(|y| {
            let l = srgb_to_lab([y as u8, y as u8, y as u8])[0];
            let w = 1.0 - 4.0 * (l / 100.0 - 0.5).powi(2);
            lab_to_srgb([l, tint_lab[1] * w, tint_lab[2] * w])
        });
        map_colour(self, |px| lut[luma(px) as usize])
    }

    /// `L' = L*brightness + lightness`, `C' = C*saturation`, `h' = h + hue`.
    pub fn modulate(&self, brightness: f64, saturation: f64, hue: f64, lightness: f64) -> Self {
        map_colour(self, |px| {
            let lch = lab_to_lch(srgb_to_lab(px));
            lab_to_srgb(lch_to_lab([
                (lch[0] as f64 * brightness + lightness) as f32,
                (lch[1] as f64 * saturation) as f32,
                (lch[2] as f64 + hue) as f32,
            ]))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(img: &RasterImage) -> [u8; 3] {
        [img.data[0], img.data[1], img.data[2]]
    }

    #[test]
    fn tinting_with_a_neutral_grey_desaturates() {
        // Grey has a* = b* = 0, so the result keeps L* and loses all chroma
        // regardless of the luminance weight.
        let img = RasterImage::new_rgb(1, 1, vec![200, 40, 40]);
        let tinted = img.tint([128, 128, 128]);
        let out = px(&tinted);
        assert!(
            out[0].abs_diff(out[1]) <= 1 && out[1].abs_diff(out[2]) <= 1,
            "expected a neutral pixel, got {out:?}"
        );
    }

    #[test]
    fn tint_preserves_the_lightness_of_each_pixel() {
        // Grey inputs: Rec.709 luma of an R=G=B pixel reproduces the same
        // byte exactly, so this exercises the weighted formula without the
        // luma-reduction step itself introducing drift.
        let img = RasterImage::new_rgb(2, 1, vec![30, 30, 30, 220, 220, 220]);
        let tinted = img.tint([255, 240, 16]);
        let before = [
            srgb_to_lab([30, 30, 30])[0],
            srgb_to_lab([220, 220, 220])[0],
        ];
        let after = [
            srgb_to_lab([tinted.data[0], tinted.data[1], tinted.data[2]])[0],
            srgb_to_lab([tinted.data[3], tinted.data[4], tinted.data[5]])[0],
        ];
        for i in 0..2 {
            assert!(
                (before[i] - after[i]).abs() < 1.5,
                "L* {} -> {}",
                before[i],
                after[i]
            );
        }
    }

    #[test]
    fn tint_leaves_alpha_unchanged() {
        let img = RasterImage::new_rgba(1, 1, vec![200, 40, 40, 33]);
        assert_eq!(img.tint([0, 0, 255]).data[3], 33);
    }

    #[test]
    fn tint_reddens_a_neutral_grey_without_moving_its_lightness() {
        // A neutral grey tinted red gains positive a* (redder) while L*
        // stays put — the closed-form assertion the brief calls out.
        let img = RasterImage::new_rgb(1, 1, vec![128, 128, 128]);
        let l_before = srgb_to_lab([128, 128, 128])[0];
        let tinted = img.tint([255, 0, 0]);
        let lab_after = srgb_to_lab(px(&tinted));
        assert!(lab_after[1] > 0.0, "expected a* > 0, got {}", lab_after[1]);
        assert!(
            (lab_after[0] - l_before).abs() < 0.5,
            "L* {} -> {}",
            l_before,
            lab_after[0]
        );
    }

    #[test]
    fn black_and_white_are_unchanged_by_any_tint() {
        // w = 1 - 4*(l - 0.5)^2 is exactly 0 at l = 0 and l = 1, so pure
        // black and pure white keep their own value regardless of tint.
        for v in [0u8, 255] {
            let img = RasterImage::new_rgb(1, 1, vec![v, v, v]);
            let out = px(&img.tint([255, 240, 16]));
            assert!(
                out[0].abs_diff(v) <= 1 && out[1].abs_diff(v) <= 1 && out[2].abs_diff(v) <= 1,
                "grey {v} -> {out:?}"
            );
        }
    }

    #[test]
    fn mid_grey_gains_the_most_chroma_from_a_tint() {
        // The luminance weight peaks at L* = 50 (sRGB grey ~118-119) and
        // falls off toward both black and white, so a mid-grey tinted red
        // should pick up more a* than either a dark or a light grey.
        let tint = [255, 0, 0];
        let a_of = |v: u8| {
            let img = RasterImage::new_rgb(1, 1, vec![v, v, v]);
            srgb_to_lab(px(&img.tint(tint)))[1]
        };
        let dark = a_of(40);
        let mid = a_of(118);
        let light = a_of(220);
        assert!(mid > dark, "mid a* {mid} should exceed dark a* {dark}");
        assert!(mid > light, "mid a* {mid} should exceed light a* {light}");
    }

    #[test]
    fn tint_leaves_a_four_channel_image_alpha_alone_across_the_luma_lut() {
        let img = RasterImage::new_rgba(2, 1, vec![40, 40, 40, 10, 220, 220, 220, 250]);
        let tinted = img.tint([255, 240, 16]);
        assert_eq!(tinted.channels, 4);
        assert_eq!(tinted.data[3], 10);
        assert_eq!(tinted.data[7], 250);
    }

    #[test]
    fn modulate_identity_changes_nothing() {
        let img = RasterImage::new_rgb(1, 1, vec![90, 130, 70]);
        let out = img.modulate(1.0, 1.0, 0.0, 0.0);
        for i in 0..3 {
            assert!(out.data[i].abs_diff(img.data[i]) <= 1, "{:?}", out.data);
        }
    }

    #[test]
    fn brightness_scales_l_star() {
        let img = RasterImage::new_rgb(1, 1, vec![128, 128, 128]);
        let out = img.modulate(0.5, 1.0, 0.0, 0.0);
        let l_before = srgb_to_lab([128, 128, 128])[0];
        let l_after = srgb_to_lab(px(&out))[0];
        assert!(
            (l_after - l_before * 0.5).abs() < 1.0,
            "{l_before} -> {l_after}"
        );
    }

    #[test]
    fn saturation_zero_produces_a_neutral_pixel() {
        let img = RasterImage::new_rgb(1, 1, vec![200, 40, 40]);
        let out = px(&img.modulate(1.0, 0.0, 0.0, 0.0));
        assert!(
            out[0].abs_diff(out[1]) <= 1 && out[1].abs_diff(out[2]) <= 1,
            "{out:?}"
        );
    }

    #[test]
    fn a_360_degree_hue_rotation_is_identity() {
        let img = RasterImage::new_rgb(1, 1, vec![200, 40, 40]);
        let out = img.modulate(1.0, 1.0, 360.0, 0.0);
        for i in 0..3 {
            assert!(out.data[i].abs_diff(img.data[i]) <= 1, "{:?}", out.data);
        }
    }

    #[test]
    fn hue_180_on_pure_red_lands_on_cyan_ish() {
        // Pure red sits at hue ~40 degrees in LCh; rotating 180 degrees
        // should land on the opposite side of the wheel — negative a*.
        let img = RasterImage::new_rgb(1, 1, vec![255, 0, 0]);
        let out = px(&img.modulate(1.0, 1.0, 180.0, 0.0));
        let lab_after = srgb_to_lab(out);
        assert!(lab_after[1] < 0.0, "expected a* < 0, got {}", lab_after[1]);
    }

    #[test]
    fn lightness_adds_to_l_star() {
        let img = RasterImage::new_rgb(1, 1, vec![100, 100, 100]);
        let l_before = srgb_to_lab([100, 100, 100])[0];
        let l_after = srgb_to_lab(px(&img.modulate(1.0, 1.0, 0.0, 10.0)))[0];
        assert!(
            (l_after - (l_before + 10.0)).abs() < 1.0,
            "{l_before} -> {l_after}"
        );
    }

    #[test]
    fn modulate_leaves_alpha_unchanged() {
        let img = RasterImage::new_rgba(1, 1, vec![200, 40, 40, 12]);
        assert_eq!(img.modulate(0.5, 2.0, 90.0, 0.0).data[3], 12);
    }
}
