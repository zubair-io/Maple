//! The per-mask SPATIAL control group (#3407): texture, clarity, dehaze,
//! sharpness, luminance noise and defringe applied INSIDE a mask.
//!
//! # Why these six can't ride `apply_pixel`
//!
//! The eleven controls that shipped first are point operators — the output
//! at a pixel is a function of that pixel alone, so scaling the operator by
//! the mask weight is enough to confine it to the mask. These six are not:
//! every one of them reads a neighbourhood (a guided filter, an unsharp
//! blur, a non-local-means search window, a gradient), and there is no
//! "weighted" form of a neighbourhood read.
//!
//! # What is applied instead
//!
//! The delta form. For a layer, take the buffer as it stands after that
//! layer's point group, run the GLOBAL stage's own kernel over it at the
//! layer's slider value, and lerp the two by the per-pixel mask weight:
//!
//! ```text
//! out = base + w · (stage(base) − base)
//! ```
//!
//! At `w = 1` that is exactly the global stage; at `w = 0` it is exactly
//! identity; in between it fades the stage's effect with the mask's own
//! feather. Crucially the kernel itself is the SHIPPING one — `clarity`,
//! `texture`, `dehaze`, `sharpen`, `noise_reduction`, `defringe` are called
//! unchanged, so a local Clarity of +40 and a global Clarity of +40 agree
//! wherever the mask is opaque, and there is no second implementation of
//! any of this maths to keep at parity.
//!
//! The six run in Lightroom's own panel order on ONE scratch copy, and the
//! blend happens once at the end — not once per control. A layer that sets
//! several of them therefore sees them compose exactly as the global chain
//! composes them.
//!
//! # Cost, and the guard that keeps the slider tick honest
//!
//! The scratch copy is one image-sized allocation PER ENGAGED LAYER, so
//! [`engaged`] gates every one of the entry points below: a model whose
//! layers set only point controls (and the default model, which has no
//! layers at all) never allocates and never calls a kernel. That is what
//! keeps the 16 ms tick budget where it was — the group is opt-in per
//! layer, and the stage's own `layers.is_empty()` short-circuit still runs
//! first.

use rayon::prelude::*;

use crate::image::Image;
use crate::stages::{clarity, defringe, dehaze, noise_reduction, sharpen, texture};
use crate::types::PartialAdjustments;

/// The threshold every global stage in this group uses for its own
/// "this slider does nothing" early return. Reused here so a layer cannot
/// pay for a scratch copy the kernel would then no-op on.
pub const ENGAGE_EPS: f32 = 1e-3;

/// Radius the per-mask Sharpness slider drives `stages::sharpen` at — the
/// `AdjustmentModel` default, because Lightroom's local panel exposes a
/// single Sharpness amount with no radius/detail/masking of its own.
const LOCAL_SHARPEN_RADIUS: f32 = 1.0;
/// Detail, likewise the `AdjustmentModel` default.
const LOCAL_SHARPEN_DETAIL: f32 = 25.0;
/// Masking, likewise the `AdjustmentModel` default (no edge masking).
const LOCAL_SHARPEN_MASKING: f32 = 0.0;

/// `true` when this control is set to a value its stage would act on.
#[inline]
fn on(value: Option<f32>) -> bool {
    value.is_some_and(|v| v.abs() >= ENGAGE_EPS)
}

/// `true` when at least one of the six spatial controls would do something.
/// A layer for which this is `false` costs nothing beyond the check.
pub fn engaged(a: &PartialAdjustments) -> bool {
    on(a.texture)
        || on(a.clarity)
        || on(a.dehaze)
        || on(a.sharpness)
        || on(a.luminance_noise)
        || on(a.defringe)
}

/// `true` when some layer engages the per-mask dehaze control. The tile
/// path refuses such a render for the same reason it refuses the global
/// slider: dehaze's atmospheric light and dark channel are statistics of
/// the whole frame, which a padded crop cannot reproduce.
pub fn any_dehaze_engaged(layers: &[crate::types::LocalAdjustment]) -> bool {
    layers.iter().any(|l| on(l.adjustments.dehaze))
}

