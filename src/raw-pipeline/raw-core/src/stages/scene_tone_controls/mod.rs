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
mod tests;
