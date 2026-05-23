//! Local-adjustment apply stage (ticket #280, foundation slice).
//!
//! Iterates the `AdjustmentModel.local_adjustments` array and applies each
//! `LocalAdjustment` to the scene-linear Rec.2020 image. For each pixel the
//! mask weight `w ∈ [0, 1]` is computed and the layer's `PartialAdjustments`
//! are applied scaled by `w`.
//!
//! **Foundation scope:** only `exposure` is wired through to actual pixel
//! math (a multiplicative `exp2(w * exposure)` gain — additive in EV when
//! `w==1`, identity when `w==0`, smooth between). The other fields on
//! `PartialAdjustments` are carried through the schema + XMP but are no-ops
//! in this slice — see the field-level doc on `PartialAdjustments` for the
//! per-control rationale.
//!
//! Bit-identical short-circuit: when `local_adjustments` is empty (the
//! default), `apply` returns immediately without touching pixels. This
//! preserves the parity-harness baseline for every existing fixture.

use crate::image::{ColorSpace, Image};
use crate::types::{LocalAdjustment, PartialAdjustments};

pub mod mask;

/// Apply every `LocalAdjustment` in `layers` to `img`. Layers are applied
/// in order, each compositing on top of the previous result — there is no
/// blending mode beyond "apply weighted delta," matching the most common
/// Lightroom/Capture One behavior for stackable local layers.
///
/// `img` must be `SceneLinearRec2020` (the working space between `dehaze`
/// and `sharpen`).
pub fn apply(img: &mut Image, layers: &[LocalAdjustment]) {
    if layers.is_empty() {
        return;
    }
    img.assert_space(ColorSpace::SceneLinearRec2020);

    let w = img.width as usize;
    let h = img.height as usize;
    if w == 0 || h == 0 {
        return;
    }
    // Normalized-coordinate denominators. Using `(dim - 1)` so the first
    // pixel maps to 0.0 and the last pixel maps to 1.0 exactly — important
    // for mask endpoints that sit on image corners.
    let inv_w = if w > 1 { 1.0 / (w as f32 - 1.0) } else { 0.0 };
    let inv_h = if h > 1 { 1.0 / (h as f32 - 1.0) } else { 0.0 };

    for layer in layers {
        if layer.adjustments.is_empty() {
            continue;
        }
        for y in 0..h {
            let ny = y as f32 * inv_h;
            for x in 0..w {
                let nx = x as f32 * inv_w;
                let weight = mask::evaluate(&layer.mask, nx, ny);
                if weight <= 0.0 {
                    continue;
                }
                let i = y * w + x;
                apply_pixel(&mut img.pixels[i], &layer.adjustments, weight);
            }
        }
    }
}

/// Per-pixel adjustment application. Only `exposure` is functional this
/// slice; remaining fields are accepted-and-ignored deliberately so the
/// schema + XMP round-trip can stabilize first.
fn apply_pixel(p: &mut [f32; 3], a: &PartialAdjustments, w: f32) {
    if let Some(ev) = a.exposure {
        let gain = (w * ev).exp2();
        p[0] *= gain;
        p[1] *= gain;
        p[2] *= gain;
    }
    // TODO(#280 slice 2+): wire contrast / highlights / shadows / whites /
    // blacks / saturation / vibrance / temperature / tint into per-pixel
    // math. Each requires either a closed-form scene-linear operator or a
    // documented exception (contrast — see PartialAdjustments doc).
    let _ = (
        a.contrast,
        a.highlights,
        a.shadows,
        a.whites,
        a.blacks,
        a.saturation,
        a.vibrance,
        a.temperature,
        a.tint,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Mask, Point2};

    fn flat_image(w: u32, h: u32, v: f32) -> Image {
        Image {
            width: w,
            height: h,
            pixels: vec![[v, v, v]; (w * h) as usize],
            space: ColorSpace::SceneLinearRec2020,
        }
    }

    #[test]
    fn empty_layers_is_noop() {
        let mut img = flat_image(4, 4, 0.18);
        let snapshot = img.pixels.clone();
        apply(&mut img, &[]);
        assert_eq!(img.pixels, snapshot, "empty Vec must leave pixels untouched");
    }

    #[test]
    fn empty_partial_adjustments_is_noop() {
        let layers = vec![LocalAdjustment::linear(
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            PartialAdjustments::default(), // every field None
        )];
        let mut img = flat_image(4, 4, 0.18);
        let snapshot = img.pixels.clone();
        apply(&mut img, &layers);
        assert_eq!(img.pixels, snapshot);
    }

    #[test]
    fn linear_exposure_doubles_at_full_weight_side() {
        // Linear gradient from x=0 (w=0) to x=1 (w=1) with feather=0 (hard
        // step at the midpoint). Apply +1 EV: pixels in the w=1 half are
        // doubled, pixels in the w=0 half are unchanged.
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.5),
                end: Point2::new(1.0, 0.5),
                feather: 0.0,
            },
            adjustments: PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
        }];
        let mut img = flat_image(5, 1, 0.5);
        apply(&mut img, &layers);
        // x=0 (w=0) — unchanged.
        assert!((img.pixels[0][0] - 0.5).abs() < 1e-5, "left edge: {}", img.pixels[0][0]);
        // x=4 (w=1) — doubled.
        assert!(
            (img.pixels[4][0] - 1.0).abs() < 1e-5,
            "right edge: {}",
            img.pixels[4][0]
        );
    }

    #[test]
    fn radial_exposure_doubles_at_center() {
        // Radial mask centered at (0.5, 0.5) with radii (0.5, 0.5), feather
        // 0 — pixels exactly at the centre are w=1, edges are w=0.
        let layers = vec![LocalAdjustment {
            mask: Mask::Radial {
                center: Point2::new(0.5, 0.5),
                radii: Point2::new(0.5, 0.5),
                angle: 0.0,
                feather: 0.0,
                invert: false,
            },
            adjustments: PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
        }];
        // 3x3 image so the centre pixel (1, 1) maps exactly to (0.5, 0.5).
        let mut img = flat_image(3, 3, 0.25);
        apply(&mut img, &layers);
        // Centre pixel: w=1 → doubled.
        assert!(
            (img.pixels[4][0] - 0.5).abs() < 1e-5,
            "centre: {}",
            img.pixels[4][0]
        );
        // Corner pixel (0,0) — outside the radius, w=0 → unchanged.
        assert!(
            (img.pixels[0][0] - 0.25).abs() < 1e-5,
            "corner: {}",
            img.pixels[0][0]
        );
    }
}