/// Combined stencil reach of this layer's engaged spatial controls, in
/// pixels per side, for the tile path's overlap calculator. The controls
/// cascade on one scratch buffer — each reads the previous one's output —
/// so their reaches ADD, matching how `pipeline::tile::overlap` sums the
/// global stages. Dehaze contributes nothing here because a layer that
/// engages it is rejected outright by `pipeline::tile::guards`.
pub fn stencil_reach_px(a: &PartialAdjustments) -> usize {
    let reach = |value: Option<f32>, px: usize| if on(value) { px } else { 0 };
    reach(a.texture, texture::TEXTURE_GUIDED_REACH_PX)
        + reach(a.clarity, clarity::CLARITY_GUIDED_REACH_PX)
        + reach(a.sharpness, sharpen::stencil_reach_px(LOCAL_SHARPEN_RADIUS))
        + reach(a.luminance_noise, noise_reduction::LUMA_REACH_PX)
        + reach(a.defringe, defringe::DEFRINGE_REACH_PX)
}

/// Apply this layer's spatial group to `img`, confined to the mask by
/// `weights` (one entry per pixel of `img`, in `[0, 1]` — the same buffer
/// the point pass just evaluated).
///
/// A no-op when the layer engages none of the six, so callers need not
/// pre-check.
pub(super) fn apply_group(img: &mut Image, a: &PartialAdjustments, weights: &[f32]) {
    if !engaged(a) {
        return;
    }
    debug_assert_eq!(
        weights.len(),
        img.pixels.len(),
        "mask weights must cover the buffer the spatial group runs on"
    );

    // Lightroom's local-panel order: Texture, Clarity, Dehaze, Sharpness,
    // Noise, Defringe. Each stage short-circuits on its own threshold, so
    // an unset control costs one branch.
    let mut scratch = img.clone();
    if let Some(v) = a.texture {
        texture::apply(&mut scratch, v);
    }
    if let Some(v) = a.clarity {
        clarity::apply(&mut scratch, v);
    }
    if let Some(v) = a.dehaze {
        dehaze::apply(&mut scratch, v);
    }
    if let Some(v) = a.sharpness {
        sharpen::apply(
            &mut scratch,
            v,
            LOCAL_SHARPEN_RADIUS,
            LOCAL_SHARPEN_DETAIL,
            LOCAL_SHARPEN_MASKING,
        );
    }
    if let Some(v) = a.luminance_noise {
        // No noise profile and no ISO: the per-mask control is an explicit
        // artistic amount, not the sensor-calibrated global path.
        noise_reduction::apply_luminance(&mut scratch, v, None, 0);
    }
    if let Some(v) = a.defringe {
        defringe::apply(&mut scratch, v);
    }

    blend(img, &scratch, weights);
}

