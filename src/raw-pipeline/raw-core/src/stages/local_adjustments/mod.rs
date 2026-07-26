//! Local-adjustment apply stage (ticket #280).
//!
//! Iterates the `AdjustmentModel.local_adjustments` array and applies each
//! `LocalAdjustment` to the scene-linear Rec.2020 image. For each pixel the
//! mask weight `w ∈ [0, 1]` is computed and the layer's `PartialAdjustments`
//! are applied scaled by `w`.
//!
//! **Wired controls** (every field on `PartialAdjustments`), applied in this
//! per-pixel order:
//!
//! 1. `exposure` — multiplicative `exp2(w · ev)` gain (additive in EV).
//! 2. `temperature` / `tint` — CAT16 chromatic adaptation; the mask weight
//!    scales the source-white delta from D65 (6500 K).
//! 3. `contrast` — luma-ratio-preserving power curve pivoted at 0.18.
//! 4. `highlights` → `shadows` → `whites` → `blacks` — the same operators as
//!    `scene_tone_controls`, applied sequentially (each recomputes luma from
//!    the previous control's output). The global stage's Gaussian regional
//!    halo mask is the one piece not replicated — a per-pixel function cannot
//!    see neighbouring pixels; see the note at the call site.
//! 5. `saturation` — Oklab chroma scale with gamut-aware soft-compression
//!    (`saturation::apply_pixel`).
//! 6. `vibrance` — low-chroma-weighted Oklab boost with skin-tone protection
//!    (`vibrance::apply_pixel`).
//!
//! All operators are hue-preserving (uniform RGB scalars, or chroma-only
//! Oklab moves) and none clips: scene values pass through unbounded so the
//! single downstream view transform owns the scene→display compression.
//!
//! Bit-identical short-circuit: when `local_adjustments` is empty (the
//! default), `apply` returns immediately without touching pixels. This
//! preserves the parity-harness baseline for every existing fixture.

use rayon::prelude::*;

use crate::image::{ColorSpace, Image};
use crate::stages::saturation;
use crate::stages::scene_tone_controls::{highlights_mult, shadows_mult, smoothstep, LUMA_REC2020};
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

    // Row-parallel per layer (#1698). `mask::evaluate` is a pure function of
    // `(mask, nx, ny)` and `apply_pixel` reads and writes exactly one pixel,
    // so rows are independent and the per-pixel float sequence is unchanged —
    // the output is BIT-IDENTICAL to the serial loop this replaced (the
    // `local_adjustments_bench` example prints an FNV-1a fingerprint of the
    // output buffer, which is the same before and after).
    //
    // The parallel unit is the row rather than the whole image because the row
    // index supplies `ny` once for the whole span, matching the serial loop's
    // hoist. Layers stay SEQUENTIAL: each layer composites on top of the
    // previous layer's result, so they cannot be fused or reordered.
    //
    // No allocation: `par_chunks_mut` borrows the existing pixel buffer, and
    // rayon's thread pool is process-global and already warm.
    for layer in layers {
        if layer.adjustments.is_empty() {
            continue;
        }
        img.pixels
            .par_chunks_mut(w)
            .enumerate()
            .for_each(|(y, row)| {
                let ny = y as f32 * inv_h;
                for (x, p) in row.iter_mut().enumerate() {
                    let nx = x as f32 * inv_w;
                    let weight = mask::evaluate(&layer.mask, nx, ny);
                    if weight <= 0.0 {
                        continue;
                    }
                    apply_pixel(p, &layer.adjustments, weight);
                }
            });
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
    //
    // Unlike the GLOBAL white-balance stage — where `model.temperature` is the
    // ABSOLUTE source CCT in Kelvin (6500 K = no-op) — the local temperature
    // field is a RELATIVE offset from the D65 anchor: a local mask warms or
    // cools the masked region by `temperature` Kelvin. The mask weight scales
    // that offset so feathered edges blend smoothly toward the unadjusted
    // (D65) state. `tint` likewise scales relative to the neutral tint.
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

    // 4. Highlights → Shadows → Whites → Blacks, in the same order and with
    //    the same sequential-luma semantics as the global
    //    `scene_tone_controls::apply`: each control recomputes luma from the
    //    output of the previous control (highlights modifies pixels first,
    //    then shadows reads the post-highlights luma; whites then blacks
    //    recompute luma per step). Applying a single shared luma + a fused
    //    gain would diverge from the global operator whenever a layer sets
    //    more than one of these sliders (Copilot review of PR #1450).
    //
    //    The one deliberate departure from the global stage: the global
    //    highlights/shadows passes use a Gaussian-blurred *regional* luma
    //    plane for RapidRAW-style halo protection (see
    //    `scene_tone_controls::masked_multiplier_pass`). That needs the whole
    //    image, which a per-pixel function cannot see, so the local path uses
    //    the per-pixel luma directly. Local masks are already smooth/feathered
    //    regions, so the halo term — which only differs from the per-pixel
    //    response at strong luminance edges — is a second-order effect here.
    //    On a uniform field the global masked pass degenerates to exactly this
    //    per-pixel curve, so the two agree wherever the regional and local
    //    luma coincide.
    if let Some(h) = a.highlights {
        let h_amount = w * h / 100.0;
        let h_denom = 1.0 + h_amount * 2.0;
        let h_expand = 1.0 + 2.0 * h_amount.abs();
        let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        let gain = highlights_mult(y, h_amount, h_denom, h_expand);
        p[0] *= gain;
        p[1] *= gain;
        p[2] *= gain;
    }

    if let Some(s) = a.shadows {
        let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        let gain = shadows_mult(y, w * s / 100.0);
        p[0] *= gain;
        p[1] *= gain;
        p[2] *= gain;
    }

    if let Some(wh) = a.whites {
        let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        let gain = 1.0 + (w * wh / 200.0) * smoothstep(0.5, 1.0, y);
        p[0] *= gain;
        p[1] *= gain;
        p[2] *= gain;
    }

    if let Some(bl) = a.blacks {
        // Matches `scene_tone_controls` step 5 exactly: multiplicative crush
        // for negative blacks, additive lift for positive (so a Y=0 pixel can
        // still lift off zero). Weight `w_b = 1 − smoothstep(0, 0.2, Y)` pins
        // midtones. Neither branch can drive a pixel negative.
        let y = LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2];
        let weight = 1.0 - smoothstep(0.0, 0.2, y);
        let b_amount = w * bl / 100.0;
        if b_amount < 0.0 {
            let factor = 1.0 + b_amount * weight;
            p[0] *= factor;
            p[1] *= factor;
            p[2] *= factor;
        } else {
            let delta = (w * bl / 400.0) * weight;
            p[0] += delta;
            p[1] += delta;
            p[2] += delta;
        }
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
mod tests;
