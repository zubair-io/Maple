//! Scene-linear (no-view-tail) render entries — develop, pack to fp16/f32
//! RGBA, EXIF-orient, and hand off to a platform view transform (CoreImage /
//! WebGL2 / wgpu). Split out of `render/mod.rs` to keep it under the
//! file-size budget (#1170); re-exported there so `pipeline::{…}` keeps
//! resolving every entry. Behavior unchanged (pure code move).

use crate::cancel::CancelToken;
use crate::error::Result;
use crate::image::RawImage;
use crate::pipeline::develop::{
    develop_scene_linear_from_raw_with_quality,
    develop_scene_linear_from_raw_with_quality_cancellable,
    develop_scene_linear_from_raw_with_quality_cancellable_with_gain,
};
use crate::pipeline::develop_sized::{
    develop_scene_linear_sized_from_raw_with_quality,
    develop_scene_linear_sized_from_raw_with_quality_cancellable,
    develop_scene_linear_sized_from_raw_with_quality_cancellable_with_gain,
};
use crate::pipeline::fp16::f32_to_f16_bits;
use crate::pipeline::orient::apply_orientation_f32_rgba;
use crate::pipeline::{finite_or_zero, stage, RenderQuality};
use crate::xmp::AdjustmentModel;

/// Scene-linear render entry. Runs the same development chain as
/// `render_from_raw_with_quality` (via the shared
/// `develop_scene_linear_from_raw_with_quality` helper — Step 2.4a)
/// but stops after `nr_color` and packs to fp16 RGBA without the view
/// transform tail. Output is packed Rec.2020 fp16 RGBA (8 bytes/pixel),
/// straight alpha = 1.0, row-major. Returned `Vec<u16>` is the fp16 bit
/// pattern; the FFI hands the underlying bytes to the caller via
/// `bytemuck::cast_slice`.
///
/// Plan 1 (FFI split) — the Apple side imports this buffer as a CIImage
/// tagged extendedLinearITUR_2020 and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage. See
/// .archived-plans/plans/2026-04-24-ffi-split-plan-1.md.
pub fn render_scene_linear_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<u16>)> {
    let scene = develop_scene_linear_from_raw_with_quality(raw, model, quality)?;
    // STOP: no agx::apply, no rec2020_to_srgb, no quantize_u8.
    // Pack [f32;3] + alpha=1.0 to packed [f32;4] RGBA, then orient, then
    // convert to fp16 lanes for the FFI handoff.
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(finite_or_zero(p[0]));
            v.push(finite_or_zero(p[1]));
            v.push(finite_or_zero(p[2]));
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}

/// f32 variant of [`render_scene_linear_from_raw_with_quality`].
///
/// Same develop chain and orientation handling, but returns the oriented
/// Rec.2020 RGBA buffer as packed `f32` lanes (16 bytes per pixel) instead
/// of fp16. This is the canonical end-to-end shape per #416 — fp16 is
/// kept as a parallel surface until every consumer has migrated.
///
/// `Vec<f32>` length is `4 * width * height`, row-major, straight alpha
/// = 1.0 in every alpha lane. See #482 for the FFI surface that exposes
/// this to the Web consumer (Apple still consumes the fp16 entries today;
/// follow-up ticket tracks the per-tick chain migration that blocks the
/// Apple swap).
#[inline]
pub fn render_scene_linear_from_raw_with_quality_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
) -> Result<(u32, u32, Vec<f32>)> {
    render_scene_linear_from_raw_with_quality_f32_cancellable(
        raw,
        model,
        quality,
        CancelToken::never(),
    )
}