/// `img = img + w · (filtered − img)`, per channel. Pixels the mask does
/// not reach (`w <= 0`) are left bit-identical rather than round-tripped
/// through a lerp that would return them unchanged only up to float noise.
fn blend(img: &mut Image, filtered: &Image, weights: &[f32]) {
    img.pixels
        .par_iter_mut()
        .zip(filtered.pixels.par_iter())
        .zip(weights.par_iter())
        .for_each(|((p, f), &w)| {
            if w <= 0.0 {
                return;
            }
            p[0] += w * (f[0] - p[0]);
            p[1] += w * (f[1] - p[1]);
            p[2] += w * (f[2] - p[2]);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ColorSpace;

    fn ramp(w: u32, h: u32) -> Image {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for y in 0..h as usize {
            for x in 0..w as usize {
                let v = 0.05 + 0.9 * ((x * 7 + y * 3) % 11) as f32 / 11.0;
                img.pixels[y * w as usize + x] = [v, v * 0.9, v * 1.1];
            }
        }
        img
    }

    #[test]
    fn an_unset_group_is_not_engaged() {
        assert!(!engaged(&PartialAdjustments::default()));
        assert!(!engaged(&PartialAdjustments {
            exposure: Some(1.0),
            hue: Some(20.0),
            ..Default::default()
        }));
    }

    #[test]
    fn a_control_pinned_at_zero_is_not_engaged() {
        assert!(!engaged(&PartialAdjustments {
            clarity: Some(0.0),
            ..Default::default()
        }));
    }

    #[test]
    fn every_control_engages_on_its_own() {
        for a in [
            PartialAdjustments {
                texture: Some(20.0),
                ..Default::default()
            },
            PartialAdjustments {
                clarity: Some(-20.0),
                ..Default::default()
            },
            PartialAdjustments {
                dehaze: Some(20.0),
                ..Default::default()
            },
            PartialAdjustments {
                sharpness: Some(20.0),
                ..Default::default()
            },
            PartialAdjustments {
                luminance_noise: Some(20.0),
                ..Default::default()
            },
            PartialAdjustments {
                defringe: Some(20.0),
                ..Default::default()
            },
        ] {
            assert!(engaged(&a));
        }
    }

    #[test]
    fn a_zero_weight_mask_leaves_the_buffer_bit_identical() {
        let before = ramp(24, 24);
        let mut img = before.clone();
        let a = PartialAdjustments {
            clarity: Some(60.0),
            texture: Some(40.0),
            sharpness: Some(50.0),
            ..Default::default()
        };
        let zero = vec![0.0f32; img.pixels.len()];
        apply_group(&mut img, &a, &zero);
        assert_eq!(img.pixels, before.pixels);
    }

    /// The defining property of the delta form: at full mask weight the
    /// per-mask control IS the global stage, so a local Clarity of +40 over
    /// a fully-opaque mask reproduces `stages::clarity::apply(_, 40.0)` to
    /// the bit.
    #[test]
    fn full_weight_reproduces_the_global_stage_exactly() {
        let base = ramp(24, 24);
        let mut global = base.clone();
        clarity::apply(&mut global, 40.0);

        let mut local = base.clone();
        apply_group(
            &mut local,
            &PartialAdjustments {
                clarity: Some(40.0),
                ..Default::default()
            },
            &vec![1.0; base.pixels.len()],
        );
        assert_eq!(local.pixels, global.pixels);
    }

    #[test]
    fn a_half_weight_mask_lands_between_the_input_and_the_global_stage() {
        let base = ramp(24, 24);
        let mut global = base.clone();
        clarity::apply(&mut global, 60.0);

        let mut local = base.clone();
        apply_group(
            &mut local,
            &PartialAdjustments {
                clarity: Some(60.0),
                ..Default::default()
            },
            &vec![0.5; base.pixels.len()],
        );
        for i in 0..base.pixels.len() {
            for c in 0..3 {
                let expected = base.pixels[i][c] + 0.5 * (global.pixels[i][c] - base.pixels[i][c]);
                assert!(
                    (local.pixels[i][c] - expected).abs() < 1e-6,
                    "pixel {i} channel {c}: {} vs {expected}",
                    local.pixels[i][c]
                );
            }
        }
    }

    #[test]
    fn an_unengaged_group_never_touches_the_buffer() {
        let before = ramp(8, 8);
        let mut img = before.clone();
        apply_group(
            &mut img,
            &PartialAdjustments {
                exposure: Some(1.0),
                ..Default::default()
            },
            &vec![1.0; before.pixels.len()],
        );
        assert_eq!(img.pixels, before.pixels);
    }

    #[test]
    fn stencil_reach_sums_only_the_engaged_controls() {
        assert_eq!(stencil_reach_px(&PartialAdjustments::default()), 0);
        assert_eq!(
            stencil_reach_px(&PartialAdjustments {
                clarity: Some(30.0),
                ..Default::default()
            }),
            clarity::CLARITY_GUIDED_REACH_PX
        );
        assert_eq!(
            stencil_reach_px(&PartialAdjustments {
                texture: Some(10.0),
                clarity: Some(30.0),
                sharpness: Some(50.0),
                luminance_noise: Some(20.0),
                defringe: Some(40.0),
                // Dehaze contributes nothing: the tile entry rejects it.
                dehaze: Some(50.0),
                ..Default::default()
            }),
            texture::TEXTURE_GUIDED_REACH_PX
                + clarity::CLARITY_GUIDED_REACH_PX
                + sharpen::stencil_reach_px(LOCAL_SHARPEN_RADIUS)
                + noise_reduction::LUMA_REACH_PX
                + defringe::DEFRINGE_REACH_PX
        );
    }

    #[test]
    fn dehaze_detection_reads_every_layer() {
        use crate::types::{LocalAdjustment, Point2};
        let quiet = LocalAdjustment::linear(
            Point2::new(0.0, 0.0),
            Point2::new(1.0, 0.0),
            PartialAdjustments {
                clarity: Some(30.0),
                ..Default::default()
            },
        );
        let hazy = LocalAdjustment::radial(
            Point2::new(0.5, 0.5),
            Point2::new(0.2, 0.2),
            PartialAdjustments {
                dehaze: Some(45.0),
                ..Default::default()
            },
        );
        assert!(!any_dehaze_engaged(&[quiet.clone()]));
        assert!(any_dehaze_engaged(&[quiet, hazy]));
    }
}
