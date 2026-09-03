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
//! 5. `hue` — Oklab hue rotation with the saturation stage's soft-knee gamut
//!    handling, lightness and chroma preserved (#3269, `hue::rotate_pixel`).
//! 6. `saturation` — Oklab chroma scale with gamut-aware soft-compression
//!    (`saturation::apply_pixel`).
//! 7. `vibrance` — low-chroma-weighted Oklab boost with skin-tone protection
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
use std::sync::Arc;

use crate::image::{ColorSpace, Image};
use crate::stages::hsl::HSL_HUE_MAX_RAD;
use crate::stages::saturation;
use crate::stages::scene_tone_controls::{highlights_mult, shadows_mult, smoothstep, LUMA_REC2020};
use crate::stages::vibrance;
use crate::stages::white_balance;
use crate::types::{LocalAdjustment, Mask, MaskRaster, PartialAdjustments, RangeRefinement};

pub mod hue;
pub mod mask;
pub mod range;

/// Apply every `LocalAdjustment` in `layers` to `img`. Layers are applied
/// in order, each compositing on top of the previous result — there is no
/// blending mode beyond "apply weighted delta," matching the most common
/// Lightroom/Capture One behavior for stackable local layers.
///
/// `rasters` resolves any `Mask::Bitmap` layer's raster (#3271) — pass
/// `&[]` when the caller has no bitmap masks (e.g. a headless CLI render
/// with only linear/radial layers); a `Bitmap` layer with no matching
/// entry evaluates to weight 0, not a global correction.
///
/// `img` must be `SceneLinearRec2020` (the working space between `dehaze`
/// and `sharpen`). Thin wrapper over [`apply_with_scope`] with no scope
/// target, discarding the (never-computed) weights.
pub fn apply(img: &mut Image, layers: &[LocalAdjustment], rasters: &[Arc<MaskRaster>]) {
    let full = (img.width, img.height);
    apply_windowed(img, layers, rasters, (0, 0), full);
}

/// [`apply`] for a buffer that is a WINDOW of the full frame (#1157): mask
/// weights evaluate in coordinates normalised to `full`, with the buffer's
/// pixel `(x, y)` sitting at frame pixel `origin + (x, y)`. The whole-frame
/// entry is `origin = (0, 0)`, `full = (img.width, img.height)`, for which
/// the per-pixel float sequence is unchanged (`0 + x` is `x`), so it is
/// bit-identical to the pre-#1157 stage. `origin` is signed because a tile's
/// padded crop may start before the frame's DefaultCrop origin.
pub fn apply_windowed(
    img: &mut Image,
    layers: &[LocalAdjustment],
    rasters: &[Arc<MaskRaster>],
    origin: (i32, i32),
    full: (u32, u32),
) {
    apply_core(img, layers, rasters, origin, full, None);
}

/// Mask geometry × range refinement at one pixel, in `[0, 1]` — the exact
/// per-pixel weight [`apply_pixel`] scales its edit by. Shared by the
/// ordinary loop below and the scope-recording loop in [`apply_core`] so
/// the two can never disagree on the weight for the same input; the WGSL
/// kernel (`raw-gpu/src/local_adjustments.wgsl`) reimplements this same
/// sequence as its own parity-gated twin.
#[inline]
fn combined_weight(
    mask: &Mask,
    raster: Option<&MaskRaster>,
    range: Option<&RangeRefinement>,
    nx: f32,
    ny: f32,
    p: &[f32; 3],
) -> f32 {
    let geometric = mask::evaluate(mask, raster, nx, ny);
    if geometric <= 0.0 {
        return 0.0;
    }
    // Range refinement (#3270): evaluated on the pixel ENTERING this layer
    // (the previous layer's output, or the stage's own input for the first
    // layer) — never on this layer's own result, so it can't chase its own
    // edit, and it tracks upstream exposure / white balance.
    match range {
        Some(r) => geometric * range::weight(r, *p),
        None => geometric,
    }
}

/// [`apply`], additionally recording one layer's per-pixel weight (#3272,
/// spec §4/§5.4) — the value the vectorscope's scope pass weighs the
/// display-encoded histogram by, letting the UI show "just this mask's
/// colours" without a second render.
///
/// `scope_layer` names a layer by its index in `layers`. `None`, or an
/// index `>= layers.len()`, records nothing and returns `None` — same
/// contract as an absent scope target having no effect on the render.
/// `Some(li)` where `li` is in range ALWAYS returns `Some(weights)`
/// (`weights.len() == img.width * img.height`), even when that layer's
/// `PartialAdjustments` are all `None`: unlike every other layer, a
/// control-less scope-target layer is NOT skipped, because its weight is
/// still wanted (the "select a mask, see nothing change but the scope"
/// state right after Create, before any slider moves).
pub fn apply_with_scope(
    img: &mut Image,
    layers: &[LocalAdjustment],
    rasters: &[Arc<MaskRaster>],
    scope_layer: Option<usize>,
) -> Option<Vec<f32>> {
    let full = (img.width, img.height);
    apply_core(img, layers, rasters, (0, 0), full, scope_layer)
}

