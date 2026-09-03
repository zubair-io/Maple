//! Per-render overlap calculator for the tile path (#1157, tone-zoom design
//! § 5.3 — the exact-overlap half of the stage-class plan).
//!
//! Every stage the tile chain runs that gathers from neighbouring pixels
//! contributes its stencil reach here, and the pad the entry linearises
//! around the requested rect is the SUM of the reaches of the stages that
//! will actually run for this model — stages cascade (each reads the
//! previous one's output), so their reaches add rather than overlap. A
//! slider at zero contributes nothing; a slider whose reach scales with the
//! frame (the highlights/shadows detail mask, #2476) contributes its reach
//! at the tile's develop resolution.
//!
//! [`TILE_OVERLAP_PX`] stays as the floor: it already covers the default
//! model's stencils with headroom, so no existing render gets a smaller pad
//! than it had, and the calculator only ever GROWS the pad for the stages
//! that need more — capture sharpening (~96 px at the σ = 8 clamp) and the
//! S/H mask at deep zoom (hundreds of px on a 100 MP frame), both of which
//! were rejected at the entry before this existed.
//!
//! Each reach is the stage's own number, exported from the stage module so
//! this table cannot drift from the kernel it describes. What is NOT here:
//! dehaze (global statistics + a radius-60 guided filter — the proxy-plane
//! half of § 5.3, tracked separately), BM3D deep denoise (frame-anchored
//! patch grid, #1105), and OpcodeList3 (#1932); those stay rejected by
//! `guards.rs`.

use super::TILE_OVERLAP_PX;
use crate::pipeline::capture_sharpening_helper::capture_sharpening_params_from_model;
use crate::stages::{
    capture_sharpening, clarity, noise_reduction, scene_tone_controls, sharpen, texture,
};
use crate::xmp::AdjustmentModel;

/// Reach of the stages that run before the chain is in scene-linear space
/// and whose stencils are fixed: demosaic (2 px), hot-pixel suppression
/// (radius 2 on Bayer), and the chroma prefilter (±4 px). Counted in
/// developed pixels even though the first two run on the mosaic — for a
/// half-res develop that over-pads by a few pixels, which is the safe
/// direction.
const PRE_SCENE_REACH_PX: usize = 2 + 2 + 4;

/// The pad, in MOSAIC pixels per edge, for one tile render of `model`.
///
/// `mask_long_edge` is the full frame's long edge at the develop resolution
/// (the S/H mask anchor, #2476) and `divisor` the demosaic divisor (2 for a
/// half-res `Preview`, else 1): every reach below is measured in developed
/// pixels and converted back to mosaic pixels through it.
pub(super) fn tile_overlap_px(model: &AdjustmentModel, mask_long_edge: usize, divisor: u32) -> u32 {
    let sum: usize = PRE_SCENE_REACH_PX
        + capture_sharpening_params_from_model(model)
            .map(|p| capture_sharpening::stencil_reach_px(&p))
            .unwrap_or(0)
        + scene_tone_controls::sh_mask_reach_px(mask_long_edge, model)
        + engaged(model.clarity, clarity::CLARITY_GUIDED_REACH_PX)
        + engaged(model.texture, texture::TEXTURE_GUIDED_REACH_PX)
        + engaged(
            model.sharpen_amount,
            sharpen::stencil_reach_px(model.sharpen_radius),
        )
        + engaged(model.nr_luminance, noise_reduction::LUMA_REACH_PX)
        + engaged(model.nr_color, noise_reduction::CHROMA_REACH_PX);
    let mosaic_px = (sum as u32).saturating_mul(divisor);
    TILE_OVERLAP_PX.max(mosaic_px)
}

/// A stage's reach counts only when its slider engages it — the same
/// `|amount| < 1e-3` early-exit every one of these stages uses.
fn engaged(amount: f32, reach: usize) -> usize {
    if amount.abs() < 1e-3 {
        0
    } else {
        reach
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_stays_on_the_fixed_pad() {
        // sharpen 40 @ σ 1 (reach 3 + 1) + nr_color 25 (5) + pre-scene 8 = 17 < 48.
        assert_eq!(
            tile_overlap_px(&AdjustmentModel::default(), 6000, 1),
            TILE_OVERLAP_PX
        );
    }

    #[test]
    fn sliders_at_zero_contribute_nothing_and_engaged_reaches_add() {
        let quiet = AdjustmentModel {
            sharpen_amount: 0.0,
            nr_color: 0.0,
            ..AdjustmentModel::default()
        };
        assert_eq!(tile_overlap_px(&quiet, 6000, 1), TILE_OVERLAP_PX);

        // Capture sharpening at the σ clamp: 2 iterations × 2 blurs × ⌈3σ⌉ = 96,
        // plus pre-scene 8 → 104 > 48.
        let capture = AdjustmentModel {
            capture_sharpening_amount: 50.0,
            capture_sharpening_sigma: 8.0,
            ..quiet.clone()
        };
        assert_eq!(tile_overlap_px(&capture, 6000, 1), 104);

        // Every spatial slider engaged on a 6000-px frame at 100%: pre 8 +
        // capture 96 + S/H (2 × 135) + clarity 40 + texture 4 + sharpen (⌈3·3⌉
        // + 1) + nr luma 4 + nr chroma 5.
        let everything = AdjustmentModel {
            highlights: -30.0,
            shadows: 30.0,
            clarity: 20.0,
            texture: 20.0,
            sharpen_amount: 40.0,
            sharpen_radius: 3.0,
            nr_luminance: 20.0,
            nr_color: 25.0,
            ..capture.clone()
        };
        assert_eq!(
            tile_overlap_px(&everything, 6000, 1),
            8 + 96 + 2 * 135 + 40 + 4 + 10 + 4 + 5
        );
        // A half-res develop measures the same reaches in developed pixels,
        // so the mosaic pad doubles.
        assert_eq!(
            tile_overlap_px(&everything, 3000, 2),
            2 * (8 + 96 + 2 * 68 + 40 + 4 + 10 + 4 + 5)
        );
    }
}
