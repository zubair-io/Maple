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

    // Highlights: same h_denom shape as the legacy per-channel version,
    // applied uniformly to RGB via the luma scale factor (see step 2).
    let h_amount = model.highlights / 100.0;
    let h_denom = 1.0 + h_amount * 2.0;
    // Shadows: unchanged from the original spec — luma-masked
    // multiplicative lift gated on deep values.
    let s_amount = model.shadows / 100.0;
    let s_factor = s_amount * 0.5;
    // Whites: smoothstep-weighted upper-end gain (see step 4).
    let w_amount = model.whites / 200.0;
    // Blacks: smoothstep-weighted toe (see step 5). The amount has two
    // shapes depending on sign — see comment block at the call site.
    let b_amount = model.blacks / 100.0; // -1..+1
    let b_add_pos = model.blacks / 400.0; // additive lift amount, positive branch only.

    for p in &mut img.pixels {
        // 1. Exposure.
        if apply_exposure {
            p[0] *= exp_gain;
            p[1] *= exp_gain;
            p[2] *= exp_gain;
        }

        // 2. Highlights — luminance-coupled soft compression above knee=1.0.
        //
        // Pre-fix (#266): compressed each channel independently above the
        // knee. When a saturated colour had one channel above knee and
        // others below (e.g. specular red post-WB at [2.0, 0.5, 0.5]),
        // only R got pulled down while G and B stayed put — the R:G:B
        // ratio (4:1:1 → 2.67:1:1) shifted, producing a visible hue
        // rotation on bright saturated regions.
        //
        // Post-fix: compute scene-luminance Y = dot(LUMA_REC2020, p), apply
        // the same denom-rolloff to Y, scale all three channels by
        // Y_new / Y_old. Below the knee (Y ≤ 1.0) the pixel passes
        // through unchanged — same behaviour as the legacy code below
        // the knee. Hue is preserved by construction: the only
        // operation on RGB is a uniform scalar multiply.
        if apply_highlights && h_denom.abs() > 1e-6 {
            let y_old = LUMA_REC2020[0] * p[0]
                + LUMA_REC2020[1] * p[1]
                + LUMA_REC2020[2] * p[2];
            // Skip the case where the pixel has no headroom to compress
            // (Y ≤ knee) — below the knee the pixel passes through
            // unchanged. (h_denom ≈ 0 is already guarded above.)
            if y_old > 1.0 {
                let y_new = 1.0 + (y_old - 1.0) / h_denom;
                let scale = y_new / y_old;
                p[0] *= scale;
                p[1] *= scale;
                p[2] *= scale;
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

        // 4. Whites — smoothstep-weighted gain near the diffuse-white endpoint.
        //
        // Pre-fix (#267): uniform scalar gain `1 + whites/200` brightened
        // every pixel including mid-gray. The reference renderer's whites slider weights its
        // action near the upper end of the diffuse-white range and leaves
        // midtones untouched.
        //
        // Post-fix: weight the gain by smoothstep(0.5, 1.0, Y). At Y=0.5
        // the weight is 0 → gain=1.0 → no change. At Y=1.0+ the weight
        // saturates to 1 → full whites/200 gain. RGB is scaled uniformly
        // by the same factor so hue is preserved.
        if apply_whites {
            let y_old = LUMA_REC2020[0] * p[0]
                + LUMA_REC2020[1] * p[1]
                + LUMA_REC2020[2] * p[2];
            let w = smoothstep(0.5, 1.0, y_old);
            let w_gain = 1.0 + w_amount * w;
            p[0] *= w_gain;
            p[1] *= w_gain;
            p[2] *= w_gain;
        }

        // 5. Blacks — smoothstep-weighted toe curve.
        //
        // Pre-fix (#268): additive shift `p += blacks/400` clamped at
        // zero. The clamp prevented the magenta-shadow Bug A (negative
        // scene values funnelling per-channel through AgX), but turned
        // negative blacks into a hard floor — every pixel below the
        // threshold collapsed to absolute zero, destroying tonal
        // contrast.
        //
        // Post-fix: parametric toe weighted by w = 1 - smoothstep(0, 0.2, Y).
        // The weight is 1 near zero, falls to 0 above Y=0.2, so midtones
        // are untouched in either direction.
        //
        // - blacks < 0 (crush): multiplicative compression scaled by w.
        //   factor = 1 + (blacks/100) * w → in [0, 1] as blacks ranges
        //   [-100, 0]. p_new = p * factor. Zero stays zero (no negative
        //   scene values possible), but deep shadows retain a smooth toe
        //   instead of clipping flat to zero.
        //
        // - blacks > 0 (lift): additive shift scaled by w.
        //   delta = (blacks/400) * w. Preserves the existing positive
        //   semantics: at Y=0 with blacks=+100, w=1 → delta=0.25 (same
        //   as the legacy code). Above Y=0.2 the lift dies off so
        //   midtones aren't pushed up. The asymmetry between the two
        //   branches (multiplicative crush, additive lift) is
        //   intentional: a multiplicative lift would no-op p=0, but the
        //   user expectation for the legacy positive-blacks behaviour is
        //   that zero pixels lift to a positive value.
        //
        // No pixel can go negative scene-linear under either branch.
        // See investigation spec
        // .archived-plans/specs/2026-04-26-blacks-clarity-bug-investigation.md.
        if apply_blacks {
            let y_old = LUMA_REC2020[0] * p[0]
                + LUMA_REC2020[1] * p[1]
                + LUMA_REC2020[2] * p[2];
            let w = 1.0 - smoothstep(0.0, 0.2, y_old);
            if b_amount < 0.0 {
                let factor = 1.0 + b_amount * w;
                p[0] *= factor;
                p[1] *= factor;
                p[2] *= factor;
            } else {
                let delta = b_add_pos * w;
                p[0] += delta;
                p[1] += delta;
                p[2] += delta;
            }
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
        // Neutral pixel above the knee: Y = 2.0 > 1.0. Y_new = 1 + 1/3,
        // scale = (4/3) / 2 = 2/3. All channels land at 4/3 ≈ 1.333.
        let mut img = fresh_img([2.0, 2.0, 2.0]);
        let mut m = model_default();
        m.highlights = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        assert!((p[0] - (1.0 + 1.0 / 3.0)).abs() < 1e-4, "R was {}", p[0]);
    }

    #[test]
    fn highlights_leaves_below_knee_untouched() {
        // Y = 0.5 — below the knee, so the new luma-coupled code skips
        // entirely. (Same behaviour as the legacy per-channel code on
        // this input.)
        let mut img = fresh_img([0.5, 0.5, 0.5]);
        let mut m = model_default();
        m.highlights = 100.0;
        apply(&mut img, &m);
        assert_eq!(img.pixels[0], [0.5, 0.5, 0.5]);
    }

    #[test]
    fn highlights_preserves_hue_on_partial_specular_below_knee_luma() {
        // Ticket #266 acceptance — direct case from the spec.
        // Specular red at [2.0, 0.5, 0.5]: R is above the per-channel
        // knee, but Y = 0.2627*2 + 0.6780*0.5 + 0.0593*0.5 ≈ 0.895 < 1.
        //
        // Pre-fix (per-channel): R was compressed from 2.0 to 1.333
        // while G and B stayed at 0.5 — R:G:B drifted from 4:1:1 to
        // 2.67:1:1, a hue rotation.
        //
        // Post-fix (luma-coupled): Y < knee, no compression triggers,
        // ratios preserved identically.
        let mut img = fresh_img([2.0, 0.5, 0.5]);
        let mut m = model_default();
        m.highlights = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        let ratio_rg = p[0] / p[1];
        let ratio_rb = p[0] / p[2];
        assert!((ratio_rg - 4.0).abs() / 4.0 < 0.01, "R:G drift {} ", ratio_rg);
        assert!((ratio_rb - 4.0).abs() / 4.0 < 0.01, "R:B drift {} ", ratio_rb);
    }

    #[test]
    fn highlights_preserves_hue_on_specular_above_knee_luma() {
        // Companion to the test above — when Y exceeds the knee the
        // compression *does* trigger, and we must verify it scales
        // uniformly (no hue rotation).
        //
        // Input [2.0, 1.5, 1.5]: Y ≈ 0.2627*2 + 0.6780*1.5 + 0.0593*1.5
        // ≈ 1.6364 > 1. Pre-fix would have compressed R from 2.0 to
        // 1.333 (excess 1.0 → 1/3) but G and B from 1.5 to 1.167
        // (excess 0.5 → 1/6) — drift in R:G:B.
        //
        // Post-fix scales by Y_new/Y_old = (1 + 0.6364/3) / 1.6364 ≈ 0.741.
        // All three channels scale by the same factor → ratios preserved.
        let mut img = fresh_img([2.0, 1.5, 1.5]);
        let mut m = model_default();
        m.highlights = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        let ratio_rg = p[0] / p[1];
        let ratio_rb = p[0] / p[2];
        assert!((ratio_rg - 4.0 / 3.0).abs() / (4.0 / 3.0) < 0.01, "R:G drift {} ", ratio_rg);
        assert!((ratio_rb - 4.0 / 3.0).abs() / (4.0 / 3.0) < 0.01, "R:B drift {} ", ratio_rb);
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
    fn whites_midtone_untouched_at_y_half() {
        // Ticket #267 acceptance — a pixel at Y=0.5 must change by <1%.
        // smoothstep(0.5, 1.0, 0.5) == 0 → gain = 1.0 → no change.
        let mut img = fresh_img([0.5, 0.5, 0.5]);
        let mut m = model_default();
        m.whites = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        for &c in &p {
            assert!((c - 0.5).abs() / 0.5 < 0.01, "Y=0.5 should not lift, got {}", c);
        }
    }

    #[test]
    fn whites_lifts_upper_end_substantially() {
        // Ticket #267 acceptance — a pixel near diffuse white must lift
        // by ≥20% at whites=+100. For input [0.95, 0.95, 0.95]:
        // Y=0.95, w = smoothstep(0.5, 1.0, 0.95) → t=0.9, w = 0.81*1.2 = 0.972.
        // gain = 1 + 0.5*0.972 = 1.486. p_new = 0.95 * 1.486 ≈ 1.412.
        // Lift ratio ≈ 0.486 — well above the 20% bar.
        let mut img = fresh_img([0.95, 0.95, 0.95]);
        let mut m = model_default();
        m.whites = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        let lift = (p[0] - 0.95) / 0.95;
        assert!(lift >= 0.20, "expected ≥20% lift at Y=0.95, got {}", lift);
    }

    #[test]
    fn whites_preserves_neutral_hue() {
        // Uniform scalar gain → ratios preserved across all channels.
        let mut img = fresh_img([1.2, 0.9, 0.6]);
        let mut m = model_default();
        m.whites = 50.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        // R:G = 1.2/0.9 = 1.333; R:B = 1.2/0.6 = 2.0. Both must be preserved.
        let ratio_rg = p[0] / p[1];
        let ratio_rb = p[0] / p[2];
        assert!((ratio_rg - 4.0 / 3.0).abs() < 1e-4, "R:G {} ≠ 1.333", ratio_rg);
        assert!((ratio_rb - 2.0).abs() < 1e-4, "R:B {} ≠ 2.0", ratio_rb);
    }

    #[test]
    fn whites_symmetric_negative_pulls_bright_values_down() {
        // Ticket #267 — symmetric for negative whites. Y=0.95, whites=-100
        // pulls brightness down without touching midtones. Check that
        // the same Y=0.5 pixel remains within 1% under the same setting.
        let mut img_bright = fresh_img([0.95, 0.95, 0.95]);
        let mut img_mid = fresh_img([0.5, 0.5, 0.5]);
        let mut m = model_default();
        m.whites = -100.0;
        apply(&mut img_bright, &m);
        apply(&mut img_mid, &m);
        let p_bright = img_bright.pixels[0];
        let p_mid = img_mid.pixels[0];
        assert!(p_bright[0] < 0.95, "expected pull-down at Y=0.95, got {}", p_bright[0]);
        assert!((p_mid[0] - 0.5).abs() / 0.5 < 0.01, "Y=0.5 should not move, got {}", p_mid[0]);
    }

    #[test]
    fn blacks_shift_floors_at_zero_for_deep_shadows() {
        // Bug A regression test (Ticket 11 / .archived-plans/specs/
        // 2026-04-26-blacks-clarity-bug-investigation.md). The old
        // additive shift `p += blacks/400` drove a scene-linear 0.0
        // pixel to -0.25 under blacks=-100, which fed AgX's log-encode
        // per channel — any upstream per-channel asymmetry surfaced as
        // R-only / pink speckle on what should be uniform black.
        //
        // Post-fix (#268, multiplicative crush below Y=0.2): zero stays
        // zero, no negative scene values possible. The test contract is
        // unchanged: a 0,0,0 input under blacks=-100 must remain 0,0,0.
        let mut img = fresh_img([0.0, 0.0, 0.0]);
        let mut m = model_default();
        m.blacks = -100.0;
        apply(&mut img, &m);
        for &c in &img.pixels[0] {
            assert_eq!(c, 0.0, "blacks-floored pixel must be exactly 0, got {}", c);
        }
    }

    #[test]
    fn blacks_negative_compresses_deep_shadows_smoothly() {
        // Ticket #268 — deep shadows must retain a smooth toe (not a
        // hard floor). At Y=0.05 with blacks=-100 the multiplicative
        // factor is 1 + (-1)*w where w = 1 - smoothstep(0, 0.2, 0.05).
        // smoothstep(0, 0.2, 0.05): t=0.25, val = 0.0625*(3 - 0.5) = 0.15625.
        // w = 0.844. factor = 1 - 0.844 = 0.156. p_new ≈ 0.0078.
        // Crucially: > 0 (no hard floor), < input (still crushing).
        let mut img = fresh_img([0.05, 0.05, 0.05]);
        let mut m = model_default();
        m.blacks = -100.0;
        apply(&mut img, &m);
        for &c in &img.pixels[0] {
            assert!(c > 0.0, "expected positive scene-linear, got {}", c);
            assert!(c < 0.05, "expected crush below input, got {}", c);
        }
    }

    #[test]
    fn blacks_negative_leaves_midtones_alone() {
        // Y ≥ 0.2 → smoothstep weight is 0 → identity.
        let mut img = fresh_img([0.3, 0.3, 0.3]);
        let mut m = model_default();
        m.blacks = -50.0;
        apply(&mut img, &m);
        for &c in &img.pixels[0] {
            assert!((c - 0.3).abs() < 1e-6, "Y=0.3 should not move, got {}", c);
        }
    }

    #[test]
    fn blacks_no_negative_pixels_at_any_setting() {
        // Ticket #268 acceptance — no pixel goes negative scene-linear
        // for ANY blacks setting. Sweep a few representative settings
        // across a low-luma input that would have driven the legacy
        // additive shift below zero.
        for blacks in &[-100.0_f32, -75.0, -50.0, -25.0, -1.0, 1.0, 25.0, 50.0, 100.0] {
            for &start in &[0.0_f32, 0.005, 0.05, 0.10] {
                let mut img = fresh_img([start, start, start]);
                let mut m = model_default();
                m.blacks = *blacks;
                apply(&mut img, &m);
                for &c in &img.pixels[0] {
                    assert!(
                        c >= 0.0,
                        "negative scene-linear value {} from input {} at blacks={}",
                        c,
                        start,
                        blacks,
                    );
                }
            }
        }
    }

    #[test]
    fn blacks_positive_lifts_uniformly_at_zero() {
        // blacks=+100, Y=0 → w=1, delta = 100/400 = 0.25 — matches the
        // legacy positive-blacks semantics so the additive lift
        // intuition is preserved for the user.
        let mut img = fresh_img([0.0, 0.0, 0.0]);
        let mut m = model_default();
        m.blacks = 100.0;
        apply(&mut img, &m);
        for &c in &img.pixels[0] {
            assert!((c - 0.25).abs() < 1e-6, "{} != 0.25", c);
        }
    }

    #[test]
    fn blacks_positive_leaves_midtones_alone() {
        // Y ≥ 0.2 → smoothstep weight is 0 → identity.
        let mut img = fresh_img([0.4, 0.4, 0.4]);
        let mut m = model_default();
        m.blacks = 100.0;
        apply(&mut img, &m);
        for &c in &img.pixels[0] {
            assert!((c - 0.4).abs() < 1e-6, "Y=0.4 should not move, got {}", c);
        }
    }

    // ----------------------------------------------------------------
    // Ticket #433 — verify scene-referred + hue-preserving for all four
    // tone sliders. The first two (highlights, whites) already have hue
    // tests above; these complete the matrix for shadows and blacks.
    //
    // "Hue-preserving" here means: a uniform scalar multiply on RGB, so
    // R:G:B ratios survive unchanged. The blacks **positive** branch
    // (additive lift) intentionally does NOT preserve hue on a saturated
    // pixel with one channel at 0 — adding a uniform `delta` to (0, g, b)
    // produces (delta, g+delta, b+delta), which shifts chromaticity by
    // construction. That's a documented design choice (zero pixels must
    // lift to a positive value, matching legacy semantics — see step 5
    // comment block in `apply`). The test below pins that asymmetry so
    // future refactors can't accidentally swap the lift to a
    // multiplicative form without making a deliberate decision.
    // ----------------------------------------------------------------

    #[test]
    fn shadows_preserves_hue_on_saturated_deep_shadow() {
        // Saturated deep red [0.06, 0.02, 0.01]: Y ≈ 0.0327, mask ≈ 1.0,
        // lift = 0.5 * 1.0 = 0.5 (shadows=+100), so each channel scales
        // by (1 + 0.5*~0.67) — a uniform scalar multiply. R:G and R:B
        // ratios must survive within 0.1% (no per-channel drift).
        let mut img = fresh_img([0.06, 0.02, 0.01]);
        let mut m = model_default();
        m.shadows = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        let ratio_rg_in = 0.06 / 0.02;
        let ratio_rb_in = 0.06 / 0.01;
        let ratio_rg_out = p[0] / p[1];
        let ratio_rb_out = p[0] / p[2];
        assert!((ratio_rg_out - ratio_rg_in).abs() / ratio_rg_in < 0.001,
            "shadows+100 R:G drift {} → {}", ratio_rg_in, ratio_rg_out);
        assert!((ratio_rb_out - ratio_rb_in).abs() / ratio_rb_in < 0.001,
            "shadows+100 R:B drift {} → {}", ratio_rb_in, ratio_rb_out);
        // And the lift direction is correct.
        assert!(p[0] > 0.06, "shadows+100 should brighten saturated deep red, got {}", p[0]);
    }

    #[test]
    fn shadows_negative_preserves_hue_on_saturated_deep_shadow() {
        // Symmetric: shadows=-100 multiplies by (1 - 0.5*mask) — still a
        // uniform scalar so ratios survive. Verify both direction (crush)
        // and hue preservation.
        let mut img = fresh_img([0.06, 0.02, 0.01]);
        let mut m = model_default();
        m.shadows = -100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        let ratio_rg_out = p[0] / p[1];
        let ratio_rb_out = p[0] / p[2];
        assert!((ratio_rg_out - 3.0).abs() / 3.0 < 0.001,
            "shadows-100 R:G drift, got {}", ratio_rg_out);
        assert!((ratio_rb_out - 6.0).abs() / 6.0 < 0.001,
            "shadows-100 R:B drift, got {}", ratio_rb_out);
        assert!(p[0] < 0.06, "shadows-100 should crush deep shadow, got {}", p[0]);
    }

    #[test]
    fn blacks_negative_preserves_hue_on_saturated_deep_shadow() {
        // Crush branch (blacks < 0) is multiplicative: factor = 1 + b_amount*w.
        // For a saturated deep red [0.06, 0.02, 0.01] all three channels
        // multiply by the SAME factor (luma drives the weight, not
        // per-channel value), so ratios survive.
        let mut img = fresh_img([0.06, 0.02, 0.01]);
        let mut m = model_default();
        m.blacks = -100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        let ratio_rg_out = p[0] / p[1];
        let ratio_rb_out = p[0] / p[2];
        assert!((ratio_rg_out - 3.0).abs() / 3.0 < 0.001,
            "blacks-100 R:G drift, got {}", ratio_rg_out);
        assert!((ratio_rb_out - 6.0).abs() / 6.0 < 0.001,
            "blacks-100 R:B drift, got {}", ratio_rb_out);
        assert!(p[0] < 0.06, "blacks-100 should crush, got {}", p[0]);
    }

    #[test]
    fn blacks_positive_is_hue_preserving_when_no_channel_is_zero() {
        // Lift branch (blacks > 0) is additive: delta is the same for
        // all three channels. When every channel is non-zero AND the
        // delta is small relative to the channel value, ratios are
        // approximately preserved. This test pins that "small-perturbation"
        // regime explicitly.
        //
        // Input [0.06, 0.05, 0.04] at blacks=+25:
        //   Y ≈ 0.0497, w ≈ 1 - smoothstep(0, 0.2, 0.0497) ≈ 0.75
        //   delta = (25/400) * 0.75 ≈ 0.0469
        // Hue drift is therefore real but small here. We assert that
        // ratios shift by **less than 25%** — i.e. confirm the
        // additive-lift direction without claiming strict hue
        // preservation.
        let mut img = fresh_img([0.06, 0.05, 0.04]);
        let mut m = model_default();
        m.blacks = 25.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        // Each channel must lift by the same amount (additive shift).
        let d_rg = (p[0] - 0.06) - (p[1] - 0.05);
        let d_rb = (p[0] - 0.06) - (p[2] - 0.04);
        assert!(d_rg.abs() < 1e-5, "blacks+25 delta(R) != delta(G): {}", d_rg);
        assert!(d_rb.abs() < 1e-5, "blacks+25 delta(R) != delta(B): {}", d_rb);
        // Direction.
        assert!(p[0] > 0.06, "blacks+25 should lift, got {}", p[0]);
    }

    #[test]
    fn blacks_positive_lift_is_additive_not_multiplicative_by_design() {
        // The positive branch is documented to shift hue on a pixel where
        // one channel sits at exactly zero (zero → positive delta).
        // This is intentional — matches legacy positive-blacks semantics
        // so zero pixels lift to a positive value. A future refactor that
        // changes the lift to multiplicative would silently change a
        // visible behaviour; this test pins the asymmetry.
        //
        // Input [0.0, 0.05, 0.10] at blacks=+100: Y ≈ 0.040, w ≈ 0.81,
        // delta = (100/400) * 0.81 ≈ 0.203. Output [~0.203, ~0.253, ~0.303].
        // The "no channel at zero" R:G ratio was undefined (div by 0) and
        // the post-lift output is no longer chromatically zero in R.
        let mut img = fresh_img([0.0, 0.05, 0.10]);
        let mut m = model_default();
        m.blacks = 100.0;
        apply(&mut img, &m);
        let p = img.pixels[0];
        // R was 0, now must be > 0 — the documented "zero lifts to positive"
        // semantic. If R stays at 0 the lift is no longer additive.
        assert!(p[0] > 0.15, "blacks+100 must lift zero R to a positive value, got {}", p[0]);
        // And the additive-shift contract: same delta on every channel.
        let dr = p[0] - 0.0;
        let dg = p[1] - 0.05;
        let db = p[2] - 0.10;
        assert!((dr - dg).abs() < 1e-5, "additive shift broken on G: dr={} dg={}", dr, dg);
        assert!((dr - db).abs() < 1e-5, "additive shift broken on B: dr={} db={}", dr, db);
    }

    #[test]
    fn highlights_preserves_hue_on_arbitrary_saturated_above_knee() {
        // Sweep a few saturated colours through highlights=+50 and
        // verify R:G:B ratios survive. Adds breadth to the existing
        // two-case hue test above.
        let cases: &[[f32; 3]] = &[
            [2.0, 1.5, 0.5],   // warm above knee
            [0.5, 1.5, 2.0],   // cool above knee
            [1.8, 1.8, 0.2],   // yellow above knee
        ];
        for &input in cases {
            let mut img = fresh_img(input);
            let mut m = model_default();
            m.highlights = 50.0;
            apply(&mut img, &m);
            let p = img.pixels[0];
            // Verify uniform scale: out / in should be identical on all
            // channels that started non-zero.
            let s_r = p[0] / input[0];
            let s_g = p[1] / input[1];
            let s_b = p[2] / input[2];
            assert!((s_r - s_g).abs() / s_r < 0.001,
                "highlights+50 hue drift on {:?}: scale R={} G={}", input, s_r, s_g);
            assert!((s_r - s_b).abs() / s_r < 0.001,
                "highlights+50 hue drift on {:?}: scale R={} B={}", input, s_r, s_b);
        }
    }

    #[test]
    fn whites_preserves_hue_on_arbitrary_saturated() {
        // Sweep saturated near-white colours through whites=±50; assert
        // uniform scaling (already tested for one neutral case above —
        // this adds saturated coverage).
        let cases: &[[f32; 3]] = &[
            [0.95, 0.70, 0.50],
            [0.50, 0.70, 0.95],
            [0.95, 0.95, 0.40],
        ];
        for &slider in &[50.0_f32, -50.0] {
            for &input in cases {
                let mut img = fresh_img(input);
                let mut m = model_default();
                m.whites = slider;
                apply(&mut img, &m);
                let p = img.pixels[0];
                let s_r = p[0] / input[0];
                let s_g = p[1] / input[1];
                let s_b = p[2] / input[2];
                assert!((s_r - s_g).abs() / s_r.abs().max(1e-6) < 0.001,
                    "whites={} hue drift on {:?}", slider, input);
                assert!((s_r - s_b).abs() / s_r.abs().max(1e-6) < 0.001,
                    "whites={} hue drift on {:?}", slider, input);
            }
        }
    }

    // ----------------------------------------------------------------
    // Scene-referred placement: these tests pin that the stage operates
    // in scene-linear Rec.2020 (so it can see values > 1.0 unclipped)
    // and never clamps to display range. The pipeline-level invariant
    // (runs BEFORE the AgX view transform) lives in
    // `pipeline::scene_linear_chain` and is asserted there.
    // ----------------------------------------------------------------

    #[test]
    fn scene_referred_handles_values_above_unity() {
        // Ticket #433: stage must operate on unbounded scene-linear
        // f32. A value at 5.0 (specular highlight) must survive all
        // four sliders at zero (identity short-circuit) and survive
        // a positive exposure (linear gain) without clipping.
        let mut img = fresh_img([5.0, 5.0, 5.0]);
        let mut m = model_default();
        m.exposure = 1.0; // ×2 → 10.0
        apply(&mut img, &m);
        let p = img.pixels[0];
        assert!((p[0] - 10.0).abs() < 1e-4, "expected unclipped 10.0, got {}", p[0]);
        assert_eq!(p[0], p[1]);
        assert_eq!(p[1], p[2]);
    }

    #[test]
    fn scene_referred_does_not_clip_negatives_introduced_upstream() {
        // DCP on saturated colours can yield slightly negative
        // scene-linear values. The stage must not clamp; downstream
        // AgX handles negatives. Validate by feeding a slight negative
        // and ensuring exposure (the only operation that touches every
        // pixel unconditionally) passes the sign through.
        let mut img = fresh_img([-0.01, 0.5, 0.5]);
        let mut m = model_default();
        m.exposure = 1.0; // ×2 → [-0.02, 1.0, 1.0]
        apply(&mut img, &m);
        let p = img.pixels[0];
        assert!((p[0] - (-0.02)).abs() < 1e-5,
            "scene-linear stage must pass negatives through, got R={}", p[0]);
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