/// Cancellable variant of [`render_scene_linear_from_raw_with_quality_f32`].
///
/// Forwards `cancel` into the develop chain so a cold-open decode can unwind
/// mid-stage; returns `Err(Error::Cancelled)` when the host requests it. The
/// FFI entry `maple_render_file_scene_linear_f32` (and its bytes sibling)
/// routes through here with a host-owned flag. Never-cancel ⇒ bit-identical to
/// the wrapper above.
pub fn render_scene_linear_from_raw_with_quality_f32_cancellable(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<(u32, u32, Vec<f32>)> {
    let scene =
        develop_scene_linear_from_raw_with_quality_cancellable(raw, model, quality, cancel)?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(finite_or_zero(p[0]));
            v.push(finite_or_zero(p[1]));
            v.push(finite_or_zero(p[2]));
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    Ok((w, h, oriented_f32))
}

/// Same as [`render_scene_linear_from_raw_with_quality_f32_cancellable`],
/// additionally returning the scalar gain the develop chain's `auto_exposure`
/// stage applied (#1167). The FFI f32 entries (`maple_render_file_scene_linear_f32`
/// / `maple_render_bytes_scene_linear_f32`) route through here so the gain can
/// be carried on `MapleSceneLinearBufferF32` for the host to thread back into
/// a tile-develop call.
pub fn render_scene_linear_from_raw_with_quality_f32_cancellable_with_gain(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    cancel: CancelToken<'_>,
) -> Result<(u32, u32, Vec<f32>, f32)> {
    let (scene, ae_gain) = develop_scene_linear_from_raw_with_quality_cancellable_with_gain(
        raw, model, quality, cancel,
    )?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(finite_or_zero(p[0]));
            v.push(finite_or_zero(p[1]));
            v.push(finite_or_zero(p[2]));
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    Ok((w, h, oriented_f32, ae_gain))
}

/// Sized scene-linear render entry. Same shared development chain as
/// `render_scene_linear_from_raw_with_quality`, then downsample to fit
/// within `max_long_edge` (single scalar — see Plan 1 v2 Task 8 API
/// decision: long-edge simplifies WASM parity and aspect math is local
/// to the renderer; per ticket 06 § Open Questions). Never upscales.
///
/// Plan 1 v2 (FFI split + viewport-sized) — the Apple side imports this
/// buffer at the target dimensions and runs Lanczos prescale + AgX kernel
/// + sRGB encode in CoreImage.
pub fn render_scene_linear_sized_from_raw_with_quality(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<u16>)> {
    // M3: develop with the early-downsample helper. The downsample
    // happens immediately after demosaic so post-demosaic stages run
    // on the viewport-sized buffer. The post-pipeline
    // `downsample_image_area` call this function used to make is now
    // inside the helper.
    let scene =
        develop_scene_linear_sized_from_raw_with_quality(raw, model, quality, max_long_edge)?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(finite_or_zero(p[0]));
            v.push(finite_or_zero(p[1]));
            v.push(finite_or_zero(p[2]));
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    let fp16: Vec<u16> = stage("pack_fp16_sized", || {
        oriented_f32.iter().map(|&v| f32_to_f16_bits(v)).collect()
    });
    Ok((w, h, fp16))
}

/// f32 variant of [`render_scene_linear_sized_from_raw_with_quality`].
///
/// Same `max_long_edge` cap, no-upscale guarantee, and oriented output.
/// Returns the oriented buffer as packed `f32` lanes. See the f32 variant
/// of the full-size entry for the rationale (#482).
#[inline]
pub fn render_scene_linear_sized_from_raw_with_quality_f32(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
) -> Result<(u32, u32, Vec<f32>)> {
    render_scene_linear_sized_from_raw_with_quality_f32_cancellable(
        raw,
        model,
        quality,
        max_long_edge,
        CancelToken::never(),
    )
}

/// Cancellable variant of
/// [`render_scene_linear_sized_from_raw_with_quality_f32`]. The fast-phase
/// RAW open routes through here (via the sized FFI entry) with a host-owned
/// cancel flag, so this is the entry the editor actually interrupts on a
/// slider tick during a cold open (#951). Never-cancel ⇒ bit-identical.
pub fn render_scene_linear_sized_from_raw_with_quality_f32_cancellable(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<(u32, u32, Vec<f32>)> {
    let scene = develop_scene_linear_sized_from_raw_with_quality_cancellable(
        raw,
        model,
        quality,
        max_long_edge,
        cancel,
    )?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(finite_or_zero(p[0]));
            v.push(finite_or_zero(p[1]));
            v.push(finite_or_zero(p[2]));
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    Ok((w, h, oriented_f32))
}

/// Same as [`render_scene_linear_sized_from_raw_with_quality_f32_cancellable`],
/// additionally returning the scalar gain the develop chain's `auto_exposure`
/// stage applied (#1167). The sized FFI f32 entries
/// (`maple_render_file_scene_linear_sized_f32` /
/// `maple_render_bytes_scene_linear_sized_f32`) route through here — the
/// editor's fast-phase cold open uses the sized decode, so this is the entry
/// that must export the gain for the interactive (not just cold full-res)
/// path.
pub fn render_scene_linear_sized_from_raw_with_quality_f32_cancellable_with_gain(
    raw: &RawImage,
    model: &AdjustmentModel,
    quality: RenderQuality,
    max_long_edge: u32,
    cancel: CancelToken<'_>,
) -> Result<(u32, u32, Vec<f32>, f32)> {
    let (scene, ae_gain) = develop_scene_linear_sized_from_raw_with_quality_cancellable_with_gain(
        raw,
        model,
        quality,
        max_long_edge,
        cancel,
    )?;
    let (w0, h0) = (scene.width, scene.height);
    let rgba_f32 = stage("pack_rgba_f32_sized", || {
        let mut v = Vec::with_capacity(scene.pixels.len() * 4);
        for p in &scene.pixels {
            v.push(finite_or_zero(p[0]));
            v.push(finite_or_zero(p[1]));
            v.push(finite_or_zero(p[2]));
            v.push(1.0);
        }
        v
    });
    let (w, h, oriented_f32) = stage("apply_orientation_rgba_sized", || {
        apply_orientation_f32_rgba(&rgba_f32, w0, h0, raw.orientation)
    });
    Ok((w, h, oriented_f32, ae_gain))
}
