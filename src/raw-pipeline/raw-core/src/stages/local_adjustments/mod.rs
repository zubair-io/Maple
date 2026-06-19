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
use crate::stages::saturation;
use crate::stages::scene_tone_controls::{
    highlights_mult, shadows_mult, smoothstep, LUMA_REC2020,
};
use crate::stages::vibrance;
use crate::stages::white_balance;
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
    // Normalized-coordinate denominators. For the common case (dim > 1),
    // using `(dim - 1)` so the first pixel maps to 0.0 and the last pixel
    // maps to 1.0 exactly — important for mask endpoints that sit on image
    // corners. For the degenerate single-pixel-axis case (dim == 1), the
    // denominator is undefined; we fall back to `inv = 0.0` so the lone
    // pixel maps to 0.0. Mask endpoints on the far edge will see weight 0
    // along that axis, which is consistent with the smoothstep falloff
    // — a one-pixel-tall or one-pixel-wide image isn't a useful target
    // for local adjustments, and we don't want to divide by zero.
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

/// Per-pixel adjustment application.
fn apply_pixel(p: &mut [f32; 3], a: &PartialAdjustments, w: f32) {
    // 1. Exposure (additive EV).
    if let Some(ev) = a.exposure {
        let gain = (w * ev).exp2();
        p[0] *= gain;
        p[1] *= gain;
        p[2] *= gain;
    }

    // 2. Temperature and Tint (CAT16 chromatic adaptation).
    // The mask weight `w` scales the (T, tint) delta from the D65 neutral.
    if a.temperature.is_some() || a.tint.is_some() {
        let t_delta = a.temperature.unwrap_or(0.0);
        let tint_delta = a.tint.unwrap_or(0.0);
        let m = white_balance::wb_cat16_matrix(6500.0 + w * t_delta, w * tint_delta);
        *p = m.mul_vec(*p);
    }

    // 3. Contrast (scene-linear power curve pivoted at 0.18).
    if let Some(c) = a.contrast {
        let gamma = (w * c / 100.0).exp2();
        let y_in = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        if y_in > 1e-6 {
            let y_out = 0.18 * (y_in / 0.18).powf(gamma);
            let gain = y_out / y_in;
            p[0] *= gain;
            p[1] *= gain;
            p[2] *= gain;
        }
    }

    // 4. Highlights, Shadows, Whites, Blacks.
    if a.highlights.is_some() || a.shadows.is_some() || a.whites.is_some() || a.blacks.is_some() {
        let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        let mut gain = 1.0;

        if let Some(h) = a.highlights {
            let h_amount = w * h / 100.0;
            let h_denom = 1.0 + h_amount * 2.0;
            let h_expand = 1.0 + 2.0 * h_amount.abs();
            gain *= highlights_mult(y, h_amount, h_denom, h_expand);
        }

        if let Some(s) = a.shadows {
            gain *= shadows_mult(y, w * s / 100.0);
        }

        if let Some(wh) = a.whites {
            let weight = smoothstep(0.5, 1.0, y);
            gain *= 1.0 + (w * wh / 200.0) * weight;
        }

        if let Some(bl) = a.blacks {
            let weight = 1.0 - smoothstep(0.0, 0.2, y);
            let b_amount = w * bl / 100.0;
            if b_amount < 0.0 {
                gain *= 1.0 + b_amount * weight;
            } else {
                // For additive lift, we apply it directly to RGB after the
                // multiplicative gains.
                let delta = (w * bl / 400.0) * weight;
                p[0] *= gain;
                p[1] *= gain;
                p[2] *= gain;
                p[0] += delta;
                p[1] += delta;
                p[2] += delta;
                gain = 1.0; // Reset so it's not applied twice.
            }
        }

        p[0] *= gain;
        p[1] *= gain;
        p[2] *= gain;
    }

    // 5. Saturation.
    if let Some(s) = a.saturation {
        let scale = 1.0 + (w * s) / 100.0;
        *p = saturation::apply_pixel(*p, scale);
    }

    // 6. Vibrance.
    if let Some(v) = a.vibrance {
        let amount = (w * v) / 100.0;
        *p = vibrance::apply_pixel(*p, amount);
    }
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

    #[test]
    fn local_temperature_shifts_blue() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.0),
                end: Point2::new(1.0, 0.0),
                feather: 0.0,
            },
            adjustments: PartialAdjustments {
                temperature: Some(-1000.0), // -1000K delta from 6500K
                ..Default::default()
            },
        }];
        let mut img = flat_image(2, 1, 0.5);
        apply(&mut img, &layers);
        // x=1 (w=1) — cooled (blue up, red down).
        assert!(img.pixels[1][2] > 0.5, "B: {}", img.pixels[1][2]);
        assert!(img.pixels[1][0] < 0.5, "R: {}", img.pixels[1][0]);
    }

    #[test]
    fn local_contrast_increases_spread() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.0),
                end: Point2::new(1.0, 0.0),
                feather: 0.0,
            },
            adjustments: PartialAdjustments {
                contrast: Some(50.0),
                ..Default::default()
            },
        }];
        let mut img = flat_image(3, 1, 0.5);
        img.pixels[0] = [0.1, 0.1, 0.1]; // x=0, w=0 (no change)
        img.pixels[2] = [0.1, 0.1, 0.1]; // x=2, w=1 (contrast up)
        apply(&mut img, &layers);
        // For Y=0.1 < 0.18, +contrast should crush.
        assert!(img.pixels[2][0] < 0.1, "crushed: {}", img.pixels[2][0]);
        assert!((img.pixels[0][0] - 0.1).abs() < 1e-5);
    }

    #[test]
    fn local_saturation_desaturates() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.0),
                end: Point2::new(1.0, 0.0),
                feather: 0.0,
            },
            adjustments: PartialAdjustments {
                saturation: Some(-100.0),
                ..Default::default()
            },
        }];
        let mut img = flat_image(2, 1, 0.5);
        img.pixels[1] = [0.8, 0.2, 0.2];
        apply(&mut img, &layers);
        // x=1 (w=1) — desaturated.
        let p = img.pixels[1];
        assert!((p[0] - p[1]).abs() < 1e-3);
        assert!((p[1] - p[2]).abs() < 1e-3);
    }

    #[test]
    fn local_shadows_lift() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.0),
                end: Point2::new(1.0, 0.0),
                feather: 0.0,
            },
            adjustments: PartialAdjustments {
                shadows: Some(100.0),
                ..Default::default()
            },
        }];
        let mut img = flat_image(2, 1, 0.05);
        apply(&mut img, &layers);
        // x=1 (w=1) — lifted.
        assert!(img.pixels[1][0] > 0.05);
    }

    #[test]
    fn local_blacks_additive_lift() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.0, 0.0),
                end: Point2::new(1.0, 0.0),
                feather: 0.0,
            },
            adjustments: PartialAdjustments {
                blacks: Some(100.0),
                ..Default::default()
            },
        }];
        let mut img = flat_image(2, 1, 0.0);
        apply(&mut img, &layers);
        // x=1 (w=1) — additive lift from 0 should land at 100/400 = 0.25.
        assert!((img.pixels[1][0] - 0.25).abs() < 1e-5);
    }
}
