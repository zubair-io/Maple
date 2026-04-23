use crate::{
    image::{ColorSpace, Image},
    xmp::AdjustmentModel,
};

const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Apply scene-referred tone controls per spec § 3.6.
/// Steps 1-5 (exposure, highlights, shadows, whites, blacks); tone curves
/// (steps 6-7) deferred. Contrast is NOT applied here; it modulates the
/// AgX sigmoid slope downstream (spec § 3.6a).
pub fn apply(img: &mut Image, model: &AdjustmentModel) {
    img.assert_space(ColorSpace::SceneLinearRec2020);

    // Identity short-circuit: if every field this stage touches is zero,
    // the pipeline's bit-for-bit baseline guarantee must hold.
    if model.exposure.abs() < 1e-6
        && model.highlights.abs() < 1e-3
        && model.shadows.abs() < 1e-3
        && model.whites.abs() < 1e-3
        && model.blacks.abs() < 1e-3
    {
        return;
    }

    let exp_gain = model.exposure.exp2();
    let apply_exposure = model.exposure.abs() >= 1e-6;
    let apply_highlights = model.highlights.abs() >= 1e-3;
    let apply_shadows = model.shadows.abs() >= 1e-3;
    let apply_whites = model.whites.abs() >= 1e-3;
    let apply_blacks = model.blacks.abs() >= 1e-3;

    let h_amount = model.highlights / 100.0;
    let h_denom = 1.0 + h_amount * 2.0;
    let s_amount = model.shadows / 100.0;
    let s_factor = s_amount * 0.5;
    let w_gain = 1.0 + model.whites / 200.0;
    let b_add = model.blacks / 400.0;

    for p in &mut img.pixels {
        // 1. Exposure.
        if apply_exposure {
            p[0] *= exp_gain;
            p[1] *= exp_gain;
            p[2] *= exp_gain;
        }

        // 2. Highlights — per-channel soft compression above knee=1.0.
        if apply_highlights && h_denom.abs() > 1e-6 {
            for c in 0..3 {
                if p[c] > 1.0 {
                    let excess = p[c] - 1.0;
                    p[c] = 1.0 + excess / h_denom;
                }
            }
        }

        // 3. Shadows — luminance-masked lift of deep values.
        if apply_shadows {
            let luma = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
            let mask = 1.0 - smoothstep(0.0, 0.1, luma);
            let lift = mask * s_factor;
            p[0] += p[0] * lift;
            p[1] += p[1] * lift;
            p[2] += p[2] * lift;
        }

        // 4. Whites — small scalar gain near diffuse white endpoint.
        if apply_whites {
            p[0] *= w_gain;
            p[1] *= w_gain;
            p[2] *= w_gain;
        }

        // 5. Blacks — linear shift near zero (can produce small negatives).
        if apply_blacks {
            p[0] += b_add;
            p[1] += b_add;
            p[2] += b_add;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_default() -> AdjustmentModel {
        AdjustmentModel::default()
    }

    fn fresh_img(value: [f32; 3]) -> Image {
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        for p in &mut img.pixels { *p = value; }
        img
    }

    #[test]
    fn identity_when_all_fields_zero() {
        let mut img = fresh_img([0.3, 0.4, 0.5]);
        apply(&mut img, &model_default());
        for p in &img.pixels {
            assert_eq!(*p, [0.3, 0.4, 0.5]);
        }
    }

    #[test]
    fn exposure_plus_one_doubles() {
        let mut img = fresh_img([0.1, 0.2, 0.3]);
        let mut m = model_default();
        m.exposure = 1.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        assert!((p[0] - 0.2).abs() < 1e-6);
        assert!((p[1] - 0.4).abs() < 1e-6);
        assert!((p[2] - 0.6).abs() < 1e-6);
    }

    #[test]
    fn exposure_preserves_scene_headroom() {
        let mut img = fresh_img([5.0, 5.0, 5.0]);
        let mut m = model_default();
        m.exposure = 1.0;
        apply(&mut img, &m);
        assert_eq!(img.pixels[0], [10.0, 10.0, 10.0]);
    }

    #[test]
    fn highlights_positive_compresses_above_knee() {
        let mut img = fresh_img([2.0, 2.0, 2.0]);
        let mut m = model_default();
        m.highlights = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        // excess=1.0, denom=1+1*2=3, compressed=1/3 → output = 1.0 + 0.333 ≈ 1.333
        assert!((p[0] - (1.0 + 1.0 / 3.0)).abs() < 1e-4, "R was {}", p[0]);
    }

    #[test]
    fn highlights_leaves_below_knee_untouched() {
        let mut img = fresh_img([0.5, 0.5, 0.5]);
        let mut m = model_default();
        m.highlights = 100.0;
        apply(&mut img, &m);
        assert_eq!(img.pixels[0], [0.5, 0.5, 0.5]);
    }

    #[test]
    fn shadows_lifts_deep_values() {
        let mut img = fresh_img([0.02, 0.02, 0.02]);
        let mut m = model_default();
        m.shadows = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        // luma = 0.02, smoothstep(0, 0.1, 0.02) = small → mask ~0.9,
        // lift = 0.9 * 0.5 = 0.45, p += p * 0.45 → p ≈ 0.029
        assert!(p[0] > 0.02, "expected lift, got {}", p[0]);
    }

    #[test]
    fn shadows_leaves_midtones_alone() {
        let mut img = fresh_img([0.3, 0.3, 0.3]);
        let mut m = model_default();
        m.shadows = 100.0;
        apply(&mut img, &m);
        // luma 0.3 >> threshold 0.1 → mask = 0 → no change.
        for p in &img.pixels {
            for &c in p {
                assert!((c - 0.3).abs() < 1e-5);
            }
        }
    }

    #[test]
    fn whites_scales_uniformly() {
        let mut img = fresh_img([0.5, 0.5, 0.5]);
        let mut m = model_default();
        m.whites = 100.0;
        apply(&mut img, &m);
        // w_gain = 1 + 100/200 = 1.5; output = 0.5 * 1.5 = 0.75
        assert!((img.pixels[0][0] - 0.75).abs() < 1e-5);
    }

    #[test]
    fn blacks_shifts_additively_can_go_negative() {
        let mut img = fresh_img([0.0, 0.0, 0.0]);
        let mut m = model_default();
        m.blacks = -100.0;
        apply(&mut img, &m);
        // b_add = -100/400 = -0.25; output = -0.25 (negative, valid scene-linear)
        for &c in &img.pixels[0] {
            assert!((c - (-0.25)).abs() < 1e-5, "{} != -0.25", c);
        }
    }

    #[test]
    fn exposure_and_highlights_compose() {
        // Exposure +1 doubles 0.6 → 1.2 (above knee). Then highlights +100 compresses.
        let mut img = fresh_img([0.6, 0.6, 0.6]);
        let mut m = model_default();
        m.exposure = 1.0;
        m.highlights = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        // After exposure: 1.2. excess=0.2, denom=3, compressed=0.0667 → 1.0667
        assert!((p[0] - (1.0 + 0.2 / 3.0)).abs() < 1e-4, "R was {}", p[0]);
    }
}