/// The one loop both public entries share: windowed coordinates (#1157) and
/// optional scope-weight recording (#3272).
fn apply_core(
    img: &mut Image,
    layers: &[LocalAdjustment],
    rasters: &[Arc<MaskRaster>],
    origin: (i32, i32),
    full: (u32, u32),
    scope_layer: Option<usize>,
) -> Option<Vec<f32>> {
    if layers.is_empty() {
        return None;
    }
    img.assert_space(ColorSpace::SceneLinearRec2020);

    let w = img.width as usize;
    let h = img.height as usize;
    if w == 0 || h == 0 {
        return None;
    }
    let (full_w, full_h) = (full.0 as usize, full.1 as usize);
    // Normalized-coordinate denominators. For the common case (dim > 1),
    // using `(dim - 1)` so the first pixel maps to 0.0 and the last pixel
    // maps to 1.0 exactly — important for mask endpoints that sit on image
    // corners. For the degenerate single-pixel-axis case (dim == 1), the
    // denominator is undefined; we fall back to `inv = 0.0` so the lone
    // pixel maps to 0.0. Mask endpoints on the far edge will see weight 0
    // along that axis, which is consistent with the smoothstep falloff
    // — a one-pixel-tall or one-pixel-wide image isn't a useful target
    // for local adjustments, and we don't want to divide by zero.
    let inv_w = if full_w > 1 {
        1.0 / (full_w as f32 - 1.0)
    } else {
        0.0
    };
    let inv_h = if full_h > 1 {
        1.0 / (full_h as f32 - 1.0)
    } else {
        0.0
    };

    let mut weights: Option<Vec<f32>> = scope_layer
        .filter(|&li| li < layers.len())
        .map(|_| vec![0.0f32; w * h]);

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
    // No allocation PER LAYER: `par_chunks_mut` borrows the existing pixel
    // buffer (and the weights buffer, when recording), and rayon's thread
    // pool is process-global and already warm. The one allocation this
    // function can make is the weights buffer itself, made ONCE above, not
    // per layer or per pixel.
    for (li, layer) in layers.iter().enumerate() {
        let is_scope_target = Some(li) == scope_layer;
        if layer.adjustments.is_empty() && !is_scope_target {
            continue;
        }
        // Resolved ONCE per layer, outside the pixel loop — `mask::resolve`
        // is a linear scan of `rasters`, and every pixel in this layer's
        // pass wants the SAME raster.
        let raster = mask::resolve(&layer.mask, rasters);
        if is_scope_target {
            let weight_buf = weights
                .as_mut()
                .expect("scope_layer in range implies weights was allocated above");
            img.pixels
                .par_chunks_mut(w)
                .zip(weight_buf.par_chunks_mut(w))
                .enumerate()
                .for_each(|(y, (row, weight_row))| {
                    let ny = (origin.1 + y as i32) as f32 * inv_h;
                    for (x, p) in row.iter_mut().enumerate() {
                        let nx = (origin.0 + x as i32) as f32 * inv_w;
                        let weight =
                            combined_weight(&layer.mask, raster, layer.range.as_ref(), nx, ny, p);
                        weight_row[x] = weight;
                        if weight <= 0.0 || layer.adjustments.is_empty() {
                            continue;
                        }
                        apply_pixel(p, &layer.adjustments, weight);
                    }
                });
        } else {
            img.pixels
                .par_chunks_mut(w)
                .enumerate()
                .for_each(|(y, row)| {
                    let ny = (origin.1 + y as i32) as f32 * inv_h;
                    for (x, p) in row.iter_mut().enumerate() {
                        let nx = (origin.0 + x as i32) as f32 * inv_w;
                        let weight =
                            combined_weight(&layer.mask, raster, layer.range.as_ref(), nx, ny, p);
                        if weight <= 0.0 {
                            continue;
                        }
                        apply_pixel(p, &layer.adjustments, weight);
                    }
                });
        }
    }
    weights
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

    // 5. Hue — Oklab rotation, lightness/chroma preserving (#3269). Sits
    //    after the luma-coupled tone controls (which recompute luma from
    //    RGB and would otherwise see a rotated pixel) and before the two
    //    chroma moves, so saturation/vibrance act on the final hue.
    if let Some(hv) = a.hue {
        *p = hue::rotate_pixel(*p, w * hv / 100.0 * HSL_HUE_MAX_RAD);
    }

    // 6. Saturation.
    if let Some(s) = a.saturation {
        let scale = 1.0 + (w * s) / 100.0;
        *p = saturation::apply_pixel(*p, scale);
    }

    // 7. Vibrance.
    if let Some(v) = a.vibrance {
        let amount = (w * v) / 100.0;
        *p = vibrance::apply_pixel(*p, amount);
    }
}

#[cfg(test)]
mod tests;
// Hue (#3269) / range-refinement (#3270) tests — sibling file, 600-line budget.
#[cfg(test)]
mod tests_hue_range;
