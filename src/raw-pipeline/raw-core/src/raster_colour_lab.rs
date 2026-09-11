//! The colour ops sharp performs in a perceptual space (#3503).
//!
//! `tint(colour)` keeps the image's own L* and replaces a*/b* with the tint's
//! — `sharp::Tint` in pipeline.cc, verbatim. `modulate` scales L* by
//! `brightness`, adds `lightness` to it, scales C* by `saturation` and rotates
//! h by `hue` — `sharp::Modulate`, which is a `vips_linear` in LCh space.
//! Both leave the alpha channel unchanged.

use crate::raster::RasterImage;
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

impl RasterImage {
    /// Keep each pixel's L*, take a*/b* from `rgb`.
    pub fn tint(&self, rgb: [u8; 3]) -> Self {
        let tint_lab = srgb_to_lab(rgb);
        map_colour(self, |px| {
            let l = srgb_to_lab(px)[0];
            lab_to_srgb([l, tint_lab[1], tint_lab[2]])
        })
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
        // Grey has a* = b* = 0, so the result keeps L* and loses all chroma.
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
        // The dark pixel (L* ~= 11) combined with this tint's high chroma
        // (a*/b* ~= -14/90) pushes the substituted Lab triple outside the
        // sRGB gamut — `lab_to_srgb` clamps the blue channel to 0, and
        // re-deriving L* from that clamped byte drifts by ~2.6, verified
        // independently against a reference sRGB<->Lab implementation.
        // That is real 8-bit-gamut clamping, not a bug in `tint`, so the
        // tolerance is wide enough to admit it while still catching a
        // formula error (which would drift by tens, not single digits).
        for i in 0..2 {
            assert!(
                (before[i] - after[i]).abs() < 3.0,
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
