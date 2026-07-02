//! Patch-compositing wrappers for the scene-linear chain, split into a
//! sibling submodule for the file-size budget; re-exported from
//! `scene_linear_chain` so public paths are unchanged.

use super::composite::{composite_into_f32, composite_into_fp16};
use super::{apply_scene_linear_chain, apply_scene_linear_chain_f32};
use crate::{error::Result, view::encode::TargetPrimaries, xmp::AdjustmentModel};

/// fp16 per-tick chain with synthetic-raw `patches` composited at the
/// pre-user-grade seam (before `white_balance`), so the patch rides every
/// downstream stage — WB, exposure, tone, AgX — exactly like sensor data
/// (design doc §4). Empty `patches` is bit-identical to
/// [`apply_scene_linear_chain`].
#[allow(clippy::too_many_arguments)]
pub fn apply_scene_linear_chain_with_patches(
    in_fp16_rgba: &[u16],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    decoded_temp: f32,
    decoded_tint: f32,
    skip_agx: bool,
    target_primaries: TargetPrimaries,
    noise_profile: Option<&[f32]>,
    iso: u32,
    patches: &[crate::types::InpaintPatch],
) -> Result<Vec<u16>> {
    if patches.is_empty() {
        return apply_scene_linear_chain(
            in_fp16_rgba,
            width,
            height,
            model,
            decoded_temp,
            decoded_tint,
            skip_agx,
            target_primaries,
            noise_profile,
            iso,
        );
    }
    let composited = composite_into_fp16(in_fp16_rgba, width, height, patches)?;
    apply_scene_linear_chain(
        &composited,
        width,
        height,
        model,
        decoded_temp,
        decoded_tint,
        skip_agx,
        target_primaries,
        noise_profile,
        iso,
    )
}

/// f32 sibling of [`apply_scene_linear_chain_with_patches`].
#[allow(clippy::too_many_arguments)]
pub fn apply_scene_linear_chain_f32_with_patches(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    model: &AdjustmentModel,
    decoded_temp: f32,
    decoded_tint: f32,
    skip_agx: bool,
    target_primaries: TargetPrimaries,
    noise_profile: Option<&[f32]>,
    iso: u32,
    patches: &[crate::types::InpaintPatch],
) -> Result<Vec<f32>> {
    if patches.is_empty() {
        return apply_scene_linear_chain_f32(
            in_f32_rgba,
            width,
            height,
            model,
            decoded_temp,
            decoded_tint,
            skip_agx,
            target_primaries,
            noise_profile,
            iso,
        );
    }
    let composited = composite_into_f32(in_f32_rgba, width, height, patches)?;
    apply_scene_linear_chain_f32(
        &composited,
        width,
        height,
        model,
        decoded_temp,
        decoded_tint,
        skip_agx,
        target_primaries,
        noise_profile,
        iso,
    )
}
